# dsh-session-pause 设计说明

## 为什么必须 fork agent-loop

勘察结论：DSH 的执行状态**已经全部持久化**在会话日志里（`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`request/header`、`agent/inbox/spliced` 等事件），`Session.deriveMessages()` 与 `Inbox` 重放能在重启后重建下一次请求的全部消息。因此「暂停」不需要新的持久化格式，只需要循环在**步骤边界**优雅停下并在继续时跳过两个既有保护：

1. `turn()` 的空输入保护（`phase.step === 0 && decision.messages.length === 0` 直接结束 turn）——否则继续时新 turn 因无新消息而立刻空转结束；
2. 没有「无消息唤醒 driver」的公开入口——只有 `followup/steer`（都要带消息）。

纯外部插件无法无痕实现这两点（合成空消息会污染模型转录，preStep reject 会把 turn 记成 `blocked`），所以本 bundle 携带 agent-loop 的 fork（`lib/agent-loop.js`），由 bundle patch 禁用基础行、插入 fork 行。fork 的所有改动点都有 `// PAUSE` 标记，升级时照清单搬运即可。

## 依赖契约：bundle 禁止携带可安装的 DSH 运行时依赖

**教训（曾经的线上 bug）**：`dsh plugin add` 只是把参数转发给 profile 目录里的 `pnpm add`。如果 bundle 的 `package.json` 把任何 `@deepseek-ai/*` 包声明为普通 `dependencies`，pnpm 会在 profile 的 node_modules 里物化出这些包的**第二份模块实例**。fork 用这份副本的 `createScope` 给 agent ctx 打 scope 标签，而部署自带的 `dsh-agent-presets` 用自己副本的 `scopeOf` 读取——两个副本的私有 `kScope` Symbol 不是同一个，`scopeOf(agentCtx)` 恒为 `undefined`，于是每次创建会话都报：

```
agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset
```

连带症状：新会话页选工作区/preset 立即闪跳回旧值（选择动作触发的 `session.create` 失败后 UI 回退）、新工作区无法创建会话。同理 `Service`/`SessionPreparation` 等 class 身份也会分裂，只是 scope 标签最先被踩到。

**规则**：
- `package.json` 的 `dependencies` 必须为空。`@deepseek-ai/*` 包只允许放在 `devDependencies`（供本地开发/测试解析，`files` 白名单本就不打包 node_modules，消费方不会安装 devDeps），且**不要**声明为 `peerDependencies`（其他 pnpm 配置可能自动安装 peer，同样物化副本）。
- 运行时解析依赖 DSH 安装目录的 flat fallback：Node 沿父目录向上找到 `$DSH_HOME/profiles/node_modules`，那里是安装依赖闭包每个包的 junction/symlink（由 `healProfilesModuleFallback` 在 boot 时维护），指向部署唯一实例——fork 与 `dsh-agent-presets` 因此共享同一份 `dsh-scope`。
- fork 新增 import 前先确认目标包在部署依赖闭包内（能解析即证明在闭包内；否则 boot 时以明确模块解析错误失败，属于期望的 fail-loud 行为）。
- `test/dependency-contract.mjs` 静态断言 `dependencies` 为空并扫描 `lib/*.js` 的全部 import 都落在 devDependencies（或客户端模块表 `react`），运行时断言部署 `scopeOf` 能读到 fork 创建的 agent scope key——两重防回归。

## 暂停语义（fork 内部）

