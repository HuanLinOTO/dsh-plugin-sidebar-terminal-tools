# sidebar-terminal-tools 设计（dsh-plugin-sidebar-terminal-tools）

> 2026-09-30 · 用户已确认三项关键决策（路线 A / 输入同等地位 + 用户操作后提醒 / 安全门默认开+文档警告）
> 前置状态：旧插件 `dsh-plugin-terminal-extension-wait-for` 已从 profile 卸载、preset 行已移除、
> 本地目录已删除；其 GitHub 仓库保留在 `huanlinoto/dsh-plugin-terminal-extension-wait-for@4dae4b8`
> （wait_for 核心与测试从那里取回复用）。

## 目标

让模型能驱动**官方右侧栏终端**（`@deepseek-ai/dsh-client-ui-sidebar-terminal` 那套），
终端会话对用户可见（侧栏 tab）、可被用户接管，并补齐 `wait_for` 等模型面工具——
即把 better-sidebar v0.21.1 删掉的那类能力，改挂在 DSH 官方终端栈上。

## 背景

- 官方侧栏终端的宿主服务是 `ctx.terminalController`（`@deepseek-ai/dsh-api-terminal-controller`，
  web-app 根级 insert，`web-app/cordis.patch.yml:130`），**模型面零入口**（README「模型体验：无」）。
- 模型侧的 `ctx.terminals`（`dsh-tool-terminal`）是另一套会话，没有侧栏 UI。
- better-sidebar 自带的终端（含 8 个 `terminal_*` 工具与 `terminal_wait_for`）自 v0.20 开发线整删、
  随 v0.21.1 发布，终端 UI 让给官方 `ui-sidebar-terminal`。

## 已核实的宿主事实（实现依据）

| 事实 | 位置 |
|---|---|
| `terminalController` 在 profile 根 realm，可直接 `inject` | `packages/bundle/web-app/cordis.patch.yml:130` |
| owner 按 `agent.id` 隔离，而 `Agent.id: SessionId` | `api/terminal-controller/src/index.ts:286`、`core/agent/src/index.ts:212` |
| `create(agent, {id, cols, rows}, signal)`：id 由调用方生成（`/^[\w-]{1,128}$/`），幂等，closed id 不可复用 | 同上 `:158` |
| `follow(agent, id, attachmentId, signal)` → `snapshot`（序列化屏幕）+ `output` + `state`，**新 attachment 成为排他输入控制者**；控制权变化会 `broadcast({type:'state'})` 给所有 follower | `terminal.ts:77-99` |
| 用户端「只读 + [接管]」按钮已存在：`!writable` 时 `model.connect()` 重新 attach 抢回控制 | `ui-sidebar-terminal/src/client/terminal.tsx:55-60`、`client/model.ts:157` |
| 客户端公开服务 `ctx.webTerminals.recover(sessionId)` 列出"无视图的 host 终端"；`ctx.sidebarRight.openTabIn(sessionId,'terminal',{params:{terminalId}})` 可开成官方 tab | `api/terminal-controller/src/client/index.ts:190`、`ui-sidebar-terminal/src/client/index.ts:102-122`（官方恢复功能被注释掉的实现） |
| `agent.inject(message)`：把模型可见上下文排到下一个 pre-step，不唤醒空闲 agent | `core/agent/src/runtime-types.ts:241` |
| 消息 source 是 merge-extensible map，**没有通用 `plugin` kind**，需自行 declare | `llm/src/message.ts:103-115` |
| 安全事实：`create` docstring "without Agent sandbox or approval restrictions"；终端用系统用户权限 | `api/terminal-controller/src/index.ts:151`、README |

## 决策（用户已确认）

1. **路线 A**：桥接官方 `terminalController`，复用官方终端 tab UI；零原生依赖，不自建 PTY/UI。
2. **输入同等地位，无显式接管**：
   - 模型的 `send` 遇到 `terminal/control-unavailable`（用户接管中）时**自动重新 follow 夺回控制**，
     结果里报告 `regained_control: true`；不新增 `take_control` 参数。
   - 检测到控制权被用户拿走（`state` 帧 `controllerId !== 本插件 attachment`）→ 通过
     `agent.inject` 给模型一条简短提醒（用户可能已执行自己的命令），不唤醒空闲 agent。
3. **安全门默认开 + 文档警告**；建议用户在 permission 规则里按工具名加闸。README 必须大字写明
   "系统用户权限、绕过 Agent 沙箱与审批"，并提示与用户手动终端共享 `maxTerminals=8` 配额。

## 形态

