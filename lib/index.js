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
import { z } from "zod";

/** Stable Cordis plugin name used by Loader diagnostics. */
export const name = "session-pause";

/**
 * @param ctx - host context (host plane; commands and projections are global registries)
 */
export function apply(ctx) {
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.commands.register({
			name: "pause",
			description: "Pause the current turn at the next step boundary and persist everything",
			handler: ({ agent }) => {
				try {
					// Arm the persistent latch; it waits for the next pausable
					// step boundary (across turns) until paused or cancelled.
					void agent.pause().then((outcome) => {
						if (outcome.paused) ctx.logger.info(`agent "${agent.id}": paused at the step boundary`);
						else if (outcome.cancelled) ctx.logger.info(`agent "${agent.id}": pause request cancelled`);
					}, (error) => {
						ctx.logger.warn(`agent "${agent.id}": pause failed: ${String(error)}`);
					});
					const text = agent.status === "running"
						? "Pausing — the current answer and running tools finish first."
						: "Pause armed — the next run will pause at its step boundary.";
					return { kind: "success", text };
				} catch (error) {
					return { kind: "error", text: `Cannot pause: ${error instanceof Error ? error.message : String(error)}` };
				}
			}
		});
		commandCtx.commands.register({
			name: "pause-cancel",
			description: "Cancel a pending pause request",
			handler: ({ agent }) => {
				try {
					return agent.pauseCancel()
						? { kind: "success", text: "Pause request cancelled." }
						: { kind: "error", text: "No pending pause request to cancel." };
				} catch (error) {
					return { kind: "error", text: `Cannot cancel pause: ${error instanceof Error ? error.message : String(error)}` };
				}
			}
		});
		commandCtx.commands.register({
			name: "resume",
			description: "Continue a paused turn",
			handler: ({ agent }) => {
				try {
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
			key: "pause",
			schema: z.object({ paused: z.boolean() }),
			init: () => ({ paused: false }),
			apply: (state, event) => {
				if (event.type === "turn/end") return { paused: event.data.reason?.kind === "paused" };
				if (event.type === "turn/start") return { paused: false };
				return state;
			},
			view: (state) => state,
			stateVersion: 1
		});
	});
}
