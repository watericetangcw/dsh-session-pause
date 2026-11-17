# dsh-session-pause 升级到 dsh@0.2.1-rc.5 计划

## 〇、执行结果（已完成）

分支 `upgrade/0.2.1-rc5`。用户决策：**取消第三态（方案 B）**。

| 验证项 | 结果 |
|---|---|
| `scripts/verify-fork.sh` | ✅ `PAUSE hunks: 13 (documented: 13)`，零漂移，exit 0 |
| `test/pause-loop.mjs` | ✅ **ALL PASSED**，**76 条断言，10 个场景（A–J）**，exit 0 |
| `test/dependency-contract.mjs` | ✅ CONTRACT OK（含 `scopeOf` 无双重实例断言），exit 0 |
| `test/client-manifest.mjs` | ✅ CLIENT CONTRACT OK，exit 0 |
| fork 可加载性 | ✅ `import('./lib/agent-loop.js')` 成功（升级前是 `SyntaxError: ... 'Inbox'`） |

实现中发现并修复了计划**未预见**的 5 个问题（见下文各条标注「执行中发现」）：

1. **`session.events` 已不存在**——rc5 移除了该数组，须改用 `session.snapshotEvents()`。
2. **`AgentLoop.create()` 变 async**——须 `await`，否则拿到未出版的 agent。
3. **`ctx.agent` 属性访问会抛错**（"cannot get property "agent" without inject"）——改用 `ctx.agents.requireInitiator()`。
4. **`runMaintenance` 会抹掉 paused 相位**（真 bug）：恢复会话时 setup 走 `runMaintenance`，其 finally 无条件 `setPhase(idle)`，导致**从磁盘恢复的暂停状态静默变回 idle**。已改为进入时记住相位、退出时还原。这是本次最有价值的发现，只有真跑测试才暴露。
5. **测试环境的 LLM adapter 契约变了**：每轮调用都经 `adapter.prepareCall(provider, model)`，普通对象 adapter 必须自己实现（框架的 `LlmAdapter` 基类才有默认实现）。

另有两处 API 变化影响了测试而非产品代码：`commands.execute` 新增 `submittedAttachments` 参数（在 `signal` 之前）；工具结果在请求里是 `role: "tool"` 消息，不是 `"tool-result"` 内容块。

### 后续增强：goal 额外轮次已在插件内消除（未 fork goal 插件）

方案 B 带来一个已知代价：暂停的 agent 读作 `idle`，`goal-round-driver` 会判定它可续轮，多排入一轮 goal 消息。

**结论：不需要 fork `goal-round-driver`，也不需要新增 bundle 行。** 插件通过公开的 `ctx.goals` 服务即可阻断：

| 手段 | 效果 |
|---|---|
| `goals.disarm(agent)`（暂停时） | `activation: armed → disarmed`；`drivable()` 要求 `phase==="active" && activation==="armed"` → 不再排轮。**`phase` 保持 `"active"`** |
| `goals.resume(agent, ref)`（恢复时） | `activation → armed`，完整还原 |
| ~~`goals.pause()`~~ | **不用**：它会把持久 `phase` 改成 `"paused"`，那是用户可见的目标状态（goal 栏「已暂停的目标」），会话暂停不该改写用户的目标生命周期 |

实测（`probe` 与测试场景 J 双重确认）：

```
after disarm: {"phase":"active","activation":"disarmed"}
requests after disarm (期望 0): 0
after resume: {"phase":"active","activation":"armed"}
```

守卫与边界：
- 只用 `Map<agentId, {goalId, revision}>` 记录「本插件摘掉的」，id+revision 不符则不还原（用户期间编辑/替换 goal 就是用户的意图）。
- `agent/disposed` 时清理该 map，避免长进程泄漏。
- goal 服务未挂载 → `ctx.get("goals") === undefined`，整段跳过；无 goal → `goals.get()` 返回 `undefined`，跳过。
- `disarm`/`resume` 抛错只 warn，**不阻塞暂停**；最坏退化成「多一轮并在自身边界再停」。
- `/resume` 先校验 `agent.paused === true` 再还原 goal —— 否则一次无意义的点击会把已挂起的目标重新 arm。

新增测试场景 **J**（13 条断言）覆盖：goal 初始 armed → pause → phase 未变/activation 已清 → 暂停期间零 request 且 inbox 无残留 → resume → 重新 armed → 全周期最多一轮 goal 轮；另验证无 goal 的会话不会被凭空创建 goal。

**方案 B 的额外改动点**：`runMaintenance` 的 paused 分支使 PAUSE 改动点从 11 增至 **13**（另加 `get paused()` 访问器供 host 插件与 UI 判断相位）。`scripts/verify-fork.sh` 的 `EXPECTED_PAUSE_HUNKS` 已同步为 13。

**一句话**：这不是「小修补」，而是「把 fork 重新对齐到一个大版本之后的上游基线上」。好消息是暂停语义的改动点几乎全部能在新上游里找到原位锚点；坏消息是有三处导入符号被删除或迁移，插件目前是彻底加载不了的。


勘察时间：2026-11-15。目标部署：`@deepseek-ai/dsh@0.2.1-rc.5`（本机 `$DSH_HOME` = `/Users/909dl/.dsh`，profile = `web`）。

## 一、结论摘要

| 项 | 现状 | 判定 |
|---|---|---|
| fork 的 agent-loop | 基线 `0.1.0-rc.7`（1295 行），改动 11 hunk / +180 行 | 对齐目标 `0.2.1-rc.5`（2023 行），上游演进 34 hunk / +947 −219 |
| 当前插件在 rc5 下能否加载 | **否**。实测 `SyntaxError: '@deepseek-ai/dsh-agent' does not provide an export named 'Inbox'` | 必须修 |
| 暂停语义本身 | 11 个 PAUSE 改动点的宿主锚点 14/15 仍原样保留 | 语义可保留，搬运成本可控 |
| 宿主 API（投影注册） | `schema`/`view` 字段已改为 `stateSchema`/`wire` | 必须改 |
| 客户端 `useProjection` | 现有代码用「key + selector」双参数 | ✅ **无需改**（双参数仍受支持，官方 5 处在用；第一轮判断有误，见 3.1） |
| **客户端缺 `exports.inject`** | 既有隐患：并行激活竞态下 `ctx.get("slots")` 可能为 undefined → 静默不注册 | **必须修**（见 3.2） |
| bundle / patch 机制 | `dsh.bundle.patch`、`disabled`、`insert`、`name: 'pkg/subpath'` 均仍有效 | 无需改 |

## 二、不可回避的破坏性变更（必须先解决，否则插件根本起不来）

### 2.1 导入符号已消失（实测验证）

在依赖可解析的环境下直接 `import('./agent-loop.js')`，得到的第一个错误即：

```
SyntaxError: The requested module '@deepseek-ai/dsh-agent' does not provide an export named 'Inbox'
```

逐符号核验结果（✅ 可用 / ❌ 已移除）：

