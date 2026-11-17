// dsh-session-pause host plugin.
// Registers the global /pause, /pause-cancel, and /resume commands (the
// client button and the slash menu both drive them through the commands
// remote) and the `pause` session projection, which folds the durable
// "paused" turn/end reason into a per-session { paused: boolean } state the
// client button renders from.
//
// The pause/resume semantics themselves live in the bundled agent-loop fork
// (lib/agent-loop.js): pause() arms a persistent latch that drains the
// current step and closes the turn with turn/end reason "paused" — or, if the
// turn ends by any other path, keeps waiting for the next run's step
// boundary. resume() reopens the driver on the next turn. The paused state is
// durable in the session log (survives restarts); the armed latch is a
// live-process intent and deliberately does not.
//
// Note on agent status: the fork folds a paused phase into status "idle"
// rather than exposing a third AgentStatus (see lib/agent-loop.js header), so
// this host half must NOT branch on `agent.status === "paused"` — it is never
// that value. Use the projection (durable) or `agent.paused` (live phase).
//
// Goal interaction: because a paused agent reads as "idle", the stock
// goal-round-driver would consider it drivable and queue one extra goal round
// on pause (that round would then park at its own first step boundary, so it
// cannot run away — but it is still a spurious queued message). We suppress it
// WITHOUT forking the driver: `goals.disarm(agent)` clears the process-local
// `activation` edge, and the driver's `drivable()` check requires
// `activation === "armed"`, so no round is scheduled. Re-arming on resume via
// `goals.resume(agent, ref)` restores the exact prior state.
//
// Why disarm and not pause(): `goals.pause()` also flips the durable `phase`
// to "paused", which is a USER-VISIBLE goal state ("已暂停的目标") — the session
// button must not silently rewrite the user's goal lifecycle. `disarm` leaves
// `phase` at "active" and only touches the process-local continuation intent,
// which is precisely the concept a session pause suspends.
import { z } from "zod";

/** Stable Cordis plugin name used by Loader diagnostics. */
export const name = "session-pause";

/** Projection key and the value shape shared by the host fold and the client. */
const PAUSE_PROJECTION_KEY = "pause";
const pauseViewSchema = z.object({ paused: z.boolean() });

/** Installer-only definition id, so the command table can attribute the rows. */
const COMMAND_DEFINITION_ID = "dsh-session-pause";

/**
 * Remember which agents had an ARMED goal when a session pause suspended it, so
 * resume can restore exactly that. Process-local by design: an armed goal is a
 * live continuation intent, and a restart legitimately starts disarmed (the
 * goal service itself only re-arms on an authorized resume).
 * @type {Map<string, { goalId: string, revision: number }>}
 */
const suspendedGoals = new Map();

/**
 * Suspend an agent's automatic goal rounds for the duration of a session pause.
 *
 * A paused agent reports status "idle", which the stock goal-round-driver reads
 * as drivable, so without this it queues one spurious goal round. `disarm()`
 * clears only the process-local `activation` edge — `phase` stays "active" and
 * the durable goal is untouched — which is exactly the distinction between "the
 * goal itself is paused" and "the session is parked".
 * @param ctx - host context carrying the optional `goals` service.
 * @param agent - the agent about to be paused.
 */
function suspendGoalRounds(ctx, agent) {
	const goals = ctx.get("goals");
	if (goals === void 0) return;
	try {
		const goal = goals.get(agent);
		// Only an armed goal can schedule rounds, and only arming should be undone
		// by us — a goal the user already disarmed or the driver blocked stays as is.
		if (goal === void 0 || goal.activation !== "armed") return;
		goals.disarm(agent);
		suspendedGoals.set(agent.id, { goalId: goal.id, revision: goal.revision });
		ctx.logger.info(`agent "${agent.id}": goal "${goal.id}" disarmed for the pause`);
	} catch (error) {
		// Goal suppression is best-effort: a goal-service hiccup must never block
		// the pause itself. Worst case one extra round is queued and re-parks.
		ctx.logger.warn(`agent "${agent.id}": could not suspend goal rounds: ${String(error)}`);
	}
}

/**
 * Restore an armed goal that this plugin disarmed, before the resumed run
 * starts. No-op when nothing was suspended or the goal changed under us (the
 * id/revision guard makes an edited or replaced goal the user's business).
 * @param ctx - host context carrying the optional `goals` service.
 * @param agent - the agent about to resume.
 */
