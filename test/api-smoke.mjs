// Real-model API smoke test against the isolated test instance (port 3199):
// session.create + session.prompt through the fork composition, then history.
// Usage: node test/api-smoke.mjs
const BASE = "http://127.0.0.1:3199";
let seq = 0;
const rpc = async (method, payload) => {
	const rpcId = `smoke-${++seq}`;
	const res = await fetch(`${BASE}/api/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ type: "client-request", rpcId, method, payload })
	});
	const full = await res.json();
	if (full.rpcId !== rpcId) throw new Error(`rpcId mismatch for ${method}`);
	return full.result;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sessionId = `smoke-${Date.now()}`;
const created = await rpc("session.create", { cwd: process.cwd(), sessionId });
console.log("session.create:", JSON.stringify(created));
if (!created.ok) process.exit(1);

const prompted = await rpc("session.prompt", {
	sessionId,
	mode: "queue",
	content: [{ type: "text", text: "Reply with exactly one word: PONG" }]
});
console.log("session.prompt:", JSON.stringify(prompted));
if (!prompted.ok) process.exit(1);

// Poll history until an assistant message appears (or timeout).
let assistant;
for (let i = 0; i < 120; i++) {
	await sleep(1500);
	const history = await rpc("session.history", { sessionId });
	if (!history.ok) throw new Error(`history failed: ${JSON.stringify(history.error)}`);
	const events = history.value.events;
	assistant = events.find((e) => e.event?.type === "assistant/message" || e.type === "assistant/message");
	const turnEnd = events.find((e) => e.event?.type === "turn/end" || e.type === "turn/end");
	if (assistant && turnEnd) break;
	if (i === 60) console.log("...still waiting for the model");
}
if (!assistant) {
	console.log("NO ASSISTANT MESSAGE — model call did not complete");
	process.exit(1);
}
const message = assistant.event?.data?.message ?? assistant.data?.message;
const text = message?.content?.filter((b) => b.type === "text").map((b) => b.text).join(" ");
console.log("assistant answer:", JSON.stringify(text));
if (/pong/i.test(text ?? "")) {
	console.log("SMOKE OK — real model answered through the fork composition");
	process.exit(0);
}
console.log("SMOKE UNEXPECTED ANSWER");
process.exit(1);