| fork 当前导入 | rc5 状态 | 处置 |
|---|---|---|
| `dsh-agent` → `Inbox` | ❌ | 上游已改为内部类 `ReactLoopInbox`（构造签名 `(projections, session, dispatch)`，不再是 `(session, {callbacks})`） |
| `dsh-agent` → `agentEvents` | ✅ | 保留 |
| `dsh-agent` → `assembleContextFor` | ✅ | 保留 |
| `dsh-agent` → `emitAgentEvent` | ✅ | 导出仍在，但**上游已不再调用它**：rc7 用 `emitAgentEvent(loopCtx, agent, "agent/session-start", {source})` 收尾 publish，rc5 把 `publish` 改成 `async` 并改为 `await loopCtx.agents.announce(agent, source, abort.signal)`，`agent/session-start` 事件在 rc5 与 `dsh-agent` 里都已**完全删除**（各 0 处引用）。这段属上游原样代码、不在任何 PAUSE 块内，按「整份照抄 rc5」会自动消失，**不需要手工处理**——但它是「照抄而非人工合并」这个策略必要性的第一个实证 |
| `dsh-llm` → `assertNever` | ❌ | 已迁至 `@deepseek-ai/dsh-util-values` |
| `dsh-llm` → `deepFreeze` | ❌ | 已迁至 `@deepseek-ai/dsh-util-values` |
| `dsh-settings` → `installSettingsSection` | ❌ | 旧 API 已从全仓移除（0 处存活用法）；**但功能未丢**，改用 `.volatile()` Config 字段承载，见 2.2 |
| `dsh-settings` → `settingsNamespace` | ❌ | 同上 |
| `dsh-session` → `SessionId` | ✅ | 保留 |
| `dsh-session` → `SessionPreparation` | ✅ | 保留 |
| `dsh-session` → `canonicalHeader` / `headerEquals` / `isReplacementSurfaceEvent` | ✅ | 保留 |
| `dsh-scope` → `createScope` | ✅ | 保留 |
| `dsh-system-prompt` → `joinContextSections` / `renderContextSections` / `renderPrompt` | ✅ | 保留 |
| `dsh-tools` → `TOOL_ABORTED_BEFORE_DISPATCH` / `TOOL_RUNTIME_SCHEDULER` | ✅ | 保留 |
| `@deepseek-ai/schemastery` → `z` | ✅ | 保留（但投影 schema 实际要用 **zod**，见 2.3） |

> **注意 `zod`**：rc5 的 agent-loop 同时导入 `schemastery`（配置 schema）与 `zod`（投影 schema）。插件当前 devDependency 写的是 `zod ^3.24.0`，而上游用的是 `zod 4.4.3`（`z.object` 等 API 在 v4 下语义有差异）。必须把 devDep 提到 v4。

### 2.2 设置集成被移除，但**不是功能回归**（此处结论已修正）

先给结论：**升级后 `maxParallelToolCalls` 仍然可以在设置面板里改，并且仍然热更新，用户无感。** 变的只是内部实现路径。

#### 变的是什么

rc5 的 agent-loop 中 `settings` 相关代码**一处不剩**（`grep -i settings` 为空）。对照：

| | rc7（fork 基线） | rc5 |
|---|---|---|
| 字段声明 | `static Config` 里 `maxParallelToolCalls: z.number()...default(10)` | 同字段，但多了 **`.volatile()`** |
| 分区注册 | `installSettingsSection(ctx, AGENT_LOOP_SETTINGS_NAMESPACE, AGENT_LOOP_SETTINGS_SCHEMA, entry, {validate, setSource, onChange})` | **无** |
| 值来源 | `source()` 间接读，`get maxParallelToolCalls() { return source().maxParallelToolCalls }` | `config.maxParallelToolCalls`，读取处写 `ctx.agentLoop.config.maxParallelToolCalls.get()` |
| 校验 | `resolveMaxParallelToolCalls`（3 处） | 无（靠 schemastery schema 自身 `.min(1)`） |

#### 为什么功能没丢

这是整个 settings 体系的**整体重构**，不是 agent-loop 一处被砍：

- `@deepseek-ai/dsh-settings` 的导出从「`installSettingsSection` + `settingsNamespace`」变成只剩 `{ SettingsConflictError, SettingsForms, default, redactSecrets }`。
- 全仓 `grep 'settingsNamespace('` 与 `installSettingsSection(` 都是 **0 处**——旧 API 被彻底删掉，连别的插件也没在用了。
- 新模型：`SettingsForms extends Service`（服务名仍是 `"settings"`），`static inject = ["configEditor", "profileContext"]`。它 **直接把插件的 `Config` schema 投影成表单**，`autoGenerate` 默认为 `true`（`presentations.get(...)?.auto ?? true`）；写入走 `update(ns, patch, rev)`，`ns` 就是 **profile 里的行 id**（注释原文：*Profile entry id*）。
- `.volatile()` 的语义（`dsh-settings` 的 `plainConfig`/`volatileForm`）：带该标记的字段被包成响应式对象，`isVolatile(value)` → `value.get()`；注释原文是 *editable without remounting*。**这正是「热更新」**。所以 `config.maxParallelToolCalls.get()` 是活值读取，改设置立即生效，无需重启。
- 设置面板包 `@deepseek-ai/dsh-client-ui-settings-agent-loop` **依然存在并挂载**（`dsh-web-app/cordis.patch.yml:446`），它 `ctx.configForms.get(AGENT_LOOP_NS)` 拿 `"agent-loop"` 命名空间——注意这里的 `AGENT_LOOP_NS` 是**客户端自己拼的字符串常量**，因为 *a client package must not depend on a Host package*。它还有 `ctx.configForms.whileServed([AGENT_LOOP_NS], ...)` 兜底：Host 不提供该命名空间时整块面板不显示。

#### 对本插件的实际动作

1. fork 里从上游复制的 `installSettingsSection(...)` 调用、`AGENT_LOOP_SETTINGS_NAMESPACE`、`AGENT_LOOP_SETTINGS_SCHEMA`、`resolveMaxParallelToolCalls` **全部删除**（照抄 rc5 骨架自动就没了）。
2. **必须保留** rc5 的 `.volatile()` 标记和 `config.maxParallelToolCalls.get()` 读取点——这是热更新的承载体，改回普通值会让设置面板的编辑静默失效。
3. 读该值的地方（fork 的 `runGroup`，第 179 行 `const { maxParallelToolCalls } = ctx.agentLoop.config;`）**必须改成 `ctx.agentLoop.config.maxParallelToolCalls.get()`**。这一处不在任何 PAUSE 块内，极易漏改。

   漏改的后果**比预想严重**（已实测）：拿到的是 volatile 包装对象而非数字，`inFlight.size < 对象` 恒为 `false`。而上游的 `fillPool` 里那个 `while` 是**唯一**的工具启动路径（无兜底分支）：

   ```js
   const fillPool = async () => {
     while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) { ... }
   ```

   于是循环一次都不进入 → **所有工具调用直接不执行**（实测：5 个调用启动 0 个），不是「并发降为 1」。表现为模型发出工具调用后没有任何结果回来、turn 静默停在 `blocked`/空转，且**没有任何报错**。必须列为验收重点。
4. README 不需要写「功能降级」。反而要写一句「本 bundle 支持的 `maxParallelToolCalls` 热更新依赖 `.volatile()` 语义」。

### 2.3 投影注册 API 签名变更

当前 `lib/index.js`（works，因为 `dsh-session-projection` rc7 时代就是这个形状）：

```js
{ key: "pause", schema: z.object({paused: z.boolean()}), init, apply, view: (state) => state, stateVersion: 1 }
```

rc5 的 `SessionProjectionRegistry.register(definition)` 只认：

```js
{ key, stateSchema, init(header, inheritedEventCount), apply, wire: { viewSchema, view }, stateVersion }
```

关键差异与后果：

1. **`schema` → `stateSchema`，`view` → `wire.view` + `wire.viewSchema`**。旧字段被静默忽略。
2. 后果不是「报错」，而是**静默降级**：
   - `snapshot()` / `cachedSnapshot()` / `viewCheckpoint()` 全部先判 `if (registration.def.wire === void 0) continue` —— `wire` 缺失时这个投影**永远不会被物化到 wire 值里**，客户端 `useProjection("pause")` 恒为 `undefined`，按钮永远不显示「继续」。
   - `restore()` 里 `def.stateSchema.parse(row.val)` **没有 try/catch**（对比 `viewCheckpoint` 有），`stateSchema` 为 `undefined` 会直接抛 `TypeError: Cannot read properties of undefined (reading 'parse')`，在恢复历史会话时炸掉。
