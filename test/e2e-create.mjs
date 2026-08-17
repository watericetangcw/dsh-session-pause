// E2E regression for the install bug: against an isolated web instance
// (dsh web --profile pausetest --port 3199) drive the exact RPCs the New
// Session page sends — workspace.create, then session.create with
// workspaceId + agentPreset (the reported failing path) and with cwd +
// agentPreset. Before the packaging fix the fork's profile-local copy of
// dsh-scope made presets.mount throw "refusing to compose an unscoped
// context" on every session.create.
//
// Usage: node test/e2e-create.mjs
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const BASE = "http://127.0.0.1:3199";
let seq = 0;
const rpc = async (method, payload) => {
	const rpcId = `e2e-${++seq}`;
	const res = await fetch(`${BASE}/api/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ type: "client-request", rpcId, method, payload })
	});
	const full = await res.json();
	if (full.rpcId !== rpcId) throw new Error(`rpcId mismatch for ${method}`);
	return full.result;
};

let failures = 0;
function check(label, cond, detail) {
	if (cond) {
		console.log(`  ok  ${label}`);
		return;
	}
	failures += 1;
	console.error(`FAIL  ${label} — ${detail}`);
}

const suffix = Date.now();
// The UI's "new workspace" flow materializes the directory first (directory
// picker / native create), then adopts it; workspace.create requires it to
// exist. Keep it inside the repo so the local test run stays sandbox-safe.
const wsPath = join(dirname(fileURLToPath(import.meta.url)), "..", `.e2e-ws-${suffix}`);
mkdirSync(wsPath, { recursive: true });

// 1. Adopt a brand-new workspace directory (the UI's "new workspace" flow).
const createdWs = await rpc("workspace.create", { path: wsPath });
check("workspace.create returns ok", createdWs.ok === true, JSON.stringify(createdWs));
const workspaceId = createdWs.value?.workspace?.workspaceId;
check("workspace.create returns a workspaceId", typeof workspaceId === "string", JSON.stringify(createdWs));

// 2. THE reported failure: create a session inside the new workspace under a preset.
const inWorkspace = await rpc("session.create", {
	workspaceId,
	sessionId: `e2e-ws-${suffix}`,
	agentPreset: "standard"
});
check("session.create in a NEW workspace with agentPreset succeeds", inWorkspace.ok === true, JSON.stringify(inWorkspace));
check("session.create echoes the composed preset", inWorkspace.value?.agentPreset === "standard", JSON.stringify(inWorkspace));

// 3. Non-workspace path with an explicit preset.
const withCwd = await rpc("session.create", {
	cwd: wsPath,
	sessionId: `e2e-cwd-${suffix}`,
	agentPreset: "standard"
});
check("session.create with cwd + agentPreset succeeds", withCwd.ok === true, JSON.stringify(withCwd));

// 4. The new workspace now lists its session.
const listed = await rpc("workspace.list", {});
check("workspace.list includes the new workspace session", listed.value?.items?.some((w) => w.workspaceId === workspaceId && w.sessionIds.includes(`e2e-ws-${suffix}`)) === true, JSON.stringify(listed));

console.log(failures === 0 ? "\nE2E CREATE OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
