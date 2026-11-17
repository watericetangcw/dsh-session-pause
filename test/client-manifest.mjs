// dsh-session-pause client-manifest contract test.
//
// Guards two failure modes that are SILENT at runtime — neither throws, neither
// logs, the plugin just quietly does nothing:
//
//   1. A client module without `exports.inject`. `ClientEntries.start` activates
//      every entry with Promise.all (dsh-client-modules/lib/client.js:391-395),
//      so an undeclared dependency races the service it needs. The plugin's
//      `apply` opens with `const slots = ctx.get("slots"); if (slots === void 0)
//      return;` — landing on the wrong side of that race registers no slot at
//      all: no button, no error. Declaring `inject` makes Cordis' Fiber wait
//      (cordis/lib/index.js:1635 -> Inject.resolve(plugin.inject)).
//
//   2. `dsh.client.inject` naming packages that the deployment does not have.
//      Those ids are skipped silently (dsh-client-modules/lib/client.js:789-792)
//      because this field means "package-to-package graph edges", NOT Cordis
//      service injection (dsh-package-manifest types.d.ts:79). A wrong name is
//      therefore invisible except as dead weight in HMR reachability pruning.
//
// This test is static: it does not boot a browser. It reads the bundle's own
// source and manifest, plus an optional DSH installation to resolve package
// names against.
//
// Run:  node test/client-manifest.mjs [--dsh-root <path-to-@deepseek-ai/dsh>]
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function assert(cond, label, detail) {
	if (cond) {
		console.log(`  ok  ${label}`);
		return;
	}
	failures += 1;
	console.error(`FAIL  ${label}`);
	if (detail !== undefined) console.error(`      ${detail}`);
}

const client = readFileSync(join(ROOT, "lib/client.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// ── 1. the client module must declare its Cordis service dependencies ──────
// Both spellings are in use upstream; accept either, require at least one.
const declaresInject = /\bmodule\.exports\.inject\b|\bexports\.inject\b/.test(client);
assert(
	declaresInject,
	"lib/client.js exports an `inject` list (required — without it activation races `ctx.get(\"slots\")`)",
	"add: module.exports.inject = [\"slots\", \"sessions\", \"locale\"];"
);

// The services actually pulled with ctx.get() must be covered by that list,
// otherwise the plugin depends on them without telling the loader to wait.
const grabbed = new Set();
for (const match of client.matchAll(/ctx\.get\(\s*"([^"]+)"\s*\)/g)) grabbed.add(match[1]);
const injectList = (() => {
	const m = /(?:module\.)?exports\.inject\s*=\s*\[([^\]]*)\]/.exec(client);
	if (m === null) return null;
	return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
})();
if (injectList !== null) {
	const missing = [...grabbed].filter((name) => !injectList.includes(name));
	// `locale` is read optionally behind an `if (locale !== void 0)` guard, so
	// its absence from inject is acceptable; everything else must be declared.
	const required = missing.filter((name) => name !== "locale");
	assert(
		required.length === 0,
		`every mandatory ctx.get() service is declared in inject${required.length ? ` — MISSING: ${required.join(", ")}` : ""}`
	);
}

// ── 2. dsh.client.inject must name real packages ──────────────────────────
const declared = manifest.dsh?.client?.inject ?? [];
assert(Array.isArray(declared), "dsh.client.inject is an array");

// Names that are known NOT to be injectable package rows: they are shell seed
// words supplied by the web frontend, not standalone packages on disk.
const SEED_WORDS = new Set(["@deepseek-ai/dsh-client-ui-slots"]);
const seedHits = declared.filter((name) => SEED_WORDS.has(name));
assert(
	seedHits.length === 0,
	`dsh.client.inject lists no shell seed word${seedHits.length ? ` — FOUND: ${seedHits.join(", ")}` : ""}`,
	"seed words are provided by the web frontend, not by a package row; drop them"
);

// Resolve each declared name against a DSH installation when one is provided.
const rootArg = process.argv.indexOf("--dsh-root");
const dshRoot = rootArg !== -1
	? process.argv[rootArg + 1]
	: process.env.DSH_ROOT ?? "/Volumes/DL909-TiPlus7100/.cache/npm/global/lib/node_modules/@deepseek-ai/dsh";
const modulesDir = join(dshRoot, "node_modules", "@deepseek-ai");
if (existsSync(modulesDir)) {
	for (const name of declared) {
		if (SEED_WORDS.has(name)) continue;
		const short = name.replace("@deepseek-ai/", "");
		const present = existsSync(join(modulesDir, short));
		assert(present, `dsh.client.inject entry ${name} resolves in the deployment`, "remove or correct it; unknown ids are skipped silently");
	}
} else {
	console.log(`  --  skipped package resolution (no installation at ${dshRoot})`);
}

// ── 3. the module id must match the package name (style ownership) ────────
const moduleId = /load\(\s*\{\s*id:\s*"([^"]+)"/.exec(client)?.[1];
assert(
	moduleId === manifest.name,
	`client module id "${moduleId}" equals the package name (runtime <style> ownership compares against it)`
);

console.log(failures === 0 ? "\nCLIENT CONTRACT OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