3. 因此投影必须**同时**补齐 `stateSchema` 与 `wire`。官方范例（`dsh-api-session-controller` 的 `sessionListMetadata`）就是 `stateSchema` 与 `wire.viewSchema` 指向同一个 zod schema、`view: (state) => state`。

参考实现（rc5 中 `inboxProjectionDefinition`，注意它连 `stateVersion` 都是 1，和插件一致）：

```js
wire: { viewSchema: inboxProjectionSchema, view: (state) => state }
```

### 2.4 `turn/end` 的 `paused` 是「准合法」而非「合法」

`TurnEndReasonMap` 的注释明确写着 *Merge-extensible sum type* / *plugins extend it by merging variants into the map*，但：

- 运行期**没有** schema 校验（`dsh-session` 里搜不到 `reason.kind` 的字面枚举校验），所以写 `{kind:"paused"}` 能落盘。✅
- 所有消费方对未知 kind 都走 `default` 分支，且**语义安全**：

| 消费方 | 未知 kind 的行为 | 对暂停是否安全 |
|---|---|---|
| `dsh-agent` `accountsForClaim` | `default: return true`（视为「已消费输入」） | ✅ 正是暂停想要的 |
| `dsh-subagent` `epochStopReason` | `default: return "error"` | ⚠️ 若把 paused 用在 subagent 上会记为 error；插件已限制仅主会话显示按钮，可接受 |
| `dsh-acp` `turnEndToStopReason` | `default: "end_turn"` | ✅ |
| `dsh-session-query` `turnEndText` | `default: ""` | ✅ |
| `dsh-session-telemetry` | 仅 `error` 特殊，其余 `info` | ✅ |

- crash-repair 安全：`interruptedTurnClosers` → `openTurnClosers` 只对**未闭合**的 turn 补 closer。paused 已写入 `turn/end`，不会被改写。✅

**结论**：不需要改 `turn/end` 的表示法。但**必须在计划里明确记录**：`paused` 是 DSH 的扩展位，一旦上游把它纳入 `TurnEndReasonMap` 的正式成员（或加校验），需要复核。建议在 fork 头部注释里留下这条依赖。

### 2.5 `AgentStatus` 是封闭二元类型

`dsh-agent/lib/types/runtime-types.d.ts`：

```ts
export type AgentStatus = 'idle' | 'running';
```

注释写得很明白：「Disposal removes the agent from its registry; **it is not a third observable status**」。

fork 引入了第三种 `"paused"`。运行期无校验，实际消费方逐项核查：

| 消费方 | 写法 | 对 "paused" 的结果 |
|---|---|---|
| `dsh-api-session-controller:1948` | `status === "running"` | `false` → 推送 `running:false` ✅ |
| 同上 `:2992` | `status === "running"` | 同上 ✅ |
| `dsh-goal-round-driver:85` | `status === "idle"` | **`false` → 不驱动** ✅（暂停期间不自动续轮，正是设计意图） |
| `dsh-subagent:1301` `waitForChildren` | `status !== "idle"` | **`true` → 视为活跃**，`whenIdle()` 会挂住 ⚠️ |
| `dsh-subagent:1309` | `status !== "idle"` | 同上 ⚠️ |
| `dsh-subagent:2058` | `status === "idle" ? "queue" : "steer"` | 走 `steer` ⚠️ |
| `dsh-subagent:2552` | `status === "running"` | ✅ |

**风险点**：若一个被暂停的 agent 恰好是某个 parent 的 subagent（或反之），`waitForChildren` 会等不到 idle 而挂住。当前插件客户端已限制「subagent 窗口不显示暂停按钮」，但 host 侧的 `/pause` 命令是全局注册的，理论上仍可被施加到 subagent 上（例如通过命令面板）。

**处置建议（需决策）**：二选一
- A. **保持第三态**，但在 `/pause` handler 里显式拒绝 subagent（`if (agent.status === "paused" || ...)` / 检查是否 subagent），把风险关在入口处。
- B. **取消第三态**：paused 在 host 侧仍表现为 `"idle"`，只靠 `pause` 投影 + latch 表达状态。这样彻底绕开 `AgentStatus` 的类型约定与 `waitForChildren` 语义，代价是 `resume()` 需要另一个区分「paused-idle」与「真 idle」的内部标志（其实 `phase.kind` 已经能区分，只是不暴露给 `status` getter）。

我倾向 **B**：DSH 的类型注释把「不是第三种状态」写得很硬，跟着约定走能少踩未来的坑；而且 `goal-round-driver` 在 B 方案下会因为「看到 idle」而去驱动一个 paused agent —— 这需要额外验证，若确实会驱动，则回退到 A。

### 2.6 `Inbox` 的重构

- rc7：`Inbox` 来自 `@deepseek-ai/dsh-agent`，构造 `new Inbox(session, { inserted, discarded, claimed })`。
- rc5：本地类 `ReactLoopInbox`，构造 `new ReactLoopInbox(projections, session, dispatch)`，且投影状态来自 `ctx.sessionProjections`。

**这是个纯接口变更，非语义变更**：`ReactLoopInbox` 的公开方法集（`nextTurn` / `nextStep` / `hasPending` / `clear` / `claim` / `append` / `prepend` / `replace` / `remove` / `splice` / `locate` / `current` / `mutate`）覆盖了 fork 用到的全部调用（`splice` / `clear` / `hasPending` / `claim` / `nextStep.length`）。搬运时直接照抄 rc5 的类与构造即可，无需自己实现。

### 2.7 PAUSE 块自己引入的两个 API 需要复核（已验证可用）

fork 的 PAUSE 块用到 `this.loopCtx.sessions.flush(this.session)` 与 `this.loopCtx.logger.warn(...)`。这两处**在 rc7 与 rc5 的上游代码里都是 0 次引用**（上游只用 `this.ctx.logger`），属于 fork 自行引入的访问路径，因此在升级时必须单独确认，不能指望「照抄上游」覆盖到：

- `loopCtx` 就是 host Context（`createScope(loopCtx, this)`、`agentEvents(loopCtx, this)` 都用它），`ctx.sessions` 与 `ctx.logger` 都是标准服务/属性，可正常解析。
- `SessionStore.flush(session)` 在 rc5 中确实存在（`dsh-session/lib/index.js:1951`，`async flush(session)`）。✅
- 结论：这两处可原样保留。但建议在阶段 4 的用例 E 里顺带断言「paused 之后会话已落盘」（重开 SessionStore 读最后一条 `turn/end` 的 reason），把这条隐式依赖变成显式测试。

### 2.8 模块解析机制变了：`healProfilesModuleFallback` 已不存在（影响排障与设计文档）

`notes/design.md` 的「依赖契约」段落写着：

> 运行时解析依赖 DSH 安装目录的 flat fallback：Node 沿父目录向上找到 `$DSH_HOME/profiles/node_modules`，那里是安装依赖闭包每个包的 junction/symlink（由 `healProfilesModuleFallback` 在 boot 时维护）

**这段在 0.2.1-rc.5 已不成立**（实测：全部署 grep `healProfilesModuleFallback` / `profilesModuleFallback` / 任何向 `profiles/node_modules` 写链接的代码，**零命中**）。

现在的机制是**进程内模块解析拦截**：

| 环节 | 实现 |
|---|---|
| 安装拦截 | `installRuntimeInterception`（`dsh-app-boot:1846`），由 `PluginPackages` 在 `:3501-3507` 安装 |
| 登记闭包 | `createRuntimeResolution`（`:766-799`）把安装依赖闭包登记为 `scope: "installation"` 条目 |
| 路由 | `routeScoped`（`:1613-1675`）：先 profile 本地候选 → 再查 installation 表 → 命中则路由到安装实例 |
| 清理旧机制 | `removeLinkProjections`（`:637-646`）专门**删除** 0.1.5 时代的 link 投影 |

