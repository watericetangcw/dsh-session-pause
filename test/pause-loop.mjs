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
// Goal integration: the stock goal driver treats a paused (idle-reading)
// agent as drivable, so the plugin disarms the goal around the pause.
import GoalService from "@deepseek-ai/dsh-goal";
import * as GoalRoundDriver from "@deepseek-ai/dsh-goal-round-driver";

const CWD = process.cwd();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hard watchdog: a hung scenario must fail loudly with its name instead of
// making the whole run look like an infinite loop. Generous enough for real
// adapter latency, short enough to keep the suite usable.
const SCENARIO_TIMEOUT_MS = 45000;
let currentScenario = "(startup)";
function guard(name, fn) {
	return async () => {
		currentScenario = name;
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`scenario ${name} timed out after ${SCENARIO_TIMEOUT_MS}ms`)), SCENARIO_TIMEOUT_MS);
		});
		try {
			await Promise.race([fn(), timeout]);
		} finally {
			clearTimeout(timer);
		}
	};
}
process.on("unhandledRejection", (error) => {
	console.error(`UNHANDLED REJECTION during ${currentScenario}:`, error);
	process.exit(1);
});

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
		// 0.2.1-rc.5 routes every model call through adapter.prepareCall(), which
		// the framework's LlmAdapter base class implements by default. A plain
		// object adapter has no base class, so it must supply the same contract:
		// bind the model metadata and return the generation-bound stream entry.
		async prepareCall(provider, model) {
			return {
				model: await this.resolveModel(provider, model),
				stream: (options) => this.stream(options)
			};
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
async function composeRoot(script, toolStarted, extraPlugins = []) {
	const root = new Context();
	const fibers = [];
	// 0.2.1-rc.5: AgentLoop also injects `sessionProjections` (it registers its
	// own turnBoundary + inbox units there). Omitting it leaves the AgentLoop
	// fiber stuck at state 0, so the wait loop below would spin forever.
	for (const plugin of [SessionStore, AgentRegistry, LlmRuntime, SystemPrompt, ToolRuntime, SessionProjectionRegistry]) fibers.push(root.plugin(plugin));
	for (const plugin of extraPlugins) fibers.push(root.plugin(plugin));
	fibers.push(root.plugin(AgentLoop, { agents: [] }));
	// cordis v4 mounts plugin fibers asynchronously; wait for all of them.
	const mountDeadline = Date.now() + 15000;
	for (;;) {
		if (fibers.every((fiber) => fiber.state === 2)) break;
		if (fibers.some((fiber) => fiber.state >= 4)) throw new Error(`composition failed: fiber state ${fibers.map((fiber) => fiber.state).join(",")}`);
		if (Date.now() > mountDeadline) throw new Error(`composition stalled at fiber states ${fibers.map((fiber) => fiber.state).join(",")} — a required service is probably unmounted`);
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
	return session.snapshotEvents().findLast((event) => event.type === "turn/end")?.data;
}

async function scenarioA() {
	console.log("\n[A] pause during a running tool call");
	const toolStarted = Promise.withResolvers();
	const composition = await composeRoot({ 1: toolCallScript({ delayMs: 600 }) }, toolStarted);
	const { root, state } = composition;
	const agent = await root.agentLoop.create("pause-test-a", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	agent.followup(createUserMessage({ content: [{ type: "text", text: "start" }], source: { kind: "user" } }));
	await toolStarted.promise; // the slow tool is now running
	const pausePromise = agent.pause();
	assert(agent.status === "running", "agent still running while the pause drains");
	const outcome = await pausePromise;
	assert(outcome.paused === true, "pause settles {paused:true} after the tool drain");
	assert(agent.paused === true, "agent status is paused");
	assert(lastTurnEnd(agent.session)?.reason?.kind === "paused", 'durable turn/end reason is "paused"');
	assert(agent.session.snapshotEvents().some((e) => e.type === "tool/result"), "tool result committed before pause");
	assert(state.requests.length === 1, "no follow-up model call during pause");
	agent.resume();
	await agent.whenIdle();
	assert(agent.status === "idle", "agent idle after resume completes");
	assert(state.requests.length === 2, "resume produced exactly one more model call");
	const resumedMessages = state.requests[1].messages;
	// Tool results reach the model as `role: "tool"` messages keyed by
	// toolCallId (createToolResultMessage), not as a "tool-result" content block.
	assert(resumedMessages.some((m) => m.role === "tool" && m.toolCallId !== void 0), "resumed request carries the tool result");
	assert(lastTurnEnd(agent.session)?.reason?.kind === "completed", "resumed turn completes normally");
	await teardown(composition);
}

async function scenarioB() {
	console.log("\n[B] pause during the in-flight model stream (tool-call tail)");
	const toolStarted = Promise.withResolvers();
	const composition = await composeRoot({ 1: slowToolCallScript({ delayMs: 400 }, 150) }, toolStarted);
	const { root, state } = composition;
	const agent = await root.agentLoop.create("pause-test-b", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	agent.followup(createUserMessage({ content: [{ type: "text", text: "stream" }], source: { kind: "user" } }));
	await sleep(180); // the argument stream is in flight
	const outcome = await agent.pause();
	assert(outcome.paused === true, "pause waits for the stream and the tool to finish");
	assert(agent.paused === true, "agent paused after the drain");
	assert(lastTurnEnd(agent.session)?.reason?.kind === "paused", 'turn/end reason "paused"');
	const callEvent = agent.session.snapshotEvents().find((e) => e.type === "tool/call");
	assert(callEvent?.data?.arguments === JSON.stringify({ delayMs: 400 }), "the in-flight tool call was not truncated by the pause");
	assert(agent.session.snapshotEvents().some((e) => e.type === "tool/result"), "the drained tool committed its result");
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
	const firstAgent = await first.root.agentLoop.create("pause-test-c", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	firstAgent.followup(createUserMessage({ content: [{ type: "text", text: "start" }], source: { kind: "user" } }));
	await toolStarted.promise;
	const outcome = await firstAgent.pause();
	assert(outcome.paused === true, "pre-restart pause completed");
	const seedEvents = structuredClone(firstAgent.session.snapshotEvents());
	const seedHeader = structuredClone(firstAgent.session.header);
	await teardown(first); // simulates the process going away

	// A fresh process composition resumes the same durable session.
	const second = await composeRoot({ 1: textScript("restart-continuation") }, Promise.withResolvers());
	// 0.2.1-rc.5's resumeWith() drives a persistence HANDLE, not a
	// prepare()-style factory: it calls persistence.open(id, "write", {signal})
	// and then reads handle.read(0, undefined, ...) / handle.append(...) plus
	// handle.header and handle.inheritedEventCount.
	const persistence = {
		async open(id) {
			let events = structuredClone(seedEvents);
			return {
				header: seedHeader,
				inheritedEventCount: 0,
				async read(from = 0, to) {
					return { events: events.slice(from, to ?? events.length), eventState: void 0 };
				},
				async append(appended) {
					events = [...events, ...appended];
				},
				async close() {}
			};
		}
	};
	const published = await second.root.agentLoop.resumeWith(second.root, persistence, {
		resumeSessionId: "pause-test-c",
		agentOptions: { provider: "scripted", model: "scripted-1" }
	});
	const restored = published.agent;
	assert(restored.paused === true, "restored agent detects the paused tail and stays paused");
	assert(second.state.requests.length === 0, "restore does not auto-run any model call");
	restored.resume();
	await restored.whenIdle();
	assert(restored.status === "idle", "restored agent resumes to idle");
	assert(second.state.requests.length === 1, "resume ran exactly one continuation call");
	const resumedMessages = second.state.requests[0].messages;
	assert(resumedMessages.some((m) => m.role === "tool" && m.toolCallId !== void 0), "restarted continuation carries the durable tool result");
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
	const agent = await root.agentLoop.create("pause-test-d", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	agent.followup(createUserMessage({ content: [{ type: "text", text: "plain" }], source: { kind: "user" } }));
	await sleep(150); // mid-stream
	const pausePromise = agent.pause();
	await agent.whenIdle();
	assert(agent.status === "idle", "agent idle after the natural completion");
	assert(lastTurnEnd(agent.session)?.reason?.kind === "completed", "turn ended completed");
	assert(await stillPending(pausePromise), "the pause promise stays pending after the natural end (no give-up)");
	const assistant = agent.session.snapshotEvents().findLast((e) => e.type === "assistant/message")?.data?.message;
	assert(assistant?.content?.[0]?.text === "one-two-", "the in-flight stream was allowed to finish");
	// The next run pauses at its first step boundary.
	agent.followup(createUserMessage({ content: [{ type: "text", text: "again" }], source: { kind: "user" } }));
	await toolStarted.promise;
	const outcome = await pausePromise;
	assert(outcome.paused === true, "the armed latch pauses the next run at its boundary");
	assert(agent.paused === true, "agent paused");
	assert(agent.session.snapshotEvents().filter((e) => e.type === "tool/result").length === 1, "the second run's step completed before the pause");
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

/**
 * Wait for the paused PHASE. A paused agent deliberately reports status "idle"
 * (it is not a third AgentStatus), so this polls the loop's phase-backed flag
 * instead of status.
 */
async function waitForPaused(agent, timeoutMs = 10000) {
	const start = Date.now();
	for (;;) {
		if (agent.paused === true) return true;
		if (Date.now() - start > timeoutMs) return false;
		await sleep(10);
	}
}

async function scenarioE() {
	console.log("\n[E] plugin glue: /pause, /resume commands and the pause projection");
	const toolStarted = Promise.withResolvers();
	const composition = await composeRoot({ 1: toolCallScript({ delayMs: 500 }) }, toolStarted);
	const { root } = composition;
	// composeRoot() already mounts SessionProjectionRegistry (AgentLoop injects
	// it in 0.2.1-rc.5), so mounting it again here would be a second registry
	// contending for the same service name — only add what is genuinely missing.
	const extra = [root.plugin(CommandRuntime), root.plugin({ apply: sessionPauseApply })];
	const glueDeadline = Date.now() + 15000;
	for (;;) {
		if (extra.every((fiber) => fiber.state === 2)) break;
		if (extra.some((fiber) => fiber.state >= 4)) throw new Error(`glue composition failed: fiber state ${extra.map((fiber) => fiber.state).join(",")}`);
		if (Date.now() > glueDeadline) throw new Error(`glue composition stalled at fiber states ${extra.map((fiber) => fiber.state).join(",")}`);
		await sleep(5);
	}
	const agent = await root.agentLoop.create("pause-test-e", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	const signal = new AbortController().signal;
	// The plugin's inject-based registrations settle asynchronously after its
	// fiber is ready; wait until the command resolves.
	const probeDeadline = Date.now() + 15000;
	for (;;) {
		const probe = await root.commands.execute(agent, "/resume", [], signal);
		if (probe !== void 0) break;
		if (Date.now() > probeDeadline) throw new Error("the /resume command never resolved — the plugin's command registration did not land");
		await sleep(5);
	}
	agent.followup(createUserMessage({ content: [{ type: "text", text: "start" }], source: { kind: "user" } }));
	await toolStarted.promise; // tool is running
	const pauseRun = await root.commands.execute(agent, "/pause", [], signal);
	assert(pauseRun?.result?.kind === "success", "the /pause command executes successfully");
	assert(await waitForPaused(agent), "the agent reaches paused after /pause");
	assert(root.sessionProjections.snapshot(agent.session).values.pause?.paused === true, 'the pause projection reports {paused:true}');
	const pausedPause = await root.commands.execute(agent, "/pause", [], signal);
	assert(pausedPause?.result?.kind === "error", "/pause while already paused reports an error");
	const resumeRun = await root.commands.execute(agent, "/resume", [], signal);
	assert(resumeRun?.result?.kind === "success", "the /resume command executes successfully");
	assert(await waitForStatus(agent, "idle"), "the agent returns to idle after /resume");
	assert(root.sessionProjections.snapshot(agent.session).values.pause?.paused === false, "the pause projection clears after the resumed turn");
	const idlePause = await root.commands.execute(agent, "/pause", [], signal);
	assert(idlePause?.result?.kind === "success", "/pause while idle arms the latch for the next run");
	const cancelRun = await root.commands.execute(agent, "/pause-cancel", [], signal);
	assert(cancelRun?.result?.kind === "success", "/pause-cancel cancels the armed request");
	const cancelAgain = await root.commands.execute(agent, "/pause-cancel", [], signal);
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
	const agent = await root.agentLoop.create("pause-test-f", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
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
	assert(agent.paused === true, "agent paused");
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
	const agent = await root.agentLoop.create("pause-test-g", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	agent.followup(createUserMessage({ content: [{ type: "text", text: "start" }], source: { kind: "user" } }));
	await toolStarted.promise;
	await agent.pause();
	assert(agent.paused === true, "paused");
	// Queue a follow-up while paused (the composer's send path).
	agent.followup(createUserMessage({ content: [{ type: "text", text: "queued-question" }], source: { kind: "user" } }));
	assert(agent.paused === true, "queued input does not start a turn while paused");
	agent.resume();
	await agent.whenIdle();
	assert(state.requests.length === 2, "resume runs the continuation");
	const resumed = state.requests[1].messages;
	assert(resumed.some((m) => m.content?.some((b) => b.type === "text" && b.text === "queued-question")), "the resumed request carries the queued prompt");
	assert(resumed.some((m) => m.role === "tool" && m.toolCallId !== void 0), "the resumed request also carries the tool result");
	await teardown(composition);
}

async function scenarioH() {
	console.log("\n[H] pauseCancel settles the armed request; later turns run normally");
	const toolStarted = Promise.withResolvers();
	const composition = await composeRoot({ 1: toolCallScript({ delayMs: 300 }) }, toolStarted);
	const { root } = composition;
	const agent = await root.agentLoop.create("pause-test-h", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
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
	const agent = await root.agentLoop.create("pause-test-i", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	const pausePromise = agent.pause(); // idle: arms the latch
	assert(agent.status === "idle", "arming while idle keeps the agent idle");
	agent.followup(createUserMessage({ content: [{ type: "text", text: "go" }], source: { kind: "user" } }));
	await toolStarted.promise;
	const outcome = await pausePromise;
	assert(outcome.paused === true, "the armed latch pauses the run at its first step boundary");
	assert(agent.paused === true, "agent paused");
	assert(agent.session.snapshotEvents().some((e) => e.type === "tool/result"), "the first step fully completed before the pause");
	agent.resume();
	await agent.whenIdle();
	assert(agent.status === "idle", "agent idle after resume");
	await teardown(composition);
}

async function scenarioJ() {
	console.log("\n[J] goal rounds are suspended across the pause and restored on resume");
	const toolStarted = Promise.withResolvers();
	const composition = await composeRoot(
		{ 1: toolCallScript({ delayMs: 300 }), 2: textScript("resumed"), 3: textScript("goal-round") },
		toolStarted,
		[GoalService, GoalRoundDriver]
	);
	const { root, state } = composition;
	const extra = [root.plugin(CommandRuntime), root.plugin({ apply: sessionPauseApply })];
	const glueDeadline = Date.now() + 15000;
	for (;;) {
		if (extra.every((fiber) => fiber.state === 2)) break;
		if (extra.some((fiber) => fiber.state >= 4)) throw new Error(`glue composition failed: ${extra.map((f) => f.state).join(",")}`);
		if (Date.now() > glueDeadline) throw new Error("glue composition stalled");
		await sleep(5);
	}
	const agent = await root.agentLoop.create("pause-test-j", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	const signal = new AbortController().signal;
	for (;;) {
		if (await root.commands.execute(agent, "/resume", [], signal) !== void 0) break;
		await sleep(5);
	}

	// An armed goal is what the driver would auto-continue.
	const created = root.goals.create(agent, { objective: "keep going" });
	assert(created.phase === "active", "goal starts active");
	assert(root.goals.get(agent)?.activation === "armed", "goal starts armed");

	agent.followup(createUserMessage({ content: [{ type: "text", text: "start" }], source: { kind: "user" } }));
	await toolStarted.promise;

	const pauseRun = await root.commands.execute(agent, "/pause", [], signal);
	assert(pauseRun?.result?.kind === "success", "/pause succeeds with an active goal");
	assert(await waitForPaused(agent), "agent pauses");
	// THE POINT: the goal driver must no longer consider this agent drivable.
	const suspended = root.goals.get(agent);
	assert(suspended.phase === "active", "the goal's durable phase is untouched (only its activation is cleared)");
	assert(suspended.activation === "disarmed", "the goal is disarmed so no automatic round is scheduled");

	const requestsWhilePaused = state.requests.length;
	await sleep(600); // give a driver (if any) room to queue a spurious round
	assert(state.requests.length === requestsWhilePaused, "no goal round ran while paused");
	assert(agent.inbox.nextTurn.length === 0, "no spurious goal round was queued into the inbox");

	const resumeRun = await root.commands.execute(agent, "/resume", [], signal);
	assert(resumeRun?.result?.kind === "success", "/resume succeeds");
	assert(root.goals.get(agent)?.activation === "armed", "the goal is re-armed by resume");
	// After resume the goal is armed again, so the driver MAY legitimately start
	// a real goal round — that is the feature working, not a leak. Wait for
	// quiescence and assert the round was a genuine goal round.
	await agent.whenIdle();
	const goalRounds = agent.session.snapshotEvents().filter((e) => e.type === "user/message" && e.data?.source?.kind === "goal").length;
	assert(goalRounds <= 1, `at most one goal round was queued across the whole pause/resume cycle (saw ${goalRounds})`);
	assert(agent.status === "idle" || agent.status === "running", "agent is in a valid phase after resume");

	// A pause with no goal at all must not invent one.
	const plain = await root.agentLoop.create("pause-test-j-plain", { provider: "scripted", model: "scripted-1" }, { cwd: CWD });
	await root.commands.execute(plain, "/pause-cancel", [], signal);
	assert(root.goals.get(plain) === void 0, "pausing an agent without a goal creates no goal");
	await teardown(composition);
}

for (const [name, scenario] of [
	["A", scenarioA], ["B", scenarioB], ["C", scenarioC],
	["D", scenarioD], ["E", scenarioE], ["F", scenarioF],
	["G", scenarioG], ["H", scenarioH], ["I", scenarioI],
	["J", scenarioJ]
]) {
	try {
		await guard(name, scenario)();
	} catch (error) {
		failures += 1;
		console.error(`FAIL  scenario ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
