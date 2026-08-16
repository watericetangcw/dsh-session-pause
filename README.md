# dsh-session-pause

DSH Web 的「暂停一切、下次恢复」profile bundle：在**发送/停止主按钮正左侧**（与其并列）提供暂停按钮，点击后优雅地排干当前执行（等最后一条 API 请求回答完、当前步骤内所有工具/命令行任务跑完），把会话完整落盘，按钮变为**继续按钮**；点击继续（或重启 DSH 后重新打开该会话再点继续）即从暂停点续跑。**不修改任何 DSH 代码**——整个功能是一个即装即用的 profile bundle。

## 行为

- **暂停（持久请求，永不放弃）**：点击后按钮转圈，暂停请求成为 agent 级持久 latch：不中断任何进行中的请求或工具；当前 step 到达边界后该轮以 `turn/end` reason `"paused"` 关闭、flush 落盘、agent 进入 `paused` 状态。若本轮先以其他方式结束（回答完成、max-tokens、被停止、出错），**请求不会放弃**——转圈持续，下一次运行会在其第一个步骤边界暂停。
- **取消暂停**：转圈期间鼠标悬停按钮 → 图标变为"取消暂停"（✕），移出恢复转圈；点击即取消（`/pause-cancel`），后续运行恢复正常。**1 秒防连击缓冲**：点击暂停后 1 秒内取消点击被忽略（悬停图标以降低不透明度提示未就绪）。
- **继续**：打开下一个 turn 并跳过「空输入即结束」的保护，模型基于**持久化的工具结果尾**继续原任务——语义上等价于从未暂停。暂停期间排队的新消息会随继续一起被认领。
- **重启恢复**：会话日志中最后的 `turn/end` reason 为 `"paused"` 时，恢复出的 agent 直接进入 paused 状态（不自动续跑），继续按钮照常工作。**armed 未暂停的请求不跨重启**（live-process 意图，文档化）。
- **停止 ≠ 取消暂停**：排干期间点停止只中止当前运行，转圈继续等待下一次可暂停时机。
- **goal 自动轮次**：`goal-round-driver` 只在 `idle` 时驱动，paused 状态天然阻断自动轮次；继续跑完后自动恢复。
- **持久化**：全部状态都在既有 session JSONL 中（消息、chunk、每次请求头/上下文、工具调用与结果、排队输入 splices），由 `session-checkpoint-policy` 与暂停完成时的显式 flush 保证落盘；本 bundle 不新增任何存储格式。

## 组成

- `lib/agent-loop.js` — fork 自 `@deepseek-ai/dsh-agent-loop@0.1.0-rc.6`，加入暂停核心（所有改动点带 `// PAUSE` 标记，便于升级时 re-sync）。由 bundle patch 禁用基础 `agent-loop` 行、插入 fork 行 `agent-loop-pause`。
- `lib/index.js`（host）— 注册全局 `/pause`、`/pause-cancel`、`/resume` 命令与 `pause` session 投影（`{paused:boolean}`，由日志折叠而来）。
- `lib/client.js`（client）— 在 `conversation.input.right` 槽位注册按钮，再用插件自有 CSS 定位到主按钮正左侧：`position:absolute; right:calc(34px + 12px + 8px)`（发送按钮宽 34 + trailing 间距 12 + 行右内边距 8；锚点是 `position:relative` 的 composer 卡片），`top:auto` 使其保持与按钮行同高的静态垂直位置。上游 UI 改版若改变这些常量，改插件内 `PAUSE_RIGHT_OFFSET` 一个变量即可。

## 安装 / 卸载

```powershell
# 安装（pnpm link + 自动写入 dsh.profile.bundles）
dsh plugin --profile web add "link:D:/HOBBY/20260816_DSH_暂停/dsh-pause"

# 卸载（恢复原生 agent-loop 行为）
dsh plugin --profile web remove dsh-session-pause
```

安装后重启 `dsh web` 生效（正在运行中的 DSH 进程不会热加载新组合）。

## 依赖解析（开发/运行时）

fork 与 host 插件 import `@deepseek-ai/*`，通过本包根目录的 `node_modules` 目录解析。仓库内已建立一个指向当前 DSH 安装的 junction；若 DSH 安装位置变化（如 npx 缓存被清理后重装），重新执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/relink.ps1
```

（`file:`/npm 方式安装的用户不需要 junction，依赖由 pnpm 正常解析。）

## 测试

```powershell
node test/pause-loop.mjs     # 9 个场景 60 断言：排干/流式排干/重启恢复/latch 不放弃/命令与投影/排干中停止/排队输入/取消/空闲武装
node test/api-smoke.mjs      # 需要运行中的测试实例（见脚本头部），真实模型冒烟
```

## 限制（见 notes/design.md）

- 暂停等待整个当前步骤（含其全部工具调用）完成；超长工具会让转圈持续（停止仅中止本轮，转圈继续等待；取消暂停可解除）。
- 排干期间挂起的审批/`ask_user_question` 会阻塞步骤完成（先答复、停止或取消暂停）。
- 排干中崩溃/杀进程：该轮按现有 crash-repair 记为 `interrupted`，不提供继续（先等转圈结束再关机）。
- 后台 jobs（`run_in_background`）按设计脱离 turn，不受暂停影响。
- fork 锁定 agent-loop 于 0.1.0-rc.6 行为；升级 DSH 后按 `// PAUSE` 标记 re-sync。
- 按钮定位依赖上游 4 个 CSS 常量（单点可调）；纯文本回合没有"步骤边界"，latch 会一直等到下一次出现工具步骤的可暂停时机（符合"等待时机"语义）。