**结论没变，甚至更强**：fork 与上游确实共享同一份模块实例（拦截表实测 542 个 installation 条目，`dsh-agent`/`dsh-scope`/`dsh-llm`/`dsh-tools`/`cordis`/`zod` 全在表内）。但**理由和诊断路径必须改**，否则以后出问题会照着 design.md 去找一个不存在的函数。

**风险提示（本机特有）**：`/Users/909dl/.dsh/profiles/node_modules` 这份遗留 symlink 指向 8 月的 `_npx/1e7f6d9597241db0`，与当前部署（11 月的安装目录）是**两份不同的物理拷贝**（版本号同为 rc.5 但 `realpath` 不同）。正常 boot 下拦截表会把这些纠正到安装实例，所以运行时安全；但**脱离 boot 的脚本**（包括 `scripts/relink.ps1`）会拿到另一份 —— 正是 design.md 记录的 `kScope` symbol 分裂事故的复现条件。

**动作**：
1. 重写 design.md 该段落（结论保留，机制改述）。
2. `scripts/relink.ps1` 视为过期：它固化的正是那个旧 npx 路径，且是 Windows 专用。阶段 0 要写 POSIX 版时，应指向**当前安装目录**或改用 `--dump-config-schema` 静态度量。
3. 考虑在 `test/dependency-contract.mjs` 里补一条 cordis `Service` 身份断言（现有 `scopeOf` 断言是同类问题的第一道防线）。

### 2.9 不要加 `peerDependencies`——现在有第二重惩罚

`notes/design.md` 已写「不要声明为 peerDependencies」。0.2.1-rc.5 让这条更严格：

`evaluatePluginCompatibility`（`dsh-app-boot:311-330`）在有 `peerDependencies` 时会逐条比对 `@deepseek-ai/dsh*` 范围（`includePrerelease: true`）。**不满足时整个 bundle 进 `skippedBundles`，只在 stderr 打一行 `skipping profile bundle`。**

实测：把 devDeps 提为 peers（`^0.1.0-rc.6`）后对 `0.2.1-rc.5` 不满足 → 整包被跳过。

**现状（`dependencies` 空 + 无 peers + 无 engines）在兼容性预检上是「永不拦」，保持即可。** 若想加 `engines.dsh`，`">=0.1.0-rc.6"` 实测 compatible，但没必要。

### 2.10 其他需要跟随的上游内部变更

| 变更 | rc7（fork 基线） | rc5 | 影响 |
|---|---|---|---|
| 构造里 `this.ctx` | `this.scope.ctx.extend({ agent: this })` | `this.scope.ctx` | 直接照抄上游 |
| 构造里 `lastTurn` 来源 | `session.events.findLast(turn/start)` | `loopCtx.sessionProjections.stateOf(session,"turnBoundary")?.lastTurn ?? 0` | fork 的「重启恢复」要改成读投影 |
| `Service.inject` | 5 项 | 6 项（多 `sessionProjections`） | 照抄 |
| `static Config` | 无 `reasoningEffort`、`maxParallelToolCalls` 无 `.volatile()` | 有 `reasoningEffort`、`maxParallelToolCalls` 带 `.volatile()` | 照抄 |
| `wakeDriver` 非 idle 分支 | `this.phase.abort.signal.reason?.kind !== "disposed"` | `abortedCancelCause(this.phase.abort.signal)?.kind !== "disposed"` | **fork 的 PAUSE 补丁锚点唯一失配处**，需在新表达式上加 `&& this.phase.kind !== "paused"` 守卫 |
| `interruptedTurnClosers` | 无 | 恢复会话时先补 closer | 与 paused 正交，无需改 |
| `publish` 生命周期 | 同步，末尾 `emitAgentEvent(...,"agent/session-start")` | **`async`**，末尾 `await loopCtx.agents.announce(agent, source, abort.signal)`；`agent/session-start` 事件整个删除 | 属上游原样代码，照抄即自动对齐 |
| 导出 | `AgentLoop, default, CONFIGURED_AGENT_IDENTITIES_KEY, DEFAULT_MAX_PARALLEL_TOOL_CALLS, turnBoundaryProjectionDefinition` | 同 rc7（未变） | 无需改 |

> **这条表说明了一件重要的事**：上游在 rc7→rc5 之间不只是「加功能」，还删了事件（`agent/session-start`）、改了 `publish` 的同步性、改了 `kick`/`wakeDriver` 的内部判定函数（`abortedCancelCause`，rc7 中为 0 处）。这些**都不在** 11 个 PAUSE 块里，但都足以让 fork 失效。因此阶段 1 必须**以 rc5 整份文件为底本重新贴 PAUSE 块**，绝不能拿现有 fork 做三方人工合并——后者会把这些删除/改写漏掉，产出「能加载但行为诡异」的文件。

## 三、客户端侧变更

> **本节结论经过两轮勘察，第一轮的三条判断有误，已全部推翻重写。**
> 第一轮的方法学错误值得记录：为了判断「`useProjection` 是否还接受 selector」，我用了 `grep -P` 并加了 `2>/dev/null`。macOS 自带的是 BSD grep，**不支持 `-P`**，命令以退出码 2 失败、无输出，而 `2>/dev/null` 把报错吞掉了——于是「命令失败」被我读成了「没有匹配」。据此写下的「全仓无双参数调用」是彻底的误判。
> 教训：**只要 grep 带 `2>/dev/null`，就必须同时检查退出码**；BSD grep 下应改用 `-E`。

### 3.1 `useProjection` 双参数**仍然合法**，现有写法正确（结论反转）

当前 `lib/client.js:119` 的写法**不需要改**：

```js
const paused = useProjection("pause", (value) => value?.paused === true) ?? false;
```

证据：

- 类型定义有双重重载（`dsh-api-session-controller/lib/types/client/sessions/projection-store.d.ts:28-32`）：`<K>(key): V | undefined` 与 `<K,S>(key, selector, eq?): S`——第三参数是可选的自定义相等比较。
- 运行时有 `keyedObservableHook` / `keyedHookCall` 支持（`dsh-client-ui-renderer/lib/client.js:245-264`、`:277-300`）。
- **官方自己就在用双参数**（用 `grep -E` 正确复核，共 5 处）：`ui-conversation:18969` `useProjection("plan", (plan) => ...)`、`:18970` `useProjection("goal", (goal) => goal != null)`，以及 `userQuestions`(2 处)、`inbox`(1 处)。
- 末尾 `?? false` 的兜底仍然必要（键缺失时返回 `undefined`），现有代码已经正确。

**这一条从「必须改」降级为「无需改」。**

### 3.2 真正的致命项：客户端模块缺少 `exports.inject` 声明

`lib/client.js:210-213` 目前只导出了两个符号：

```js
module.exports.apply = apply;
module.exports.name = "session-pause";
```

**缺少 `module.exports.inject`。** 这不是风格问题，会导致静默失效：

1. `ClientEntries.start` 用 `Promise.all` **并行**激活所有 entry（`dsh-client-modules/lib/client.js:391-395`）。
2. 没有 `inject` 声明时，cordis 的 `Fiber` 不会等待服务就绪（`cordis/lib/index.js:1635` 的 `Inject.resolve(plugin.inject)` 拿到的是空集）。
3. 而插件的 `apply` 第一句就是硬早退：

```js
const slots = ctx.get("slots");
if (slots === void 0) return;        // ← 竞态落错边就什么都不注册
```

4. 结果：**槽位一个都不注册、按钮不出现、`sessionsService` 可能是 `undefined` 使命令恒 no-op，全程零报错**。

所有官方客户端包都导出它（`ui-plan:605`、`ui-goal:558`、`ui-commands:2055`、`ui-approval:275` 等），不是为了好看。

**改动**：

```js
const inject = ["slots", "sessions", "locale"];
module.exports.inject = inject;
module.exports.apply = apply;
module.exports.name = "session-pause";
```