- 仓库 `dsh-plugin-sidebar-terminal-tools`，npm `@huanlin/dsh-plugin-sidebar-terminal-tools`
- 插件 `name = 'sidebar-terminal-tools'`，**bundle + 双 half**（host + client），预构建 `lib/` 入库
- 工具前缀 `sidebar_terminal_*`（不与上游 `terminal_*` 冲突）
- 终端 id 前缀 `stb-`（`/^[\w-]{1,128}$/` 合法；客户端靠前缀识别"模型终端"）
- host peer：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`
  （不 import `dsh-api-terminal-controller`，按服务名 `terminalController` 结构影子声明）
- client half：`dsh.client = { inject: [dsh-api-terminal-controller, dsh-client-ui-sidebar-right, ...], platform: 'web' }`，
  `lib/client.js` 以 `window.__ModuleLoader__.load({ id, factory })` 包裹（参照 better-sidebar 0.24.1 产物）

## Host half

### 工具

| 工具 | 语义 | 结果 |
|---|---|---|
| `sidebar_terminal_open` | `create` 一条模型终端（id `stb-<n>-<rand>`），起 follow 消费 + 文本转录 | `{ terminalId, shell, cwd, cols, rows, state }` |
| `sidebar_terminal_send` | 确保控制权（必要时重新 follow）→ `write(text + `\r`?)` | `{ wrote, regained_control, state }` |
| `sidebar_terminal_read` | 读本插件转录的有界分页（仅自己创建的终端） | 行分页元数据 + 文本 |
| `sidebar_terminal_wait_for` | 复用旧 wait_for 核心（正则/子串回退、found/timeout/exited/gone/cancelled） | 五态之一 |
| `sidebar_terminal_close` | `close`，停 follow、清转录 | `{ closed }` |
| `sidebar_terminal_list` | 列出本会话（owner）本插件创建的终端 | 摘要数组 |

### 数据面

- 每条终端一个后台 follow 消费者：`snapshot`（序列化屏幕）与 `output` 增量都经 **ANSI 清洗**
  后追加进有界转录（默认 ~5000 行 / 1 MiB，可配）；`state` 帧维护 `state/exitCode/controllerId`。
- 转录即 `wait_for` 的匹配空间（复用旧插件 `src/wait-for.ts` 核心与其 23 个单测）。
- 只有本插件注册表中的 `(sessionId, terminalId)` 可被工具访问；**不允许**经这些工具碰用户手动终端。

### 生命周期与配额

- session（agent）dispose → `terminalController` 自动清理，follow 结束，注册表清理。
- 共享 `maxTerminals=8`：超限返回 canonical `limit_reached`（附提示"关掉不用的侧栏终端"）。
- 进程退出（`state=exited/failed`）不重建 shell；`wait_for` 返回 `exited`。

### 用户操作提醒

- 检测 `state.controllerId` 离开本插件附件 → `agent.inject({ role:'user', content:[…], source:{ kind:'sidebar-terminal-tools', form:'notice', summary } })`
  （`MessageSourceMap` 本包自行 declare；`MessageId` 生成方式在实现时对照 `tool-jobs` 的 inject 用法）。
- 提醒文案：终端 id + "用户接管了输入，可能执行了自己的命令；你的下一次 send 会收回控制"。

## Client half

- 目标：模型创建/存在的终端在官方侧栏**自动出现为 terminal tab**（官方恢复按钮已在源码里被注释掉，没有自动路径）。
- 机制：定期（默认 3s，可配）+ 会话打开时调用 `ctx.webTerminals.recover(sessionId)`，
  对 id 以 `stb-` 开头且不在视图里的终端 `ctx.sidebarRight.openTabIn(sessionId, 'terminal', { params: { terminalId } })`。
- 只认前缀，不碰用户终端；已有关闭请求/闭集过滤沿用服务端 `recover` 语义。
- 待实现验证：`openTabIn` 是否抢焦点/强开面板；若有选项，按"后台打开"处理（不抢焦点）。
- 客户端文案走 locale 词典（DSH 客户端 UI 文案为 locale 所有）。

## 配置（Schemastery，fail loud）

| 字段 | 默认 | 说明 |
|---|---|---|
| `transcriptLines` | 5000 | 每终端保留转录行数 |
| `transcriptBytes` | 1048576 | 每终端保留转录字节上限 |
| `defaultTimeoutMs` / `maxTimeoutMs` / `minTimeoutMs` | 10000 / 600000 / 100 | wait_for 边界（同旧插件） |
| `pollIntervalMs` | 150 | wait_for 轮询 |
| `tailLines` / `maxLineTextChars` / `maxTailBytes` | 30 / 1000 / 8192 | wait_for 摘录（同旧插件） |
| `maxMessageChars` | 2000 | agent.inject 提醒长度上限（`boundContextSummary` 之外再截） |

## 测试

- 单测：wait_for 核心（从旧仓库取回 23 例）、ANSI 清洗、转录有界/分页、id 生成与前缀、
  注册表 owner 隔离、控制权夺取判定（mock controller）、工具注册与 schema、user-takeover 提醒触发。
- client half：`stb-` 过滤与去重逻辑抽成纯函数单测；不引入 React 测试（无 UI 自绘）。
- 真实组合 preflight（可选，参考 better-sidebar 的 mount 思路）放后续。

## 风险与开放项（实现时先验证）

1. **`dsh.client` 加载契约**：第三方 bundle 的 client half 如何被模块加载器解析（id 是否等于包名、
   `manifestVersion` 要求）——先读 DSH loader 源码 + 对照 better-sidebar 0.24.1 产物。
2. **`agent.inject` 消息构造**：`MessageId` 如何生成、`ContextFormed` 用法——对照 `packages/jobs/tool-jobs`。
3. **`openTabIn` 行为**：是否抢焦点、是否可后台打开。
4. **follow 消费背压**：`maxBufferedBytes`（2 MiB/订阅者）下消费慢会失败；转录清洗必须及时。
5. **API 漂移**：`terminalController` 随 DSH 版本演进（当前 0.2.0-rc.1），peer 钉 `^0.2.0-rc.1`。
6. **上游态度**：自动恢复模型终端属上游注释掉的 UX；若上游后续提供官方恢复，插件应退回只做工具层。

## 安全声明（README 必写）

- 这些终端以**系统用户权限**运行，**不套 Agent 沙箱、不走审批**（上游刻意设计，供人手操；本插件将其
  交给模型驱动）。默认开启，用户自负风险；建议用 permission 规则按 `sidebar_terminal_*` 工具名加闸。
- 与用户手动终端共享每会话 8 个终端配额；不提供 root 提权，OS/容器限制仍生效。
