// dsh-session-pause functional test: drives the forked agent loop with real
// DSH services (sessions/agents/llm/tools/system-prompt) plus a scripted
// adapter and a slow tool. Validates the core pause/resume semantics:
//   A. pause during a running tool call → graceful drain → turn ends "paused",
//      resume continues with the durable tool-result tail.
//   B. pause during the in-flight model stream (which ends in a tool call) →
//      the stream completes first, then the tool drains, then the turn pauses.
//   C. "restart": restoring a session whose last turn ended paused yields a
//      paused agent; resume() continues from the durable log.
//   D. pause during a plain text answer → the turn completes naturally and the
//      pause resolves { paused: false } (nothing to resume).
//
// Run:  node test/pause-loop.mjs   (from the package root)
import { Context } from "@deepseek-ai/cordis";
import { SessionStore, SessionPreparation } from "@deepseek-ai/dsh-session";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { LlmRuntime, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime, defineTool } from "@deepseek-ai/dsh-tools";
import { CommandRuntime } from "@deepseek-ai/dsh-commands";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { AgentLoop } from "../lib/agent-loop.js";
import { apply as sessionPauseApply } from "../lib/index.js";

const CWD = process.cwd();
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

/** Scripted adapter: the per-call script map scripts call N (default: "done"). */
function scriptedAdapter(state) {
	return {
		providerInfo(provider) {
			return { id: provider, name: "scripted" };
		},
		listModels(provider) {
			return [{ provider, id: "scripted-1", name: "Scripted model" }];
		},
		async resolveModel(provider, model) {
			return { provider, id: model, name: "Scripted model" };
		},
		providerRetryPolicy() {
			return void 0;
		},
		stream(options) {
			const call = state.requests.length + 1;
			state.requests.push(structuredClone(options));
			const script = state.script[call] ?? textScript("done");
			return script();
		}
	};
}

function toolCallScript(argument) {
	return async function* () {
		yield { type: "block-start", index: 0, blockType: "tool-call" };
		yield { type: "tool-call-delta", index: 0, id: "call-1", name: "slow_tool", argumentsDelta: JSON.stringify(argument) };
		yield { type: "block-end", index: 0, block: { type: "tool-call", id: "call-1", name: "slow_tool", arguments: JSON.stringify(argument) } };
		yield { type: "finish", reason: { kind: "stop" } };
	};
}
/** A tool call whose argument deltas arrive slowly (mid-stream pause window). */
function slowToolCallScript(argument, pieceDelayMs) {
	const raw = JSON.stringify(argument);
	const half = Math.floor(raw.length / 2);
	return async function* () {
		yield { type: "block-start", index: 0, blockType: "tool-call" };
		yield { type: "tool-call-delta", index: 0, id: "call-1", name: "slow_tool", argumentsDelta: raw.slice(0, half) };
		await sleep(pieceDelayMs);
		yield { type: "tool-call-delta", index: 0, id: "call-1", argumentsDelta: raw.slice(half) };
		await sleep(pieceDelayMs);
		yield { type: "block-end", index: 0, block: { type: "tool-call", id: "call-1", name: "slow_tool", arguments: raw } };
		yield { type: "finish", reason: { kind: "stop" } };
	};
}
function textScript(text) {
	return async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "text", text } };
		yield { type: "finish", reason: { kind: "stop" } };
	};
}
function slowTextScript(pieces, pieceDelayMs) {
	return async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		for (const piece of pieces) {
			await sleep(pieceDelayMs);
			yield { type: "text-delta", index: 0, text: piece };
		}
		yield { type: "block-end", index: 0, block: { type: "text", text: pieces.join("") } };
		yield { type: "finish", reason: { kind: "stop" } };
	};
}