> 这是**当前代码就有的既有隐患，不是升级引入的**；但升级正好是修掉它的时机。注意 `locale` 在 `apply` 里是可选的（有 `if (locale !== void 0)` 和静态 fallback），若不想让 fiber 等它，可从 inject 里去掉、保留可选读取——**但 `slots` 与 `sessions` 必须声明**。

### 3.3 槽位与布局

**槽位兼容**：`conversation.input.right` 仍是 `{ kind: "list", scope: "session" }`（`ui-conversation:20116`），仍是渲染点（`:19278`），summary 为 *Compact controls before the composer submit action.*，`replaceRisk: "none"`。

**布局常量：宽屏正确，窄屏偏 4px。**

| 断言 | 结论 |
|---|---|
| 主按钮 34px | ✅ `.uV2eYG_primary{...width:34px;height:34px;transform:translateY(-2px)}`（`:18901`） |
| 行右内边距 8px | ✅ `.uV2eYG_row{...padding:2px 8px 6px;...}` |
| `.card` 是 `position:relative` | ✅ |
| trailing gap 12px | ⚠️ **默认 12px，但 `@container (width<=560px)` 下变 8px** |

窄屏（容器 ≤560px）时正确值应是 `calc(34px + 8px + 8px)` = 50px，而插件恒用 54px，**按钮与主按钮间隙会比预期多 4px**。不影响可用性，属视觉瑕疵。

处置：`PAUSE_RIGHT_OFFSET` 保持 `calc(34px + 12px + 8px)`（宽屏主流场景正确），另加一条 `@container (width <= 560px)` 覆盖为 `calc(34px + 8px + 8px)`；或至少在常量旁注释说明这 4px 的已知偏差。

**新发现的冲突（原勘察遗漏）**：`conversation.input.right` 与主按钮之间还夹着 `conversation.input.activity` 槽位（当前 occupant 是语音输入 VoiceInput）。插件用绝对定位把按钮钉在 `right:54px`，**语音输入出现时会被盖住**。需要在真机上验证，并在 README 记明该冲突；若确认遮挡明显，考虑改挂载点或在该 occupant 存在时让位。

另一个已排除的风险：`interruptible` 分支（`:19287`）确实会多渲染一个 `.primary`，但主会话满足 `subagent === null` → `continuable === false`（`:19016`、`:19148`），故恒只有一个 primary，`right:54px` 不会错位。

### 3.4 `dsh.client.inject` 四件套：两个写错了（不致命，但应修）

`package.json` 现在声明：

```json
"inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-locale"]
```

| 声明 | 实际 |
|---|---|
| `dsh-client-connection` | ✅ 存在 |
| `dsh-client-locale` | ✅ 存在，且确实 `provide("locale", ...)` |
| `dsh-client-runtime` | ❌ **部署里没有这个包**（`profiles/node_modules` 下是断链 symlink） |
| `dsh-client-ui-slots` | ❌ 不是可注入包，是 shell 的 seed word；真正 `super(ctx, "slots")` 的是 `dsh-client-ui-renderer` |

语义澄清（关键）：`dsh.client.inject` 是**包→包的图行依赖边，不是 Cordis 服务注入**（`dsh-package-manifest/lib/types/types.d.ts:79` 原文：*Informational package-name dependencies, not Cordis service injection*）。图上找不到的 id 会被**静默跳过**（`dsh-client-modules/lib/client.js:789-792`），所以这两条既不报错也不起作用。

建议改为：

```json
"inject": ["@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-locale"]
```

不阻塞运行，但错误声明会让 HMR prune 的可达性计算（`client.js:941-947` 沿 `row.inject` 保留）滞留无用模块。

### 3.5 其余客户端 API：全部兼容

| API | 结论 |
|---|---|
| props `useSession` / `useProjection` / `sessionId` / `t` | ✅ 全在。前三个来自 `standardProps`（`ui-renderer:668-676`、`:680-701`）与 BUILTIN_SOURCE（`ui-session:755-762`）；`t` 由 `entry.locale` 注入（`ui-renderer:742-746`） |
| `SessionSnapshot.running` / `.subagent` | ✅ 仍在（`snapshot.d.ts:62-67`） |
| `ctx.get("sessions")` → `binding(id).session.command(line)` | ✅ 兼容。`binding()` 只借用已保留的 binding，未保留返回 `undefined`——插件 `:136-138` 已有守卫，且该槽位仅在 session 已绑定时渲染，稳健 |
| `slots.inject(key, cb)` / `slots.register({name,id,order,locale}, Comp)` | ✅ 兼容，`locale` 原样入 entry |
| `locale.register(ns, {zh:{},en:{}})` / `locale.bind(ns)` | ✅ 兼容。**新增约束**：同 ns 同 locale 二次注册会 throw（`dsh-client-locale:1398`）；建议 NS 用包名派生串降低 HMR 撞名风险 |
| `ctx.effect(fn, label)` | ✅ 兼容（`cordis/lib/types/fiber.d.ts:157`） |
| 运行时自注入 `<style data-plugin>` | ✅ 就是官方机制，无需改。`dsh.client` 清单**没有** css 字段；官方自己也这么做（`ui-conversation:4166-4171`、`:13587-13592`）。插件的 `dataset.plugin = "dsh-session-pause"` 恰等于包名，与 `removeOwnedStyles` 的比较口径一致 |

### 3.6 bundle / patch 装配机制：已逐条验证仍有效

权威实现是 `dsh-app-boot/lib/index.js:63-110` 的 `applyEntryPatches(data, patches, warn)`，不是 CLI 也不是 loader。逐条对照本插件的 `cordis.patch.yml`：

| 本插件写法 | rc5 语义 | 结论 |
|---|---|---|
| `- id: agent-loop` + `disabled: true` | 非 insert 分支要求 `id` 必填；`overrides` 逐键执行 `target[key] = value` | ✅ `disabled: true` 会被写成该行属性 |
| 同上**不带** `name` | `if (name && name !== target.name) { warn; continue; }` —— 带 name 就是**校验**，不符则整块跳过 | ✅ 本插件正确地没写 name；若当初写了 name 反而会因字符串不等而静默失效 |
| 顶层 `- insert:`（无 id） | `else data.push(...insert)` | ✅ 合法，追加到顶层 |
| `insert` 里的 `name: 'dsh-session-pause/agent-loop'` | 逐字保留，由 loader 按包名+子路径解析 | ✅ 依赖 `package.json` 的 `exports["./agent-loop"]`（已声明） |
| 插入后能否被同列表后续 patch 命中 | `buildMap(insert)` —— 插入项立即入索引 | ✅ |

补充：

- 层顺序为 `dsh.profile.bundles` 数组顺序 → profile 用户层 → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖（`profile-boot:224-232`）。本插件的 bundle 排在 `@deepseek-ai/dsh-web-app` 之后，因此它禁用的 `agent-loop` 行已存在，patch 能命中。
- **踩坑提醒**：`insert` 带 `id` 时语义完全不同——它会 `target.config.push(...insert)` 且要求 target 是 `group`。本插件用的是**无 id 的顶层 insert**，是对的。将来若想往某个 group 里塞行，别把这条顶层 insert 改成带 id 的形式。
- 验证手段：`dsh --profile web --dump-config`（输出即真实启动的树）。**注意本沙盒写不了 `~/.dsh`，会 `EPERM`，此步需在普通终端执行**（见阶段 5）。

## 四、测试套件适配

| 文件 | 现状 | 需要 |
|---|---|---|
| `test/pause-loop.mjs` | 已 import `@deepseek-ai/dsh-commands`、`@deepseek-ai/dsh-session-projection`，且用 `snapshot(...).values.pause?.paused`（新 API） | devDeps **缺这两个包**；`package.json` 需补 |
| `test/dependency-contract.mjs` | 只扫描 `lib/*.js` 三个文件 | 扫描范围不变即可，但 devDeps 变更后要复核断言仍通过 |
| `test/api-smoke.mjs` | 依赖 `127.0.0.1:3199` 的隔离实例 | 端口/实例需在升级后重建 |
| `test/e2e-create.mjs` | 未细查 | 同 api-smoke |
| ~~新增建议~~ | 已落地 | `test/client-manifest.mjs`（见下）。另建议补一条「fork 导入的符号必须都能从对应包解析出来」——正是 `Inbox` 那个坑的自动防线 |