- **持久 latch**：`pauseRequested`/`pauseDone` 是 agent 级字段（不是运行相位上的临时标志）。`pause()` 幂等置位并返回 promise（idle 时也允许，等待下一次运行）；`pauseCancel()` 清位并以 `{paused:false, cancelled:true}` 结算。
- **边界**：`turn()` 在当前 step 完整结束（流式回答 + 全部工具调用 + 结果按序提交）后，若 latch 置位且 `turnEnds === null` → `turnEnds = {kind:"paused"}`；无条件 break；`turn/end` 落盘；`kick()` 的 finally 在 `settledPaused` 时**消费 latch**、phase 置 `paused`、flush 会话、resolve `{paused:true}`。
- **不放弃**：任何其他结局（completed / max-tokens / aborted / error / blocked）→ 转 idle，**不 resolve、不清 latch**；promise 保持 pending，下一次运行在其第一个步骤边界暂停（每轮最多跑一个 step 即暂停）。停止（`cancel({kind:'user'})`）不清 latch——停止 ≠ 取消暂停；仅 `disposed` 拆卸时结算清理。
- **继续**：`resume()`（paused → running，携带一次性 `resumePending`）跳过空输入保护；派生历史自带工具结果尾，模型直接续答；排队输入在同一边界被认领。latch 已被消费，续跑轮不会再次自动暂停。
- **重启恢复**：构造函数读最后一条 `turn/end`，reason 为 `"paused"` 时初始 phase 即为 paused（不自动运行）。armed 未暂停的 latch 不跨重启。
- **status 第三态 `"paused"`**：goal-round-driver 只在 idle 驱动 → 暂停期间自动轮次天然停止；`=== "running"` 的消费方（steer 可用性、subagent 活动）视作未运行。
- **守卫**：paused 相位无 abort controller——`wakeDriver` 直接返回（排队消息留给 resume）、`send` 不读 `phase.abort`、`cancel` 转回 idle（disposed 时静默赋值避免拆卸期触发 idle 事件）。

## 数据流

```
浏览器按钮 → session.command('/pause' | '/pause-cancel' | '/resume')   # client sessions binding → remote.commands.execute (typert)
          → commands.execute(agent, line)                            # 全局命令注册（本 bundle host 行）
          → agent.pause() / pauseCancel() / resume()                 # fork 的方法
状态回传   ← turn/end reason "paused" (会话日志)                       # 持久化标记
          ← sessionProjections key "pause"                           # apply(state,event) 折叠日志 → {paused}
          ← 客户端 useProjection('pause')                             # session/projection 帧（与 plan/goal 同机制）
转圈状态   ← 客户端本地 pausing（仅由 paused 达成或取消点击清除）        # 与 latch 的"等待"语义一致
```

## UI 定位（零 DSH 改动）

- 注册槽位 `conversation.input.right`（插件自治），再用插件自有 CSS 把按钮绝对定位到**发送/停止主按钮正左侧**：composer 卡片是 `position:relative`，`right:calc(34px + 12px + 8px)` 把按钮放到主按钮左邻、间隔 12px；`top:auto` 令其保持 trailing 行的静态垂直位置（abs 定位 + top:auto 的静态位置规则）。
- 为什么不在发送按钮右边：卡片右侧安全区仅 `--dsh-composer-side-clearance:16px`，任何 34px 按钮放右边必然伸出卡片造成横向溢出。
- 代价：定位依赖上游 4 个 CSS 常量（按钮 34、gap 12、行右内边距 8、卡片 border 1），集中在插件内 `PAUSE_RIGHT_OFFSET` 单点可调；上游 UI 改版需目视复核一次。

## 取消交互

- 转圈态（`pausing && !paused`）：默认 spinner；hover → ✕ 取消图标（移出恢复）；点击 → `/pause-cancel` 并清本地态。
- 1 秒防连击缓冲：点击暂停后 `setTimeout(1000)` 内取消点击被忽略，hover 图标降不透明度（`dsh-pause-btn-not-ready`）提示未就绪；计时随卸载/重新点击清理重置。
- 竞态：取消与暂停达成同时发生时，`pauseCancel()` 变 no-op（latch 已消费），UI 按投影显示继续，无副作用。

## 边界情况

- **排干中停止**：本轮 abort（abort 优先），latch 存活、转圈继续；下一条消息在边界暂停（测试 F）。
- **纯文本回合**：没有步骤边界 → 轮次自然结束，latch 继续等待；下一次出现工具步骤的边界才暂停（测试 D）——即"等待到可暂停时再暂停"。
- **暂停中排队消息**：消息留在 inbox（持久化 splice），继续时被认领（测试 G）。
- **排干中崩溃**：turn 无 `turn/end` → 重启时 crash-repair 补 `interrupted` 闭包，不提供继续；先等转圈完成再关机。
- **挂起的审批/提问**：阻塞当前 step，排干等待其完成（答复、停止或取消暂停解除）。
- **后台 jobs**：脱离 turn，不受影响（自有 session 持久化）。
- **插件内存变量**：跨重启状态在 DSH 中统一以「会话事件 / 存储域」为媒介；本方案持久化完整执行状态，不序列化任意插件闭包内存（与 DSH 整体设计一致）。
