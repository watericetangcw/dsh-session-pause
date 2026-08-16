<div align="center">

# dsh-session-pause

**让 DeepSeek Harness 随时「暂停一切」，稍后无缝接着跑**

[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-web%20bundle-4f46e5.svg)](https://github.com/watericetangcw/dsh-session-pause)

**[English](README.en.md) · 简体中文**

</div>

一次安装，永久可用：点击发送按钮旁边的 **⏸ 暂停**，等当前这一轮优雅收尾（回答写完、所有工具跑完）后，把会话完整落盘——随时关闭、重启 DSH 都行，回来点 **▶ 继续** 即可从暂停点接着跑，就像从来没停过。**不改动任何 DSH 代码**，整个功能就是一个即装即用的 profile bundle。

## ✨ 功能亮点

### ⏸ 一键暂停

发送/停止主按钮**正左侧**新增一枚暂停按钮：点击后不打断任何进行中的请求，当前步骤到达边界后这轮以 `paused` 优雅关停，紧接着自动落盘——按钮随即变成**继续按钮**。

### 💾 完整持久化

暂停 = 全程落盘：消息、chunk、工具调用与结果、请求上下文全部写进既有会话 JSONL，**不新增任何存储格式**。因此只要 DSH 还在，随时回来都能继续。

### 🔄 重启也能恢复

会话日志里最后一轮以 `paused` 结束时，重启 DSH 后重新打开该会话，agent 会直接回到暂停状态，继续按钮照常工作——**关掉 DSH、甚至换机器继续，都不会丢进度**。

### 🛑 排干中的三件小事

| 操作 | 效果 |
| --- | --- |
| 悬停转圈中的按钮 | 图标临时变成 ✕，移开恢复 |
| 点击 ✕（取消暂停） | 解除暂停请求，后续运行恢复正常 |
| 点停止 | **不会**取消暂停——只中止当前这轮，转圈继续等下一次可暂停时机 |

> 停顿期间 agent 进入 `paused` 状态，goal 自动轮次天然不启动；继续跑完后自动恢复。

## 🚀 快速安装

一条命令即可：

```powershell
dsh plugin --profile web add github:watericetangcw/dsh-session-pause
```

安装完成后重启 `dsh web`，并刷新一次浏览器页面，即可使用。

<details>
<summary>卸载</summary>

```powershell
dsh plugin --profile web remove dsh-session-pause
```

卸载后重启 `dsh web`，恢复原生 agent-loop 行为。

</details>

## 🧪 快速体验

安装后，给 DSH 一个会用到工具的长任务，跑起来后：

**① 暂停再继续**

点发送按钮左侧的 ⏸ → 等转圈结束、按钮变成 ▶ → 再点 ▶，模型会基于持久化的工具结果接着完成原任务，语义上等同于从未暂停。

**② 重启后继续**

暂停后直接重启 `dsh web`，重新打开刚才的会话 → 它已经是暂停状态，点 ▶ 即可从暂停点续跑。

**③ 暂停中又排队了消息？**

暂停期间发的新消息会留在会话里，继续时一起被认领，不会丢。

## 📖 使用方式

- **暂停**：运行中点 ⏸（或输入 `/pause`）；空闲时也能武装请求，让下一次运行在第一个步骤边界暂停。
- **取消暂停**：转圈中悬停按钮 → 点 ✕（或 `/pause-cancel`）。
- **继续**：暂停后点 ▶（或 `/resume`）。
- **命令**：`/pause`、`/pause-cancel`、`/resume` 均可直接从斜杠菜单调用。

## 🔗 链接

- 仓库：[github.com/watericetangcw/dsh-session-pause](https://github.com/watericetangcw/dsh-session-pause)

## 📄 许可证

[MIT](LICENSE) © 2026 WateRice