**新增测试（本次勘察已写好，见 `test/client-manifest.mjs`）**：

静态断言客户端契约，专抓「静默失效」类问题：

| 断言 | 防的是什么 |
|---|---|
| `lib/client.js` 导出 `inject` | 缺失则并行激活竞态下 `ctx.get("slots")` 为 undefined → 静默不注册（3.2） |
| 每个必需的 `ctx.get(x)` 都在 `inject` 里 | 依赖了服务却不告诉 loader 等待（`locale` 因有可选守卫可豁免） |
| `dsh.client.inject` 不含 shell seed word | `dsh-client-ui-slots` 不是包（3.4） |
| `dsh.client.inject` 每项能在部署里解析 | `dsh-client-runtime` 根本不存在（3.4） |
| 模块 id == 包名 | 运行时 `<style>` 归属靠它比较 |

已实测其区分能力：对**当前代码**跑 → 3 项失败（精确指向 M1/M2）；在副本上修好那三项 → 全绿 exit 0。也就是说它不是「永远失败」的假测试。

**开发环境（本地跑测试）**：`scripts/relink.ps1` 是 Windows 专用、指向他人机器路径 `C:\Users\cwtan\...`，在 macOS 上不可用。

**但不要简单照抄它的思路**：它固化的是指向 8 月 `_npx` 实例的旧路径，而 0.2.1-rc.5 已改用进程内解析拦截表，`$DSH_HOME/profiles/node_modules` 那份遗留 symlink 与当前安装是**两份物理拷贝**（2.8）。POSIX 版应指向**当前安装目录**：

```bash
ln -s /Volumes/DL909-TiPlus7100/.cache/npm/global/lib/node_modules/@deepseek-ai/dsh/node_modules node_modules
```

否则测试里会拿到另一份 `dsh-scope`，`scopeOf` 断言会以「双重实例」的假阳性失败，反而掩盖真问题。

## 五、执行计划

### 阶段 0：建立可运行基线（0.5–1 天）

1. 新建分支 `upgrade/0.2.1-rc5`。
2. 写 POSIX 版 `scripts/relink.sh`，把 `node_modules` 指向 `$DSH_HOME/profiles/node_modules`（本机已验证该目录含 `0.2.1-rc.5` 全套依赖，且 `import('@deepseek-ai/dsh-agent-loop')` 可解析）。
3. 补 devDeps：`@deepseek-ai/dsh-commands`、`@deepseek-ai/dsh-session-projection`、`@deepseek-ai/dsh-util-values`；`zod` 提到 `^4.4.3`；所有 `@deepseek-ai/*` 升到 `0.2.1-rc.5`；`cordis` 到 `~4.0.5`。
4. **验证**：`node test/dependency-contract.mjs` 仍通过（此时 fork 还未升级，会因 `Inbox` 失败——这是预期的第一步红灯）。

### 阶段 1：重放 fork（核心工作，2–3 天）

做法：**以 rc5 的 `lib/index.js` 为唯一底本，重新贴 11 个 PAUSE 块**，而不是在三方 diff 里人工合并。

1. `cp /tmp/upl/rc5/package/lib/index.js lib/agent-loop.js`。
2. 按 2.10 的表把 `Inbox` → `ReactLoopInbox`、`ctx` 构造、`lastTurn` 来源、`Service.inject`、`static Config`、`wakeDriver` 的 `abortedCancelCause` 全部按**上游原样**保留（不做任何改动，这些不是 PAUSE 块）。
3. 逐块贴回 PAUSE 改动，共 11 处（锚点已逐条验证 14/15 仍精确存在）：
   - ① 构造：`paused` 相位恢复 + `pauseRequested`/`pauseDone` 字段
   - ② `get status()`：第三态（若采纳 2.5-B 则此块改为不引入第三态）
   - ③ `send()`：`wakingAfterAbort` 加 `phase.kind !== "paused"` 守卫
   - ④ `cancel()`：disposed 结算 latch + paused 相位回 idle
   - ⑤ `startDriver()` 抽取 + `pause()` / `pauseCancel()` / `resume()`
   - ⑥ `wakeDriver()`：paused 直接 return
   - ⑦ `kick()` finally：settledPaused 分支（含 `sessions.flush`）
   - ⑧ `turn()`：空输入保护加 `resumePending !== true`
   - ⑨ `turn()`：`step/start` 前消费 `resumePending`
   - ⑩ `turn()`：turn-stopping 前设 `turnEnds={kind:"paused"}`；其后 `if (turnEnds?.kind==="paused") break`
   - ⑪ `turn()` 尾部：latch armed 时不 roll into next turn
4. 删除 settings 相关全部代码（`installSettingsSection` / `settingsNamespace` / `AGENT_LOOP_SETTINGS_NAMESPACE` / `AGENT_LOOP_SETTINGS_SCHEMA` / `resolveMaxParallelToolCalls`）。**注意这不是功能删减**，见 2.2。
5. 改 import：`assertNever`/`deepFreeze` → `@deepseek-ai/dsh-util-values`；去掉 `Inbox`；去掉 `dsh-settings`。
5c. **补强 `cordis.patch.yml` 注释（不改结构，只改理由）**：现有注释写「Both rows publish the same `agentLoop` service, so the stock row must be disabled」——结论对，但没说出**为什么必须**。真实原因是 cordis 的 `provide` 在服务名已注册时**直接抛错**（`cordis/lib/index.js:813`：`throw new Error('service "agentLoop" has been registered at ...')`），两行同时发布同名服务必然一行 FAILED。把这句换成抛错事实，避免将来有人以为「可以省掉 disabled」。
   同时补一条警告：**本 bundle 禁用了白名单里的 `agent-loop`，而插入的 `agent-loop-pause`/`session-pause` 都不在 `requiredStartupEntryIds` 里** → 本插件 import 失败时 `dsh web` 仍会正常启动、只打 warn。这条注释是给未来排障者最重要的线索（详见 5.0）。
5b. **静默回归检查（最易漏，且后果最重）**：`runGroup` 里 `const { maxParallelToolCalls } = ctx.agentLoop.config;` 必须改成 `ctx.agentLoop.config.maxParallelToolCalls.get()`。漏改**不报错**，但会让**所有工具调用都不执行**（`inFlight.size < 对象` 恒 false，`fillPool` 的 while 一次都不进）。验收方式：跑一个需要连续调工具的任务（如读文件→改文件），确认工具结果正常回填。
6. 更新 fork 头部注释：基线版本号写 `0.2.1-rc.5`；补两条「外部约定依赖」——`turn/end` 的 `paused` 依赖 `TurnEndReasonMap` 可扩展、`AgentStatus` 第三态依赖各消费方 `default` 分支。
7. **验证**：`node -e "import('./lib/agent-loop.js')"` 必须无 SyntaxError。
8. **关键验收门槛——已备好可执行工具**：`scripts/verify-fork.sh`（本次勘察新增）。它按 hunk 判定：每个 diff hunk 里只要出现 `PAUSE` 就算「已文档化」，任何不含 PAUSE 的 hunk 都是「未文档化漂移」并以非零退出码失败。

   ```bash
   npm pack @deepseek-ai/dsh-agent-loop@0.2.1-rc.5 && tar xzf deepseek-ai-dsh-agent-loop-0.2.1-rc.5.tgz
   ./scripts/verify-fork.sh package/lib/index.js
   ```

   已在真实数据上做过三项回归（勘察时实测）：

   | 用例 | 输入 | 期望 | 实测 |
   |---|---|---|---|
   | 正向：fork vs 它自己的基线 rc7 | `rc7/package/lib/index.js` | 全绿、11 hunks | ✅ `PAUSE hunks: 11 (documented: 11)`，exit 0 |
   | 反向：fork vs 目标 rc5（未迁移） | `rc5/package/lib/index.js` | 报漂移、失败 | ✅ `UNDOCUMENTED hunks: 26`，exit 1 |
   | 管道：`... | tail -3` | 退出码不被吞 | ✅ 仍 exit 1（内部用状态文件而非 `$?`） |

   阶段 1 完成的判据：这个脚本对**新 rc5 基线**必须输出 `PAUSE hunks: 11` 且零 UNDOCUMENTED，退出码 0。这一步把「照抄 + 重贴」从主观判断变成了可自动化的硬门槛。

