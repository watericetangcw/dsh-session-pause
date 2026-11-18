<div align="center">

# dsh-session-pause

**Pause anything in DeepSeek Harness, then pick up right where you left off**

[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-web%20bundle-4f46e5.svg)](https://github.com/DL909/dsh-session-pause)

**[简体中文](README.md) · English**

</div>

> **Compatibility**: this version targets `dsh@0.2.1-rc.5` (the bundled agent-loop fork is
> aligned to that release). On any other dsh version it fails **silently** at startup —
> module exports no longer match, so agent sessions stop working without an error.
> Check `dsh --version` before installing.

Install once, use forever: click **⏸ Pause** next to the send button, let the current turn finish gracefully (answer written, all tools run to completion), and the whole session is persisted — close or even restart DSH, come back and click **▶ Resume** to continue from the exact pause point, as if nothing ever stopped. **No DSH code is modified** — the entire feature is a drop-in profile bundle.

## ✨ Features

### ⏸ One-click pause

A pause button appears right to the **left of the send/stop button**. Clicking it never interrupts an in-flight request; once the current step reaches its boundary, the turn closes as `paused` and everything is flushed to disk — the button then becomes a **Resume button**.

### 💾 Full persistence

Pausing = persisting everything: messages, chunks, tool calls and results, and request context are all written into the existing session JSONL — **no new storage format is introduced**. So as long as DSH is around, you can always continue.

### 🔄 Survives restarts

When the last turn in the session log ends `paused`, reopening the session after a DSH restart puts the agent straight back into the paused state, and the Resume button just works — **shut DSH down or even move machines, and you lose nothing**.

### 🛑 Three small things while draining

| Action | Effect |
| --- | --- |
| Hover the spinning button | The icon briefly swaps to ✕, then back when you leave |
| Click ✕ (cancel pause) | Cancels the pause request; later runs go back to normal |
| Click stop | Does **not** cancel the pause — it only aborts the current turn, and the spinner keeps waiting for the next pausable moment |

> While paused the agent still reports status `idle` (`paused` is an internal phase, not a third `AgentStatus`), so the plugin explicitly disarms the goal's automatic rounds on pause and re-arms them on resume — no extra goal round is queued.

## 🚀 Quick install

One command:

```powershell
dsh plugin --profile web add github:DL909/dsh-session-pause
```

Then restart `dsh web` and refresh the browser page once.

> The bundle ships **no installable `@deepseek-ai/*` dependencies on purpose**: at runtime its host half resolves those packages from the DSH installation itself (the shared module instances), so the forked agent loop stays identity-compatible with the deployment's presets, scope, and session services. Install it through `dsh plugin add` (as above) — do not `npm install` it as a plain library into a profile.

<details>
<summary>Uninstall</summary>

```powershell
dsh plugin --profile web remove dsh-session-pause
```

Restart `dsh web` afterwards to restore the stock agent-loop behavior.

</details>

## 🧪 Try it now

Install, then give DSH a long tool-using task and let it run:

**① Pause and resume**

Click ⏸ to the left of the send button → wait for the spinner to finish and the button to turn into ▶ → click ▶. The model continues the original task from the persisted tool results — semantically identical to never having paused.

**② Resume after a restart**

Pause, then restart `dsh web` and reopen the same session → it is already paused; click ▶ to continue from the pause point.

**③ Queued a message while paused?**

New messages you send while paused stay in the session and get claimed together on resume — nothing is lost.

## 📖 Usage

- **Pause**: click ⏸ while running (or type `/pause`); you can also arm it while idle so the next run pauses at its first step boundary.
- **Cancel pause**: hover the spinner → click ✕ (or `/pause-cancel`).
- **Resume**: click ▶ when paused (or `/resume`).
- **Commands**: `/pause`, `/pause-cancel`, and `/resume` are all available from the slash menu.

## 🔗 Links

- Repository: [github.com/DL909/dsh-session-pause](https://github.com/DL909/dsh-session-pause)

## 📄 License

[MIT](LICENSE) © 2026 WateRice
