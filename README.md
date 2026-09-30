<p align="center">
  <a href="https://dshfind.com/zh/plugins/huanlinoto/dsh-plugin-sidebar-terminal-tools"><img src="https://dshfind.com/api/card/huanlinoto/dsh-plugin-sidebar-terminal-tools?lang=zh" alt="dsh-plugin-sidebar-terminal-tools card"></a>
</p>

# sidebar-terminal-tools

[![npm version](https://img.shields.io/npm/v/@huanlin/dsh-plugin-sidebar-terminal-tools)](https://www.npmjs.com/package/@huanlin/dsh-plugin-sidebar-terminal-tools)

DSH plugin that gives the model six `sidebar_terminal_*` tools over the **official right-sidebar terminal stack** (`ctx.terminalController`), which upstream exposes with no model-facing entry point. Terminals the model opens appear in the user's sidebar automatically as native terminal tabs, and the user can take over input at any time.

DSH 插件：把**官方右侧栏终端**（`ctx.terminalController`，上游零模型入口）通过 6 个 `sidebar_terminal_*` 工具交给模型驱动。模型开的终端会**自动出现在用户侧栏**成为官方终端 tab，用户可随时点「接管」亲自输入。

> [!WARNING]
> **安全警告 / Security warning**
>
> - 这些终端以**系统用户权限**运行，**不套 Agent 沙箱、不走审批**（`terminalController` 的上游刻意设计，供人手操作；本插件把它交给模型）。启用即表示你接受模型可以在你的桌面/服务器上直接执行命令。
> - These terminals run with your **system user's permissions**, **outside the Agent sandbox and the approval pipeline** — that is an upstream property this plugin deliberately exposes to the model.
> - 建议在 permission 规则里按工具名 `sidebar_terminal_*` 加闸（至少对 `sidebar_terminal_open` / `sidebar_terminal_send` 要求确认）。
> - Consider gating `sidebar_terminal_*` in your permission rules before enabling.
> - 与用户手动终端**共享每会话 `maxTerminals=8` 配额**；模型开满后你自己就开不了了（反之亦然）。Terminals share the per-session quota of 8 with your manual sidebar terminals.
> - 无提权能力：OS / 容器层面的限制仍然生效。No privilege escalation: OS / container limits still apply.

## 工具 / Tools

| 工具 | 说明 |
|------|------|
| `sidebar_terminal_open` | 开一条新终端（id `stb-*`），自动出现在侧栏；返回 `terminalId/shell/cwd/cols/rows/state`；配额满时返回 `limit_reached`。 |
| `sidebar_terminal_send` | 向终端写输入（默认追加回车）。用户接管中时**自动夺回控制权**再写入，返回 `regained_control: true`。 |
| `sidebar_terminal_read` | 读该终端的纯文本转录（ANSI 已清洗、行/字节有界、`offset` 从最新端计数的分页）。 |
| `sidebar_terminal_wait_for` | 阻塞等待正则在转录中出现，返回五态之一：`found` / `timeout` / `exited` / `gone` / `cancelled`（核心与单测取自上一代插件 `terminal-extension-wait-for`）。 |
| `sidebar_terminal_close` | 关闭终端（杀 shell）并释放转录。 |
| `sidebar_terminal_list` | 列出本会话经本插件打开的终端（状态、行数、当前控制者是 plugin / user / none）。 |

只操作本插件创建并登记的 `(sessionId, terminalId)`：**用户手动开的终端永远不会被这些工具碰到**。模型与用户对输入是同等地位：谁最后 attach 谁持有；用户接管后模型会收到一条注入提醒（"用户可能执行了自己的命令"），下一次 `send` 自动收回控制。

English summary: six tools (`open/send/read/wait_for/close/list`) drive real sidebar terminals the user can watch and take over; transcripts are ANSI-cleaned and bounded; `wait_for` synchronizes on regex cues instead of busy-polling; only plugin-created terminals are reachable.

## 安装 / Install

```sh
# from npm (recommended):
dsh plugin --profile web add @huanlin/dsh-plugin-sidebar-terminal-tools

# from a local checkout (dev):
dsh plugin --profile web add link:D:\Projects\deepseek-harness\dsh-plugin-sidebar-terminal-tools
```

预构建策略：`lib/` 入库（含 host 与 client 双产物），无 `prepare` 脚本，npm 安装开箱即用。

**挂载位置**：本插件必须挂在 profile **根级**（`dsh plugin add` 的默认行为）——`terminalController` 服务在 web-app 根 realm 提供，进任何 preset/isolate 组都注入不到。`cordis.patch.yml` 已按根级 insert 编写，不要把它挪进 preset 的 patch 组。

## 配置 / Configuration

在 DSH GUI 设置页或 `cordis.patch.yml` 中配置（host half）：

| 字段 | 默认 | 说明 |
|------|------|------|
| `transcriptLines` | `5000` | 每终端保留转录行数 |
| `transcriptBytes` | `1048576` | 每终端保留转录字节上限（1 MiB） |
| `defaultTimeoutMs` | `10000` | `wait_for` 缺省超时 |
| `minTimeoutMs` / `maxTimeoutMs` | `100` / `600000` | `wait_for` 超时钳制边界 |
| `pollIntervalMs` | `150` | `wait_for` 轮询间隔 |
| `tailLines` / `maxLineTextChars` / `maxTailBytes` | `30` / `1000` / `8192` | `wait_for` 摘录边界 |
| `maxMessageChars` | `2000` | 用户接管提醒的长度上限 |

Client half（web 客户端配置层）可配 `pollIntervalMs`（侧栏自动打开的轮询间隔，默认 3000ms，最小 250ms）。

## 架构 / Architecture

- **Host half**（`src/index.ts` + `endpoint/registry/sanitize/wait-for`）：结构影子类型消费 `ctx.terminalController`（**不 import** `@deepseek-ai/dsh-api-terminal-controller`）；每条终端一个 follow 消费者，`snapshot`/`output` 经 ANSI 清洗进有界转录，`state` 帧维护 `state/exitCode/controllerId` 并在用户接管时 `agent.inject` 一条提醒（同一接管会话只提醒一次）。
- **Client half**（`src/client/`，产物 `lib/client.js` 以 `window.__ModuleLoader__.load({ id: <package name>, factory })` 注册）：轮询 `ctx.webTerminals.recover()`，把 `stb-` 前缀终端用 `ctx.sidebarRight.openTabIn()` 开成官方 terminal tab。`openTabIn` 会展开侧栏列但**不抢键盘焦点**；上游本就把它设计为"打开即可见"。
- 上游若在未来版本提供官方自动恢复，client half 应退役，只保留工具层。

## 开发 / Development

```sh
pnpm install        # 需要本地 DSH checkout 的 link: devDependencies
pnpm test           # vitest（79 例：wait_for 核心 23 + sanitize/endpoint/tools/client）
pnpm run typecheck  # host + client 两个 tsconfig
pnpm run build      # lib/index.js（host）+ lib/client/*.d.ts + lib/client.js（client bundle）
```

## 运行 / Running

```sh
dsh plugin --profile web add @huanlin/dsh-plugin-sidebar-terminal-tools
# 重启 dsh web，浏览器硬刷新（client half 是启动图的一部分）
```

真机验收路径：让模型 `sidebar_terminal_open` → 侧栏自动出现终端 tab → `sidebar_terminal_send("ping -n 4 127.0.0.1")` → `sidebar_terminal_wait_for("(Ping 统计|丢失)")` → 你点「接管」输入一条命令 → 模型下一条 `sidebar_terminal_read` 能看到你的命令，且收到一条接管提醒。

## 检查 / Compliance

- 零源码 patch：只有根级 `cordis.patch.yml` 一行 insert；不修改任何上游文件
- 不 import 上游终端包；服务名 `terminalController` + 结构影子类型（`src/shadow.ts`）
- 工具名前缀 `sidebar_terminal_`、终端 id 前缀 `stb-`，均不与上游冲突
- 无 default 导出；C4 规范值 / C5 业务态为值 / C6 全程尊重 signal
- `npm pack --dry-run` 清单仅 `lib/` + `cordis.patch.yml` + README/LICENSE/package.json

## License

AGPL-3.0（wait_for 核心取自同一作者的 `dsh-plugin-terminal-extension-wait-for` @ 4dae4b8）