### 阶段 2：修 host 插件（0.5 天）

`lib/index.js`：
1. 投影定义改为 `stateSchema` + `wire: { viewSchema, view }`，schema 用 **zod**（不是 schemastery）。
2. `commands.register` 补 `definitionId`（官方惯例，如 `CommandDefinitionId("@deepseek-ai/dsh-session-pause")`），并确认 `handler` 返回值仍是 `{kind:"success"|"error", text}`（`normalizeResult` 校验，未变）。
3. 按 2.5 的决策 A/B 处理 subagent 防护。
4. 顺手：`/resume` handler 里 `agent.resume()` 若在非 paused 会 **throw**（fork 里 `if (this.phase.kind !== "paused") throw`），当前代码已 try/catch，但会给用户报错文案；建议改成先判 `agent.status` 再调用，把「没在暂停」变成友好提示。

### 阶段 3：修客户端（0.5 天，比原估计少）

1. **补 `exports.inject`（本节最重要，见 3.2）**：`module.exports.inject = ["slots", "sessions", "locale"]`。这是修一个**既有的静默失效隐患**，不是升级引入的。
2. **不要动** `useProjection("pause", selector)`——现有双参数写法正确（3.1，结论已反转）。
3. `package.json` 的 `dsh.client.inject` 改为 `["@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-locale"]`，删掉不存在的 `dsh-client-runtime` 与非包的 `dsh-client-ui-slots`（3.4）。
4. `PAUSE_RIGHT_OFFSET` 宽屏值保持 `calc(34px + 12px + 8px)`；追加 `@container (width <= 560px)` 覆盖为 `calc(34px + 8px + 8px)`（窄屏 gap 由 12 降为 8，见 3.3）。
5. 真机验证语音输入（`conversation.input.activity`）出现时是否被暂停按钮遮挡（3.3 的新发现冲突）。
6. 顺手：`locale` NS 改用包名派生串，规避同 ns 二次注册 throw（3.5）。

### 阶段 4：测试（1–2 天）

1. 跑 `test/pause-loop.mjs`（A/B/C/D 四个用例）全部通过。
2. 跑 `test/dependency-contract.mjs`（含 `scopeOf` 运行时探针，验证没有双份模块实例）。
3. `test/api-smoke.mjs` / `test/e2e-create.mjs`：在 rebuild 的 3199 隔离实例上跑。
4. **新增用例 E（必加）**：投影 wire 值可被读到——断言 `root.sessionProjections.snapshot(session).values.pause` 存在且为 `{paused:true/false}`。这是 2.3 那个「静默降级」的直接回归防线。
5. **新增用例 F（建议）**：把 paused agent 当作 `waitForChildren` 的 child，确认不会挂死（对应 2.5 的风险）。若挂死则说明必须走 2.5-A。

### 阶段 5：真机验证（0.5 天，需在沙盒外执行）

> ⚠️ **本节的核心陷阱：`dsh web` 启动成功 ≠ 插件生效。** 详见 5.0。

#### 5.0 必须知道的「静默全盘失效」链路（已实测确认）

本插件的装配方式恰好绕过了 DSH 的两道 fail-loud 保险，最坏情况会「看起来一切正常但完全不能用」：

| 环节 | 实测事实 | 位置 |
|---|---|---|
| 启动审计只对白名单报错 | `required.size > 0` 才 `throw new StartupError`；否则仅 `warn(activationDiagnostic(...))` | `dsh-app-boot/lib/index.js:4464-4474` |
| 白名单里**有** `agent-loop` | `requiredStartupEntryIds` 含 `"agent-loop"` | 同上 `:4270-4279` |
| 但**没有**我们插入的两个 id | `agent-loop-pause` → 0 次；`session-pause` → 0 次 | 实测 grep 该 Set |
| disabled 行直接跳过、不算失败 | `if (entry.disabled) continue;` | 同上 `:4338` |
| 服务重复注册会抛错 | `throw new Error('service "agentLoop" has been registered at ...')` | `cordis/lib/index.js:813` |

**推论（这是升级后最可能踩的坑）**：

1. 原 stock `agent-loop` 被 `disabled: true` → 它**不再算失败**，白名单检查放过。
2. 我们插入的 `agent-loop-pause` 若 import 失败（例如 ESM 链接期报 `does not provide an export named 'Inbox'`）→ 它的 id **不在白名单** → 只 warn。
3. 净结果：`agentLoop` 服务无人提供 → **所有 agent 会话不可用**，而 `dsh web` 照常启动、`--dump-config` 照常输出正确文本、无任何致命报错。

**因此阶段 5 的验证必须显式断言服务真实存在**，不能只看「启动成功」或「dump-config 输出对不对」。

#### 5.1 安装

```bash
dsh plugin --profile web add /Volumes/.../js/dsh-session-pause
```

无需手改 profile 的 `package.json`：`dsh plugin add` 成功后会自动把**本次新增**且声明了 `dsh.bundle.patch` 的依赖 push 进 `dsh.profile.bundles`，并预校验 patch 文件（`dsh-plugin-manager/.../operations.js:497-542`、`:96-121`）。
两个坑：① 只有「本次新增」才会入列，若包已装但 bundles 未列，需先 remove 再 add；② 包若没有 `dsh.bundle` 会只打一行 `installed as a plain dependency, not a profile layer` 后跳过。

#### 5.2 patch 文本层验证（能自动 grep，但只证明文本对）

```bash
dsh --profile web --dump-config 2>/tmp/warn.txt > /tmp/dump.yml
grep -A6 '^- id: agent-loop$' /tmp/dump.yml        # 期望出现 disabled: true
grep -A3 '^- id: agent-loop-pause$' /tmp/dump.yml  # 期望 name: dsh-session-pause/agent-loop
grep -c 'patch: entry "agent-loop" not found' /tmp/warn.txt   # 期望 0
```

注意：
- patch **没命中**的警告走 stderr（格式 `dsh: [<layer>] patch: entry "X" not found`），比看 stdout 更直接。
- `--dump-config` **会重写 profile 的 `cordis.yml`**（`profile-boot:216-222` 末尾无条件 `writeFileSync`，幂等但 mtime 会变）。严格只读场景用 `--dump-default-config`（跳过 profile/home/overlay 层）。
- 本机 profile 自身有 6 条历史 not-found 警告（`drop-caret`、`cost-meter` 等），断言时按 layer label 过滤，别只看总数。
- 层序比想象多一层：bundle 层 → profile patch → **`$DSH_HOME/cordis.patch.yml`（home 级）** → `--patch` → telemetry。home 层能盖掉 profile 层（当前本机无此文件）。

#### 5.3 服务层验证（关键，必须做）

启动后显式确认 `agentLoop` 服务存在、且我们的行是 ACTIVE 而非 FAILED：

```bash
# 启动后看日志有没有导入失败
grep -i "does not provide an export\|agent-loop-pause.*fail" $DSH_HOME/logs/*.log

# 正向确认：/pause 命令已注册（命令表里有它）
# 或直接发一条消息，确认 agent 能跑起来（agentLoop 存在的最直接证据）
```