function restoreGoalRounds(ctx, agent) {
	const saved = suspendedGoals.get(agent.id);
	if (saved === void 0) return;
	suspendedGoals.delete(agent.id);
	const goals = ctx.get("goals");
	if (goals === void 0) return;
	try {
		const goal = goals.get(agent);
		if (goal === void 0 || goal.id !== saved.goalId) return;
		if (goal.activation === "armed") return;
		goals.resume(agent, { id: goal.id, revision: goal.revision });
		ctx.logger.info(`agent "${agent.id}": goal "${goal.id}" re-armed after the pause`);
	} catch (error) {
		// e.g. the round budget was exhausted meanwhile — resuming would throw
		// GOAL_INVALID_TRANSITION. Leaving it disarmed is the safe outcome.
		ctx.logger.warn(`agent "${agent.id}": could not re-arm goal "${saved.goalId}": ${String(error)}`);
	}
}

/**
 * @param ctx - host context (host plane; commands and projections are global registries)
 */
export function apply(ctx) {
	// Drop suspension bookkeeping when an agent goes away. The map is keyed by
	// agent id and only meaningful while that exact agent is live; without this
	// a long-lived process would retain an entry per paused-then-disposed agent.
	ctx.on("agent/disposed", ({ agent }) => {
		suspendedGoals.delete(agent.id);
	});
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.commands.register({
			definitionId: COMMAND_DEFINITION_ID,
			name: "pause",
			description: "Pause the current turn at the next step boundary and persist everything",
			handler: ({ agent }) => {
				try {
					// Suspend automatic goal rounds BEFORE arming the latch: a paused
					// agent reads as idle, which the goal driver treats as drivable.
					suspendGoalRounds(ctx, agent);
					// Arm the persistent latch; it waits for the next pausable
					// step boundary (across turns) until paused or cancelled.
					void agent.pause().then((outcome) => {
						if (outcome.paused) ctx.logger.info(`agent "${agent.id}": paused at the step boundary`);
						else if (outcome.cancelled) ctx.logger.info(`agent "${agent.id}": pause request cancelled`);
					}, (error) => {
						ctx.logger.warn(`agent "${agent.id}": pause failed: ${String(error)}`);
					});
					// `agent.paused` is the live phase flag (status stays "idle" for a
					// paused agent, so it cannot be used to tell these two apart).
					const text = agent.paused === true
						? "Already paused — use /resume to continue."
						: agent.status === "running"
							? "Pausing — the current answer and running tools finish first."
							: "Pause armed — the next run will pause at its step boundary.";
					return { kind: "success", text };
				} catch (error) {
					return { kind: "error", text: `Cannot pause: ${error instanceof Error ? error.message : String(error)}` };
				}
			}
		});
		commandCtx.commands.register({
			definitionId: COMMAND_DEFINITION_ID,
			name: "pause-cancel",
			description: "Cancel a pending pause request",
			handler: ({ agent }) => {
				try {
					const cancelled = agent.pauseCancel();
					// A cancelled pause never parks, so hand the goal's automatic
					// rounds straight back.
					if (cancelled) restoreGoalRounds(ctx, agent);
					return cancelled
						? { kind: "success", text: "Pause request cancelled." }
						: { kind: "error", text: "No pending pause request to cancel." };
				} catch (error) {
					return { kind: "error", text: `Cannot cancel pause: ${error instanceof Error ? error.message : String(error)}` };
				}
			}
		});
		commandCtx.commands.register({
			definitionId: COMMAND_DEFINITION_ID,
			name: "resume",
			description: "Continue a paused turn",
			handler: ({ agent }) => {
				// Check the phase FIRST: if there is nothing to resume, the goal must
				// stay suspended — re-arming it on a no-op click would restart rounds
				// the user never asked to restart.
				if (agent.paused !== true) return { kind: "error", text: "Nothing to resume — this session is not paused." };
				try {
					// Re-arm the goal BEFORE the driver opens the resumed turn, so the
					// continuation is once again eligible for automatic rounds.
					restoreGoalRounds(ctx, agent);
					agent.resume();
					return { kind: "success", text: "Resuming." };
				} catch (error) {
					return { kind: "error", text: `Cannot resume: ${error instanceof Error ? error.message : String(error)}` };
				}
			}
		});
	});
	ctx.inject(["sessionProjections"], (projectionCtx) => {
		projectionCtx.sessionProjections.register({
			key: PAUSE_PROJECTION_KEY,
			// `stateSchema` validates the folded state on checkpoint restore;
			// `wire` is what the client's useProjection() actually reads. A
			// definition with no `wire` is skipped by snapshot()/cachedSnapshot()
			// entirely, so omitting it makes the button silently never appear.
			stateSchema: pauseViewSchema,
			init: () => ({ paused: false }),
			apply: (state, event) => {
				if (event.type === "turn/end") return { paused: event.data.reason?.kind === "paused" };
				if (event.type === "turn/start") return { paused: false };
				return state;
			},
			wire: {
				viewSchema: pauseViewSchema,
				view: (state) => state
			},
			stateVersion: 1
		});
	});
}