/** Build one isolated composition with the fork as the agent factory. */
async function composeRoot(script, toolStarted) {
	const root = new Context();
	const fibers = [];
	for (const plugin of [SessionStore, AgentRegistry, LlmRuntime, SystemPrompt, ToolRuntime]) fibers.push(root.plugin(plugin));
	fibers.push(root.plugin(AgentLoop, { agents: [] }));
	// cordis v4 mounts plugin fibers asynchronously; wait for all of them.
	for (;;) {
		if (fibers.every((fiber) => fiber.state === 2)) break;
		if (fibers.some((fiber) => fiber.state >= 4)) throw new Error(`composition failed: fiber state ${fibers.map((fiber) => fiber.state).join(",")}`);
		await sleep(5);
	}
	const state = { requests: [], script };
	root.llm.registerAdapter(["scripted"], scriptedAdapter(state));
	root.tools.register(defineTool({
		name: "slow_tool",
		description: "A slow tool used by the pause tests",
		parameters: {
			delayMs: {
				type: "number",
				required: true,
				description: "How long the tool body sleeps before returning."
			}
		},
		output: {
			schema: { type: "string" },
			render(_args, value) {
				return [{ type: "text", text: value }];
			}
		},
		async execute(args) {
			toolStarted?.resolve();
			await sleep(args.delayMs ?? 100);
			return "tool-done";
		}
	}));
	return { root, state, fibers };
}

async function teardown(composition) {
	await Promise.allSettled(composition.fibers.map((fiber) => fiber.dispose()));
}

function lastTurnEnd(session) {
	return session.events.findLast((event) => event.type === "turn/end")?.data;
}