**通过标准**：能正常创建会话并跑完一轮对话。若 `agentLoop` 缺失，新会话根本起不来 —— 这是最容易识别也最容易被「启动成功」掩盖的信号。

#### 5.4 功能冒烟

发一条带工具调用的消息 → 点暂停 → 观察「排干后进入暂停」→ 刷新页面（验证投影持久）→ 重启 dsh（验证 paused 恢复）→ 点继续 → 确认从工具结果尾续答。

**额外必测项**：跑一个需要**连续调多个工具**的任务（读文件→改文件），确认工具结果正常回填。这一条同时验证了三件事：`.get()` 没漏改（2.2）、工具调度正常、fork 的 `runGroup` 迁移正确。

#### 5.5 UI 细节验证

- 语音输入（`conversation.input.activity` occupant）出现时，暂停按钮是否被遮挡（3.3）。
- 窄屏（容器 ≤560px）下按钮与主按钮的 4px 偏差是否可接受（3.3）。

#### 5.6 回归

确认「新建会话」不报 `agent-presets: refusing to compose an unscoped context`（这是 dependency-contract 防的历史 bug）。

#### 5.7 注意：改 patch 后必须重启

profile 里的 `"patchReload": "live"` 是**死配置**（全部署 grep 零命中）。热重载实际由 `dsh-hmr` 硬编码监听 `[profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)]` —— **bundle 自带的 `cordis.patch.yml` 不在监听列表内**，改它后必须重启 `dsh web`。


> 本沙盒只允许写 session workspace，`dsh --dump-config` 会因写 `~/.dsh/profiles/web/cordis.yml` 而 `EPERM`。这一步必须在普通终端里做。

1. 装插件：`dsh plugin --profile web add /Volumes/.../dsh-session-pause`（或 `pnpm add link:`）。
2. `dsh --profile web --dump-config`，确认：`agent-loop` 行 `disabled: true`、出现 `agent-loop-pause` 与 `session-pause` 两行。
3. `dsh web` 启动，检查启动日志无 module resolution / 导出缺失错误。
4. UI 冒烟：发一条带工具调用的消息 → 点暂停 → 观察「排干后进入暂停」→ 刷新页面（验证投影持久）→ 重启 dsh（验证 paused 恢复）→ 点继续 → 确认从工具结果尾续答。
5. 回归：确认「新建会话」不报 `agent-presets: refusing to compose an unscoped context`（这是 dependency-contract 防的那个历史 bug）。

### 阶段 6：文档与发布（0.5 天）

1. 更新 `notes/design.md`：settings 集成被移除（含 `.volatile()` 热更新链路的说明，**不是功能回归**）、`TurnEndReasonMap` 扩展位约定、`AgentStatus` 第三态的风险与决策。
2. 更新 `README.md` / `README.en.md`：注明支持的 DSH 版本 `0.2.1-rc.5`；写明 `maxParallelToolCalls` 仍可在设置面板热更新，但依赖 `.volatile()` 语义，fork 不得改回普通值。
3. `package.json` version 提到 `0.2.0`（因为不再兼容 0.1.x 系列）或 `0.1.1`（若想保守）。

## 六、风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| PAUSE 块在 rc5 的 turn() 里落点失配（尤其 `turn-stopping` 前后） | 中 | 暂停语义错误（如暂停时多跑一步） | 阶段 1 步骤 8 的「除 PAUSE 外零差异」diff 检查必须严格通过 |
| `AgentStatus` 第三态导致 subagent 等待挂死 | 中 | 子代理调用卡住 | 采纳 2.5 的 A 或 B；阶段 4 用例 F |
| 投影 wire 缺失 → 客户端按钮永不出现（静默） | 高（若不改） | 功能完全不可用且无报错 | 阶段 2 必改；阶段 4 用例 E |
| **`.get()` 漏改 → 所有工具调用不执行（静默）** | **中高（极易漏）** | 模型发工具调用后无结果返回，turn 空转，**零报错** | 阶段 1 步骤 5b；验收必须跑「连续调工具」的真实任务 |
| `sessions.flush` 在 paused 分支抛错 | 低 | 暂停后未持久化 | 已有 try/catch + warn，保留 |
| 上游后续把 `paused` 纳入正式 `TurnEndReasonMap` 或加校验 | 低 | 需再改一次 | 头部注释记录约定依赖 |
| 双份模块实例导致 `scopeOf` 失效（历史 bug） | 低 | 会话创建全挂 | `dependencies` 保持为空；dependency-contract 双重断言 |

**回滚**：所有工作在新分支；`master` 保持 `0.1.0` 原状（对应 `0.1.0-rc.7` 基线）。若升级卡在阶段 1，可只发布「不 fork 的降级版」——但需要先评估纯外部插件能否实现暂停（`notes/design.md` 已论证过：不能，因为需要跳过空输入保护与无消息唤醒 driver）。故实际回滚点就是「不升级」。

## 七、勘察方法学教训（防复发）

本次勘察出现过两次「把工具失败误读成事实」的错误，都写进了计划又推翻，值得固化成规则：

### 教训 1：`grep -P` 在 macOS 上不存在，且被 `2>/dev/null` 掩盖

为了判断「`useProjection` 是否还支持 selector」，我执行了：

```bash
grep -rhoP 'useProjection\([^)]*,[^)]*\)' $D/*/lib/client.js 2>/dev/null   # ← 错
```

macOS 自带 BSD grep **不支持 `-P`**，命令以退出码 **2** 失败、无任何输出，而 `2>/dev/null` 把 `invalid option -- P` 的报错吞掉了。于是「命令失败」被读成「没有匹配」，进而写下「全仓无双参数调用」的错误结论。

**规则**：
- BSD grep 下用 `-E`，不用 `-P`。
- **任何带 `2>/dev/null` 的命令都必须同时检查 `$?`**；或者干脆不吞 stderr。
- 用「没有输出」支持一个否定性结论时，先确认那条命令真的能产出输出（拿一个已知为正的样本做阳性对照）。

### 教训 2：只看单个包就下整仓结论

判断 settings 机制时，我只看 `dsh-agent-loop` 一个包，发现 `grep -i settings` 为空，就下了「设置机制整体消失、属功能回归」的结论。实际上这是全体系的 API 重构（`dsh-settings` 的导出整体换掉、新模型是把 Config schema 投影成表单、`.volatile()` 承载热更新）。

**规则**：一个 API 消失时，先查**提供方包**（这里是 `dsh-settings`）的导出与服务声明，再判断是「能力没了」还是「实现换了」。

### 教训 3：勘察结论要先能自证，再写进计划

上面的错误能被发现，是因为把结论按「文件:行号」记了下来，后来复核时能直接回到出处验证。没有出处的结论（如「官方都这么做」）无法证伪，风险最高。

**规则**：计划里每条关键结论必须能指到具体的 `文件:行号` 或可复现的命令。

## 八、已决决策

1. **`AgentStatus` 第三态 → 采纳 B（已实现）**：用户决定取消第三态，host 侧对 paused 相位报 `"idle"`，靠 `phase.kind` / `agent.paused` 内部区分。
   - 实现：`get status()` 把 paused 折进 idle；新增 `get paused()` 访问器。
   - 附带修正：`lib/index.js` 里原先用 `agent.status === "running"` 判断「是否在跑」仍然正确，但「是否已暂停」必须改看 `agent.paused`——这一点已在 `/pause` 与 `/resume` 的 handler 里落实。
   - 已知代价：活跃 goal 会话暂停时可能多排入一轮 goal 消息（见 design.md「已知代价」）。
2. ~~settings 回归的处理~~ —— **此问题已作废**。复查后确认不存在功能回归：`maxParallelToolCalls` 仍可在设置面板编辑并热更新，只是实现从 `installSettingsSection` 分区改成了 `.volatile()` 的 Config 字段（详见 2.2）。无需你做决策，也无需额外工时。
