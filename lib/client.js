// dsh-session-pause client plugin.
// Renders the pause/continue button beside the composer's primary send/stop
// button. The occupant registers into `conversation.input.right` (the tool-row
// zone) and is then CSS-positioned directly LEFT of the primary button:
// position:absolute anchors on the composer card (.card is position:relative)
// with `right: calc(34px + 12px + 8px)` (send button 34px, trailing gap 12px,
// row right padding 8px) and `top:auto`, which keeps the static vertical
// position of the trailing row. No product code is modified.
//
// Interactions:
//   - running          → pause button (⏸); click arms the persistent host latch
//   - pausing          → spinner; HOVER swaps it to a cancel icon (✕); the
//                        cancel click is ignored for the first 1s (anti
//                        double-click buffer, icon dimmed), then cancels the
//                        pending pause via /pause-cancel
//   - paused (durable) → continue button (▶); click resumes via /resume
// The spinner keeps spinning while the latch waits for a pausable boundary
// (e.g. after the turn ended naturally or was stopped) — the request never
// gives up on its own.
window.__ModuleLoader__.load({
	id: "dsh-session-pause",
	factory: (require) => {
		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");

		// Namespaced by package id: dsh-client-locale throws when the same
		// (ns, locale) pair is registered twice, so a bare "session-pause" would
		// collide across an HMR re-activation or a second instance in the graph.
		const NS = "dsh-session-pause";
		const DICTS = {
			zh: {
				"input.pause": "暂停",
				"input.resume": "继续",
				"input.pausing": "正在等待暂停时机…",
				"input.cancelPause": "取消暂停",
				"input.cancelPauseSoon": "正在等待暂停时机…（稍候可取消）"
			},
			en: {
				"input.pause": "Pause",
				"input.resume": "Resume",
				"input.pausing": "Waiting to pause…",
				"input.cancelPause": "Cancel pause",
				"input.cancelPauseSoon": "Waiting to pause… (cancel available shortly)"
			}
		};

		// Anticipated layout constants of the SHIPPED composer (verified against
		// @deepseek-ai/dsh-client-ui-conversation 0.2.1-rc.5):
		//   .uV2eYG_primary   width:34px; height:34px
		//   .uV2eYG_trailing  gap:12px      (default)
		//   .uV2eYG_row       padding:2px 8px 6px
		//   .uV2eYG_card      position:relative
		// So the primary button's left edge sits 34+12+8 = 54px from the card's
		// right edge, and our button needs `right:54px` to end up 12px to its left.
		// Below a 560px container the composer narrows that trailing gap to 8px,
		// so the matching offset becomes 34+8+8 = 50px — see the @container rule
		// below. Centralized here so an upstream restyle needs one edit.
		const PAUSE_RIGHT_OFFSET = "calc(34px + 12px + 8px)";
		const PAUSE_RIGHT_OFFSET_NARROW = "calc(34px + 8px + 8px)";
		const NARROW_CONTAINER_QUERY = "(width<=560px)";
		const CANCEL_BUFFER_MS = 1000;

		const css = `.dsh-pause-btn{position:absolute;top:auto;right:${PAUSE_RIGHT_OFFSET};z-index:2;background:var(--dsw-alias-button-info-fill);color:#fff;cursor:pointer;border:none;border-radius:999px;flex:none;place-items:center;width:34px;height:34px;transition:background-color .1s;display:grid;transform:translateY(-2px)}.dsh-pause-btn:hover:not(:disabled){filter:brightness(1.06)}.dsh-pause-btn:disabled{cursor:default;opacity:.85}.dsh-pause-btn-not-ready{opacity:.6}.dsh-pause-btn-spin{box-sizing:border-box;width:14px;height:14px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:dsh-pause-spin .8s linear infinite}@keyframes dsh-pause-spin{to{transform:rotate(360deg)}}` + `@container ${NARROW_CONTAINER_QUERY} {.dsh-pause-btn{right:${PAUSE_RIGHT_OFFSET_NARROW}}}`;
		const styleTagId = "dsh-session-pause/styles";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(styleTagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-pause";
			tag.dataset.pluginCss = styleTagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const PauseIcon = () => jsxRuntime.jsxs("svg", {
			viewBox: "0 0 16 16",
			width: "14",
			height: "14",
			"aria-hidden": true,
			children: [jsxRuntime.jsx("rect", {
				x: "3.4",
				y: "2.5",
				width: "3.6",
				height: "11",
				rx: "1.2",
				fill: "currentColor"
			}), jsxRuntime.jsx("rect", {
				x: "9",
				y: "2.5",
				width: "3.6",
				height: "11",
				rx: "1.2",
				fill: "currentColor"
			})]
		});
		const ResumeIcon = () => jsxRuntime.jsx("svg", {
			viewBox: "0 0 16 16",
			width: "14",
			height: "14",
			"aria-hidden": true,
			children: jsxRuntime.jsx("path", {
				d: "M4.6 2.9c0-.94 1.03-1.5 1.83-1.02l6.4 4.6c.7.5.7 1.54 0 2.04l-6.4 4.6c-.8.48-1.83-.08-1.83-1.02V2.9z",
				fill: "currentColor"
			})
		});
		const CancelIcon = () => jsxRuntime.jsx("svg", {
			viewBox: "0 0 16 16",
			width: "14",
			height: "14",
			"aria-hidden": true,
			children: jsxRuntime.jsx("path", {
				d: "M4.1 4.1a.9.9 0 0 1 1.27 0L8 6.73l2.63-2.63a.9.9 0 1 1 1.27 1.27L9.27 8l2.63 2.63a.9.9 0 1 1-1.27 1.27L8 9.27l-2.63 2.63a.9.9 0 1 1-1.27-1.27L6.73 8 4.1 5.37a.9.9 0 0 1 0-1.27z",
				fill: "currentColor"
			})
		});
		const Spinner = () => jsxRuntime.jsx("span", {
			className: "dsh-pause-btn-spin",
			"aria-hidden": true
		});

		// The client sessions service, captured at apply time.
		let sessionsService = void 0;
		let translate = (key) => DICTS.zh[key] ?? key;

		/**
		* The composer pause control. `running`/`paused` come from standard
		* session-scope props; `pausing`/`cancelReady`/`hovering` are local
		* interaction state. The spinner persists until the durable pause lands
		* or the user cancels — matching the host's persistent pause latch.
		*/
		function PauseControl({ useSession, useProjection, sessionId, t }) {
			const running = useSession((s) => s.running) ?? false;
			const subagent = useSession((s) => s.subagent) ?? null;
			const paused = useProjection("pause", (value) => value?.paused === true) ?? false;
			const [pausing, setPausing] = react.useState(false);
			const [cancelReady, setCancelReady] = react.useState(false);
			const [hovering, setHovering] = react.useState(false);
			// Anti-double-click buffer: the cancel click stays inert for the
			// first second after the pause click.
			react.useEffect(() => {
				if (!pausing) return;
				setCancelReady(false);
				const handle = setTimeout(() => setCancelReady(true), CANCEL_BUFFER_MS);
				return () => clearTimeout(handle);
			}, [pausing]);
			// The spinner stops once the durable pause lands.
			react.useEffect(() => {
				if (paused && pausing) setPausing(false);
			}, [paused, pausing]);
			const command = (line) => {
				const session = sessionsService?.binding(sessionId)?.session;
				if (session === void 0) return;
				session.command(line).catch(() => {});
			};
			// Main sessions only: subagent windows keep their own stop lifecycle.
			if (subagent !== null) return null;
			if (paused) {
				const label = t ? t("input.resume") : translate("input.resume");
				return jsxRuntime.jsx("button", {
					type: "button",
					className: "dsh-pause-btn",
					"aria-label": label,
					title: label,
					onClick: () => command("/resume"),
					children: jsxRuntime.jsx(ResumeIcon, {})
				});
			}
			if (pausing) {
				const ready = cancelReady;
				const label = t ? t(ready && hovering ? "input.cancelPause" : hovering ? "input.cancelPauseSoon" : "input.pausing") : translate(ready && hovering ? "input.cancelPause" : hovering ? "input.cancelPauseSoon" : "input.pausing");
				return jsxRuntime.jsx("button", {
					type: "button",
					className: "dsh-pause-btn" + (hovering && !ready ? " dsh-pause-btn-not-ready" : ""),
					"aria-label": label,
					title: label,
					onMouseEnter: () => setHovering(true),
					onMouseLeave: () => setHovering(false),
					onClick: () => {
						if (!ready) return;
						setPausing(false);
						setHovering(false);
						command("/pause-cancel");
					},
					children: hovering ? jsxRuntime.jsx(CancelIcon, {}) : jsxRuntime.jsx(Spinner, {})
				});
			}
			if (running) {
				const label = t ? t("input.pause") : translate("input.pause");
				return jsxRuntime.jsx("button", {
					type: "button",
					className: "dsh-pause-btn",
					"aria-label": label,
					title: label,
					onClick: () => {
						setPausing(true);
						command("/pause");
					},
					children: jsxRuntime.jsx(PauseIcon, {})
				});
			}
			return null;
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === void 0) return;
			const locale = ctx.get("locale");
			if (locale !== void 0) {
				ctx.effect(() => locale.register(NS, DICTS), "session-pause: dictionaries");
				try {
					translate = locale.bind(NS);
				} catch {
					// keep the static fallback
				}
			}
			sessionsService = ctx.get("sessions");
			slots.inject("conversation.input.right", () => slots.register({
				name: "conversation.input.right",
				id: "session-pause",
				order: 0,
				locale: NS
			}, PauseControl));
		}

		const module = { exports: {} };
		// Service-level dependency declaration. Without it Cordis' Fiber does not
		// wait for these services, and since client entries activate in parallel
		// (dsh-client-modules ClientEntries.start uses Promise.all), `apply` can
		// run before `slots` is provided. `apply` then hits its `slots === void 0`
		// guard and silently registers nothing: no button, no error.
		module.exports.inject = ["slots", "sessions", "locale"];
		module.exports.apply = apply;
		module.exports.name = "session-pause";
		return module.exports;
	}
});
