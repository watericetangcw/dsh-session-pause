// dsh-session-pause packaging-contract test. Guards the root cause of the
// "agent-presets: refusing to compose an unscoped context" install bug:
//
//   `dsh plugin add` forwards to `pnpm add` inside the profile. If this
//   bundle declares any @deepseek-ai package as a runtime dependency, pnpm
//   materializes a SECOND copy of it in the profile tree. The forked agent
//   loop then writes the scope tag with that copy's private Symbol while the
//   installation's dsh-agent-presets reads it with its own — cross-instance
//   scopeOf() returns undefined and every session.create fails. Runtime
//   imports must instead resolve through Node's parent-directory walk to the
//   installation's flat fallback ($DSH_HOME/profiles/node_modules), i.e. the
//   exact module instances the rest of DSH uses.
//
// Static half: package.json must not declare installable @deepseek-ai
// runtime deps, and every non-builtin import in lib/*.js must be covered by
// devDependencies (the documented closure) or the client module table.
// Runtime half: an agent created by the fork must carry a scope key that the
// deployment's own scopeOf() can read — the exact probe of the bug.
//
// Run:  node test/dependency-contract.mjs   (from the package root)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
// 0.2.1-rc.5: AgentLoop additionally injects `sessionProjections` (it
// registers its own turnBoundary + inbox units against that registry).
// Without this plugin the AgentLoop fiber stays at state 0 forever.
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { AgentLoop } from "../lib/agent-loop.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function assert(cond, label) {
	if (cond) {
		console.log(`  ok  ${label}`);
		return;
	}
	failures += 1;
	console.error(`FAIL  ${label}`);
}

// ── static: the published manifest must not install DSH runtime packages ──
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const runtimeDeps = Object.keys(manifest.dependencies ?? {});
assert(runtimeDeps.length === 0, `package.json has no runtime dependencies (found: ${runtimeDeps.join(", ") || "none"})`);
assert(
	!runtimeDeps.some((name) => name.startsWith("@deepseek-ai/")),
	"no @deepseek-ai/* package is installable as a runtime dependency"
);

// ── static: every lib import is documented in devDependencies ──
const devDeps = new Set(Object.keys(manifest.devDependencies ?? {}));
const clientModuleTable = new Set(["react", "react/jsx-runtime"]);
const nodeBuiltins = new Set(["node:fs", "node:crypto", "node:path", "node:url", "node:os", "node:util", "node:events", "node:stream", "node:zlib", "node:timers", "node:module", "node:child_process", "node:process", "node:buffer", "node:worker_threads"]);
const specifiers = [];
for (const file of ["lib/agent-loop.js", "lib/index.js", "lib/client.js"]) {
	const source = readFileSync(join(ROOT, file), "utf8");
	for (const pattern of [/\bfrom\s*["']([^"']+)["']/g, /^import\s*["']([^"']+)["']/gm, /\bimport\s*\(\s*["']([^"']+)["']/g, /\brequire\s*\(\s*["']([^"']+)["']/g]) {
		for (const match of source.matchAll(pattern)) specifiers.push({
			file,
			specifier: match[1]
		});
	}
}
let unresolved = [];
for (const { file, specifier } of specifiers) {
	if (specifier.startsWith(".") || specifier.startsWith("cordis:") || nodeBuiltins.has(specifier)) continue;
	if (!devDeps.has(specifier) && !clientModuleTable.has(specifier)) unresolved.push(`${file}: ${specifier}`);
}
assert(unresolved.length === 0, `every import is covered by devDependencies or the client module table${unresolved.length ? ` — UNRESOLVED: ${unresolved.join(", ")}` : ""}`);

// ── runtime: the fork tags the agent scope with the shared dsh-scope ──
async function runtimeProbe() {
	const root = new Context();
	const fibers = [];
	for (const plugin of [SessionStore, AgentRegistry, LlmRuntime, SystemPrompt, ToolRuntime, SessionProjectionRegistry]) fibers.push(root.plugin(plugin));
	fibers.push(root.plugin(AgentLoop, { agents: [] }));
	for (;;) {
		if (fibers.every((fiber) => fiber.state === 2)) break;
		if (fibers.some((fiber) => fiber.state >= 4)) throw new Error(`composition failed: fiber state ${fibers.map((fiber) => fiber.state).join(",")}`);
		await sleep(5);
	}
	// 0.2.1-rc.5 made AgentLoop.create() async (it publishes through
	// setupAndPublish), so the probe must await it before reading agent.ctx.
	const agent = await root.agentLoop.create("contract-probe", {
		provider: "contract",
		model: "probe-1"
	}, { cwd: process.cwd() });
	assert(scopeOf(agent.ctx) === agent, "the deployment's scopeOf reads the fork-created agent scope key (no dual module instance)");
	// 0.2.1-rc.5 no longer exposes `ctx.agent` as a plain property (reading it
	// throws "cannot get property \"agent\" without inject"). The supported way
	// to resolve the owning agent from an agent-scoped context is the registry.
	assert(typeof agent.ctx.agents?.requireInitiator === "function", "the agent ctx reaches the agent registry (requireInitiator path)");
	await Promise.allSettled(fibers.map((fiber) => fiber.dispose()));
}

await runtimeProbe();
console.log(failures === 0 ? "\nCONTRACT OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