async function scenarioA() {
	console.log("\n[A] pause during a running tool call");
	const toolStarted = Promise.withResolvers();
	const composition = await composeRoot({ 1: toolCallScript({ delayMs: 600 }) }, toolStarted);
	const { root, state } = composition;
	const agent = root.agentLoop.create("pause-test-a", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	agent.followup(createUserMessage({ content: [{ type: "text", text: "start" }], source: { kind: "user" } }));
	await toolStarted.promise; // the slow tool is now running
	const pausePromise = agent.pause();
	assert(agent.status === "running", "agent still running while the pause drains");
	const outcome = await pausePromise;
	assert(outcome.paused === true, "pause settles {paused:true} after the tool drain");
	assert(agent.status === "paused", "agent status is paused");
	assert(lastTurnEnd(agent.session)?.reason?.kind === "paused", 'durable turn/end reason is "paused"');
	assert(agent.session.events.some((e) => e.type === "tool/result"), "tool result committed before pause");
	assert(state.requests.length === 1, "no follow-up model call during pause");
	agent.resume();
	await agent.whenIdle();
	assert(agent.status === "idle", "agent idle after resume completes");
	assert(state.requests.length === 2, "resume produced exactly one more model call");
	const resumedMessages = state.requests[1].messages;
	assert(resumedMessages.some((m) => m.content?.some((b) => b.type === "tool-result")), "resumed request carries the tool result");
	assert(lastTurnEnd(agent.session)?.reason?.kind === "completed", "resumed turn completes normally");
	await teardown(composition);
}

async function scenarioB() {
	console.log("\n[B] pause during the in-flight model stream (tool-call tail)");
	const toolStarted = Promise.withResolvers();
	const composition = await composeRoot({ 1: slowToolCallScript({ delayMs: 400 }, 150) }, toolStarted);
	const { root, state } = composition;
	const agent = root.agentLoop.create("pause-test-b", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	agent.followup(createUserMessage({ content: [{ type: "text", text: "stream" }], source: { kind: "user" } }));
	await sleep(180); // the argument stream is in flight
	const outcome = await agent.pause();
	assert(outcome.paused === true, "pause waits for the stream and the tool to finish");
	assert(agent.status === "paused", "agent paused after the drain");
	assert(lastTurnEnd(agent.session)?.reason?.kind === "paused", 'turn/end reason "paused"');
	const callEvent = agent.session.events.find((e) => e.type === "tool/call");
	assert(callEvent?.data?.arguments === JSON.stringify({ delayMs: 400 }), "the in-flight tool call was not truncated by the pause");
	assert(agent.session.events.some((e) => e.type === "tool/result"), "the drained tool committed its result");
	assert(state.requests.length === 1, "no model call escaped the pause boundary");
	agent.resume();
	await agent.whenIdle();
	assert(state.requests.length === 2, "resume runs the continuation request");
	await teardown(composition);
}

async function scenarioC() {
	console.log("\n[C] restart: restore a paused session and resume it");
	const toolStarted = Promise.withResolvers();
	const first = await composeRoot({ 1: toolCallScript({ delayMs: 200 }) }, toolStarted);
	const firstAgent = first.root.agentLoop.create("pause-test-c", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	firstAgent.followup(createUserMessage({ content: [{ type: "text", text: "start" }], source: { kind: "user" } }));
	await toolStarted.promise;
	const outcome = await firstAgent.pause();
	assert(outcome.paused === true, "pre-restart pause completed");
	const seedEvents = structuredClone(firstAgent.session.events);
	const seedHeader = structuredClone(firstAgent.session.header);
	await teardown(first); // simulates the process going away

	// A fresh process composition resumes the same durable session.
	const second = await composeRoot({ 1: textScript("restart-continuation") }, Promise.withResolvers());
	const persistence = {
		async prepare(id, _signal) {
			return SessionPreparation.create(second.root.sessions.prepare(id, {
				seedSource: "persistence",
				seed: seedEvents,
				meta: seedHeader
			}));
		}
	};
	const published = await second.root.agentLoop.resumeWith(second.root, persistence, {
		resumeSessionId: "pause-test-c",
		agentOptions: { provider: "scripted", model: "scripted-1" }
	});
	const restored = published.agent;
	assert(restored.status === "paused", "restored agent detects the paused tail and stays paused");
	assert(second.state.requests.length === 0, "restore does not auto-run any model call");
	restored.resume();
	await restored.whenIdle();
	assert(restored.status === "idle", "restored agent resumes to idle");
	assert(second.state.requests.length === 1, "resume ran exactly one continuation call");
	const resumedMessages = second.state.requests[0].messages;
	assert(resumedMessages.some((m) => m.content?.some((b) => b.type === "tool-result")), "restarted continuation carries the durable tool result");
	assert(lastTurnEnd(restored.session)?.reason?.kind === "completed", "restarted continuation turn completes");
	await teardown(second);
}

/** Whether a promise is still unsettled after `waitMs` (a "never gives up" probe). */
async function stillPending(promise, waitMs = 250) {
	let settled = false;
	void promise.then(() => {
		settled = true;
	}, () => {
		settled = true;
	});
	await sleep(waitMs);
	return !settled;
}

async function scenarioD() {
	console.log("\n[D] pause during a plain text answer (latch waits, never gives up)");
	const toolStarted = Promise.withResolvers();
	const composition = await composeRoot({
		1: slowTextScript(["one-", "two-"], 120),
		2: toolCallScript({ delayMs: 100 })
	}, toolStarted);
	const { root } = composition;
	const agent = root.agentLoop.create("pause-test-d", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	agent.followup(createUserMessage({ content: [{ type: "text", text: "plain" }], source: { kind: "user" } }));
	await sleep(150); // mid-stream
	const pausePromise = agent.pause();
	await agent.whenIdle();
	assert(agent.status === "idle", "agent idle after the natural completion");
	assert(lastTurnEnd(agent.session)?.reason?.kind === "completed", "turn ended completed");
	assert(await stillPending(pausePromise), "the pause promise stays pending after the natural end (no give-up)");
	const assistant = agent.session.events.findLast((e) => e.type === "assistant/message")?.data?.message;
	assert(assistant?.content?.[0]?.text === "one-two-", "the in-flight stream was allowed to finish");
	// The next run pauses at its first step boundary.
	agent.followup(createUserMessage({ content: [{ type: "text", text: "again" }], source: { kind: "user" } }));
	await toolStarted.promise;
	const outcome = await pausePromise;
	assert(outcome.paused === true, "the armed latch pauses the next run at its boundary");
	assert(agent.status === "paused", "agent paused");
	assert(agent.session.events.filter((e) => e.type === "tool/result").length === 1, "the second run's step completed before the pause");
	agent.resume();
	await agent.whenIdle();
	assert(agent.status === "idle", "agent idle after resume");
	await teardown(composition);
}

async function waitForStatus(agent, wanted, timeoutMs = 10000) {
	const start = Date.now();
	for (;;) {
		if (agent.status === wanted) return true;
		if (Date.now() - start > timeoutMs) return false;
		await sleep(10);
	}
}

async function scenarioE() {
	console.log("\n[E] plugin glue: /pause, /resume commands and the pause projection");
	const toolStarted = Promise.withResolvers();
	const composition = await composeRoot({ 1: toolCallScript({ delayMs: 500 }) }, toolStarted);
	const { root } = composition;
	const extra = [root.plugin(CommandRuntime), root.plugin(SessionProjectionRegistry), root.plugin({ apply: sessionPauseApply })];
	for (;;) {
		if (extra.every((fiber) => fiber.state === 2)) break;
		if (extra.some((fiber) => fiber.state >= 4)) throw new Error(`glue composition failed: fiber state ${extra.map((fiber) => fiber.state).join(",")}`);
		await sleep(5);
	}
	const agent = root.agentLoop.create("pause-test-e", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	const signal = new AbortController().signal;
	// The plugin's inject-based registrations settle asynchronously after its
	// fiber is ready; wait until the command resolves.
	for (;;) {
		const probe = await root.commands.execute(agent, "/resume", signal);
		if (probe !== void 0) break;
		await sleep(5);
	}
	agent.followup(createUserMessage({ content: [{ type: "text", text: "start" }], source: { kind: "user" } }));
	await toolStarted.promise; // tool is running
	const pauseRun = await root.commands.execute(agent, "/pause", signal);
	assert(pauseRun?.result?.kind === "success", "the /pause command executes successfully");
	assert(await waitForStatus(agent, "paused"), "the agent reaches paused after /pause");
	assert(root.sessionProjections.snapshot(agent.session).values.pause?.paused === true, 'the pause projection reports {paused:true}');
	const pausedPause = await root.commands.execute(agent, "/pause", signal);
	assert(pausedPause?.result?.kind === "error", "/pause while already paused reports an error");
	const resumeRun = await root.commands.execute(agent, "/resume", signal);
	assert(resumeRun?.result?.kind === "success", "the /resume command executes successfully");
	assert(await waitForStatus(agent, "idle"), "the agent returns to idle after /resume");
	assert(root.sessionProjections.snapshot(agent.session).values.pause?.paused === false, "the pause projection clears after the resumed turn");
	const idlePause = await root.commands.execute(agent, "/pause", signal);
	assert(idlePause?.result?.kind === "success", "/pause while idle arms the latch for the next run");
	const cancelRun = await root.commands.execute(agent, "/pause-cancel", signal);
	assert(cancelRun?.result?.kind === "success", "/pause-cancel cancels the armed request");
	const cancelAgain = await root.commands.execute(agent, "/pause-cancel", signal);
	assert(cancelAgain?.result?.kind === "error", "/pause-cancel with nothing armed reports an error");
	await teardown(composition);
}

async function scenarioF() {
	console.log("\n[F] stop during the pause drain (abort wins the turn, latch survives)");
	const toolStarted = Promise.withResolvers();
	const composition = await composeRoot({
		1: toolCallScript({ delayMs: 800 }),
		2: toolCallScript({ delayMs: 100 })
	}, toolStarted);
	const { root } = composition;
	const agent = root.agentLoop.create("pause-test-f", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	agent.followup(createUserMessage({ content: [{ type: "text", text: "start" }], source: { kind: "user" } }));
	await toolStarted.promise; // tool running
	const pausePromise = agent.pause();
	agent.cancel({ kind: "user" }); // user clicks stop while the pause drains
	await agent.whenIdle();
	assert(agent.status === "idle", "agent idle after the abort");
	assert(lastTurnEnd(agent.session)?.reason?.kind === "aborted", "turn ended aborted");
	assert(await stillPending(pausePromise), "the pause promise stays pending after stop (stop is not cancel)");
	// The latch pauses the next run at its boundary.
	agent.followup(createUserMessage({ content: [{ type: "text", text: "after-stop" }], source: { kind: "user" } }));
	const outcome = await pausePromise;
	assert(outcome.paused === true, "the armed latch pauses the next run after the stop");
	assert(agent.status === "paused", "agent paused");
	agent.resume();
	await agent.whenIdle();
	assert(agent.status === "idle", "agent idle after resume");
	await teardown(composition);
}

async function scenarioG() {
	console.log("\n[G] queued prompts while paused are claimed on resume");
	const toolStarted = Promise.withResolvers();
	const composition = await composeRoot({ 1: toolCallScript({ delayMs: 300 }) }, toolStarted);
	const { root, state } = composition;
	const agent = root.agentLoop.create("pause-test-g", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	agent.followup(createUserMessage({ content: [{ type: "text", text: "start" }], source: { kind: "user" } }));
	await toolStarted.promise;
	await agent.pause();
	assert(agent.status === "paused", "paused");
	// Queue a follow-up while paused (the composer's send path).
	agent.followup(createUserMessage({ content: [{ type: "text", text: "queued-question" }], source: { kind: "user" } }));
	assert(agent.status === "paused", "queued input does not start a turn while paused");
	agent.resume();
	await agent.whenIdle();
	assert(state.requests.length === 2, "resume runs the continuation");
	const resumed = state.requests[1].messages;
	assert(resumed.some((m) => m.content?.some((b) => b.type === "text" && b.text === "queued-question")), "the resumed request carries the queued prompt");
	assert(resumed.some((m) => m.content?.some((b) => b.type === "tool-result")), "the resumed request also carries the tool result");
	await teardown(composition);
}

async function scenarioH() {
	console.log("\n[H] pauseCancel settles the armed request; later turns run normally");
	const toolStarted = Promise.withResolvers();
	const composition = await composeRoot({ 1: toolCallScript({ delayMs: 300 }) }, toolStarted);
	const { root } = composition;
	const agent = root.agentLoop.create("pause-test-h", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	agent.followup(createUserMessage({ content: [{ type: "text", text: "start" }], source: { kind: "user" } }));
	await toolStarted.promise; // tool running
	const pausePromise = agent.pause();
	const cancelled = agent.pauseCancel();
	assert(cancelled === true, "pauseCancel reports it cancelled an armed request");
	assert(agent.pauseCancel() === false, "pauseCancel is a no-op once nothing is armed");
	const outcome = await pausePromise;
	assert(outcome.paused === false && outcome.cancelled === true, "pause promise settles {paused:false, cancelled:true}");
	await agent.whenIdle();
	assert(lastTurnEnd(agent.session)?.reason?.kind === "completed", "the current turn runs to completion after the cancel");
	// A later run must NOT pause.
	agent.followup(createUserMessage({ content: [{ type: "text", text: "later" }], source: { kind: "user" } }));
	await agent.whenIdle();
	assert(lastTurnEnd(agent.session)?.reason?.kind === "completed", "later turns run normally after the cancel");
	await teardown(composition);
}

async function scenarioI() {
	console.log("\n[I] pause armed while idle pauses the next run's first step boundary");
	const toolStarted = Promise.withResolvers();
	const composition = await composeRoot({ 1: toolCallScript({ delayMs: 150 }) }, toolStarted);
	const { root } = composition;
	const agent = root.agentLoop.create("pause-test-i", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	const pausePromise = agent.pause(); // idle: arms the latch
	assert(agent.status === "idle", "arming while idle keeps the agent idle");
	agent.followup(createUserMessage({ content: [{ type: "text", text: "go" }], source: { kind: "user" } }));
	await toolStarted.promise;
	const outcome = await pausePromise;
	assert(outcome.paused === true, "the armed latch pauses the run at its first step boundary");
	assert(agent.status === "paused", "agent paused");
	assert(agent.session.events.some((e) => e.type === "tool/result"), "the first step fully completed before the pause");
	agent.resume();
	await agent.whenIdle();
	assert(agent.status === "idle", "agent idle after resume");
	await teardown(composition);
}

await scenarioA();
await scenarioB();
await scenarioC();
await scenarioD();
await scenarioE();
await scenarioF();
await scenarioG();
await scenarioH();
await scenarioI();
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
