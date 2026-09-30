# sidebar-terminal-tools 实现计划

> **For agentic workers:** 按任务顺序执行；每步用 `- [ ]` 跟踪。规格见
> `docs/plans/2026-09-30-sidebar-terminal-tools-design.md`（先读它）。
> 用户已确认：路线 A（桥接官方终端）/ 输入同等地位 + 用户操作后提醒 / 安全门默认开 + 文档警告。

**Goal:** 交付 bundle + 双 half 插件 `@huanlin/dsh-plugin-sidebar-terminal-tools`：模型工具驱动官方侧栏终端，
终端在官方侧栏自动出现、用户可随时接管，且有 `wait_for`。

**Architecture:** host half 通过体积小的结构适配层调用 `ctx.terminalController`（create/follow/write/close/list），
每条终端一个 follow 消费者 + ANSI 清洗的有界转录，工具与 `wait_for` 都读转录；client half 轮询
`ctx.webTerminals.recover()` 把 `stb-` 前缀终端开成官方 terminal tab。

**Tech Stack:** TypeScript 5.9 / tsdown（host+client 双 bundle）/ vitest；DSH 0.2.0-rc.1 宿主契约。

**Spec:** `docs/plans/2026-09-30-sidebar-terminal-tools-design.md`

## Global Constraints

- 插件 `name = 'sidebar-terminal-tools'`；工具前缀 `sidebar_terminal_`；终端 id 前缀 `stb-`
- 只操作本插件创建并登记的 `(sessionId, terminalId)`；绝不触碰用户手动终端
- 不 import `@deepseek-ai/dsh-api-terminal-controller`（服务名注入 + 影子类型）；client half 用其 `/client` 服务
- `lib/` 预构建入库；无 `prepare`；`files = ["lib/", "cordis.patch.yml"]`
- 安全：默认开 + README 大字警告（系统用户权限、绕过沙箱/审批、共享 maxTerminals 配额）
- 行 id/命名一处对不上就是 bug：工具名/结果字段/配置字段在计划里逐字给定

---

### Task 0: 前置侦察（只读，产出写回本计划附录）

**Files:** Modify: 本文件（追加「侦察结果」）

- [x] **Step 0.1** 读 DSH loader 对 bundle client half 的加载契约：`dsh.client` 字段、
  client bundle 的 `window.__ModuleLoader__.load({ id })` 里 id 与包名的关系、`manifestVersion` 要求。
  对照 `~/.dsh/profiles/web/node_modules/dsh-better-sidebar`（package.json 的 `dsh` 块 + lib/client.js 头）。
  参考源码：`packages/bundle/*/`、`apps/cli`、`packages/host`。
- [x] **Step 0.2** 读 `packages/jobs/tool-jobs/src/index.ts` 的 `owner.inject(message)` 用法：
  `MessageId` 生成、`MessageSourceMap` declare、`ContextFormed.form='notice'` 的 message 构造。抄成模板。
- [x] **Step 0.3** 读 `ctx.sidebarRight.openTabIn` 实现（`packages/client/ui-sidebar-right/src`）：
  是否抢焦点/展开面板、能否后台开。
- [x] **Step 0.4** 用自己的话把三个结论追加到本文件末尾「侦察结果」，含文件:行号。

### Task 1: 仓库骨架

**Files:**
- Create: `package.json` `tsconfig.json` `tsconfig.client.json`（如需要）`tsdown.config.ts` `tsdown.client.config.ts`
  `vitest.config.ts` `.npmrc` `.gitignore` `pnpm-workspace.yaml` `cordis.patch.yml` `README.md` `AGENTS.md` `LICENSE`
- 模板：host 部分镜像 `dsh-sleep`；client 打包镜像 `dsh-better-sidebar`（chunk 不需要，单 client.js）

**Interfaces → Produces:** 能 `pnpm install / test / typecheck / build` 的双 half 工程；
`package.json` 含 `dsh.bundle.patch` 与 `dsh.client`。

- [x] **Step 1.1** 写 `package.json`：
  ```jsonc
  {
    "name": "@huanlin/dsh-plugin-sidebar-terminal-tools",
    "version": "0.1.0",
    "publishConfig": { "access": "public" },
    "type": "module",
    "main": "./lib/index.js",
    "exports": {
      ".": { "types": "./lib/index.d.ts", "import": "./lib/index.js" },
      "./client": { "types": "./lib/client.d.ts", "import": "./lib/client.js" },
      "./package.json": "./package.json"
    },
    "files": ["lib/", "cordis.patch.yml"],
    "dsh": {
      "bundle": { "patch": "./cordis.patch.yml" },
      "client": { "inject": ["@deepseek-ai/dsh-api-terminal-controller", "@deepseek-ai/dsh-client-ui-sidebar-right"], "platform": "web" },
      "manifestVersion": 1
    },
    "scripts": { "typecheck": "tsc -p tsconfig.json --noEmit", "test": "vitest run", "build": "tsc -p tsconfig.json && tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts" },
    "dependencies": { "@deepseek-ai/schemastery": "^3.18.4" },
    "peerDependencies": {
      "@deepseek-ai/cordis": "^4.0.1",
      "@deepseek-ai/dsh-tools": "^0.2.0-rc.1",
      "@deepseek-ai/dsh-llm": "^0.2.0-rc.1"
    },
    "peerDependenciesMeta": { "...": "全部 optional: true" },
    "devDependencies": {
      "@deepseek-ai/cordis": "link:D:/Projects/deepseek-harness/dsh/vendor/cordis",
      "@deepseek-ai/dsh-tools": "link:D:/Projects/deepseek-harness/dsh/packages/core/tools",
      "@deepseek-ai/dsh-llm": "link:D:/Projects/deepseek-harness/dsh/packages/llm/llm",
      "@types/node": "^22.20.0", "tsdown": "^0.22.2", "typescript": "^5.9.0", "vitest": "^3.2.0"
    }
  }
  ```
  `dsh.client.inject` 的确切清单与 `manifestVersion` 以 Task 0.1 结论为准修订。
- [x] **Step 1.2** host `tsdown.config.ts`：entry `src/index.ts`，externals 三个 peer；client 配置：
  entry `src/client/index.ts` → `lib/client.js`，externals = client peer + `@deepseek-ai/*` 全部宿主包，
  产物以 `window.__ModuleLoader__.load({ id: <按 Task 0.1>, factory })` 包裹（参照 better-sidebar 产物写法）。
- [x] **Step 1.3** `cordis.patch.yml`（根级 insert，**不要**放进任何 preset/isolate 组——`terminalController` 在根 realm）：
  ```yaml
  - insert:
      - id: sidebar-terminal-tools
        name: '@huanlin/dsh-plugin-sidebar-terminal-tools'
        config:
          transcriptLines: 5000
          transcriptBytes: 1048576
          defaultTimeoutMs: 10000
          maxTimeoutMs: 600000
          pollIntervalMs: 150
  ```
- [x] **Step 1.4** `pnpm install`；`pnpm test` 空跑通过（无测试文件时 vitest 0 例也算通过）。
- [x] **Step 1.5** Commit `chore: scaffold sidebar-terminal-tools`。

### Task 2: 取回 wait_for 核心

**Files:** Create: `src/wait-for.ts`、`tests/wait-for.spec.ts`（从旧仓库取回）
- 来源：`https://github.com/huanlinoto/dsh-plugin-terminal-extension-wait-for` commit `4dae4b8`，
  文件 `src/wait-for.ts` 与 `tests/wait-for.spec.ts`。

- [x] **Step 2.1** `git clone --depth 1 https://github.com/huanlinoto/dsh-plugin-terminal-extension-wait-for <tmp>`
  并 `git checkout 4dae4b8`，把两个文件拷入新仓库（保持相对路径）。
- [x] **Step 2.2** `pnpm test`：23 例全绿（若 import 路径需调整，只改路径不改断言）。
- [x] **Step 2.3** Commit `feat: import wait_for core from previous plugin`。

### Task 3: 端点核心 `src/endpoint.ts`（TDD）

**Files:** Create: `src/endpoint.ts`、`src/sanitize.ts`、`src/registry.ts`、`tests/endpoint.spec.ts`、`tests/sanitize.spec.ts`

**Interfaces → Produces:** `EndpointRegistry`（按 owner agent 隔离的终端表）、`sanitizeTerminalText`、
`mintTerminalId(n)`、`TranscriptBuffer`（append/read 分页）、`attachFollower(...)`（消费 follow 流）、
`detectControllerChange(state)`、`buildUserNotice(...)`。

- [x] **Step 3.1 失败测试**（mock 一个结构化的 controller：`create/follow/write/close/list`，`follow` 返回
  可脚本化推送帧的 async iterable）：
  - id 生成符合 `/^stb-[\w-]{1,120}$/` 且单调不回退
  - 转录：ANSI 清除、行/字节双重有界、分页读、wait_for 命中（复用 Task 2 核心）
  - 控制权：follow 后 attachment 为控制者；`write` 抛 `control-unavailable` → 重新 follow 并返回
    `regained_control: true`；模拟用户接管（推送 `state` 帧 controllerId=他人）→ 生成 inject 提醒一次
    （不重复刷屏：同一接管会话只提醒一次）
  - 退出：`state=exited` 后 wait_for 返回 exited；`close` 后注册表移除、follow 消费者退出
- [x] **Step 3.2** `pnpm test` 失败（模块不存在）。
- [x] **Step 3.3 实现**：`sanitize.ts`（CSI/OSC/单字符控制码剥离；保留 `\n`）、`registry.ts`、
  `endpoint.ts`（见设计文档「Host half/数据面」；follow 背压：逐帧立即处理不留队列）。
- [x] **Step 3.4** `pnpm test` 全绿；`pnpm run typecheck` 干净。
- [x] **Step 3.5** Commit `feat: controller bridge core with transcript and control handling`。

### Task 4: 工具注册 `src/tools.ts` + 入口 `src/index.ts`（TDD）

**Files:** Create: `src/tools.ts`、`tests/tools.spec.ts`；Modify: `src/index.ts`（`name/inject/Config/apply`）

**Interfaces → Consumes:** Task 3 的 `EndpointRegistry`；**Produces:** `sidebar_terminal_open/send/read/wait_for/close/list`
（schema 与结果五态见设计文档；oneOf 五态复用旧插件的 schema 形状）。

- [x] **Step 4.1 失败测试**（mock `@deepseek-ai/dsh-tools` 的 `defineTool`，同旧插件做法）：
  注册恰好 6 个工具、名字与参数正确；每工具 execute 对一个 fake controller 端到端可用（open→send→read→
  wait_for→list→close）；owner 隔离（另一个 agent 拿不到别人的 id）；`limit_reached` 映射为 canonical 值。
- [x] **Step 4.2** `pnpm test` 失败。
- [x] **Step 4.3 实现** `tools.ts`（薄适配：解析参数 → registry 调用 → 规范值）+ `index.ts`
  （`Config` Schemastery + `resolveConfig` fail loud + `apply`：`inject = ['terminalController','tools']`）。
- [x] **Step 4.4** `pnpm test` 全绿 + typecheck 干净 + `pnpm run build` 出 `lib/index.js`（host 半产物 extenals 正确）。
- [x] **Step 4.5** Commit `feat: sidebar_terminal_* tools`。

### Task 5: Client half `src/client/index.ts`（纯函数 TDD）

**Files:** Create: `src/client/index.ts`、`src/client/pick.ts`（纯函数）、`src/client/locales.ts`、`tests/client-pick.spec.ts`

**Interfaces → Consumes:** `ctx.webTerminals.recover(sessionId)`、`ctx.sidebarRight.openTabIn(...)`;
**Produces:** `pickUnopened(prefix, recovered, openedIds)` 与自动打开循环。

- [x] **Step 5.1 失败测试**：只挑 `stb-` 前缀、跳过已在视图/已关闭的、去重、空输入不产 tab。
- [x] **Step 5.2** `pnpm test` 失败。
- [x] **Step 5.3 实现**：`pick.ts` 纯函数；`index.ts` 轮询（默认 3s，`ctx.effect` 清理）对
  `sidebarRight.openTabs` 里的 session 调 `recover`，`openTabIn` 按 Task 0.3 结论选择不抢焦点的方式；
  文案入 locale 词典（zh/en）。
- [x] **Step 5.4** `pnpm test` 全绿 + `pnpm run build` 出 `lib/client.js` 且包裹写法符合 Task 0.1 契约。
- [x] **Step 5.5** Commit `feat: client half auto-opens model terminals in the native sidebar`。

### Task 6: 构建、README、合规

- [x] **Step 6.1** README：顶部 dshfind card（`huanlinoto/dsh-plugin-sidebar-terminal-tools`）、
  中英功能说明、**安全警告**（系统用户权限/绕过沙箱/共享配额/建议 permission 加闸）、开发/运行/检查三节、
  挂载位置说明（根级，不进 preset realm）。
- [x] **Step 6.2** 合规自检：零源码 patch、B1-B3、F1-F3、A6 不导出 default、测试分层（Unit）、`npm pack --dry-run` 清单。
- [x] **Step 6.3** Commit `docs: README and compliance pass`。

### Task 7: 发布与挂载

- [ ] **Step 7.1** `gh repo create huanlinoto/dsh-plugin-sidebar-terminal-tools --public --source . --push`；
  双语描述 + topic `dsh-plugin`。
- [ ] **Step 7.2** `dsh plugin --profile web add link:D:\Projects\deepseek-harness\dsh-plugin-sidebar-terminal-tools`；
  重启 `dsh web`（人类）+ 硬刷新。
- [ ] **Step 7.3** 真机实测：模型 `sidebar_terminal_open` → 侧栏应自动出现终端 tab →
  `sidebar_terminal_send("ping -n 4 127.0.0.1")` → `sidebar_terminal_wait_for("(Ping 统计|丢失)")` →
  用户点「接管」输入一条命令 → 模型下一条 `sidebar_terminal_read` 应看到用户命令与一条提醒注入。
- [ ] **Step 7.4** `pnpm publish --registry https://registry.npmjs.org/`（2FA 交互终端，由用户完成；
  ~3 分钟后复核，不重发）。

---

## 侦察结果（Task 0 完成后追加，2026-09-30）

### 1. Client half 加载契约（Step 0.1）

- `dsh.client = { platform: 'web', inject?: string[], external?: string[], immediately?: boolean }`；
  `manifestVersion: 1` 为纯声明，安装器/加载器**不强制检查**（`packages/util/package-manifest/src/types.ts:30-39`、
  `packages/util/package-manifest/README.md:93`）。
- 声明了 `dsh.client` 的包**必须有** `exports["./client"]`（string 或含 string `default` 的一层条件对象），
  否则 client-modules 启动抛错（`packages/client/modules/src/index.ts:194-205,845-848`）。
- boot 图 entry **id == npm 包名**（`packages/client/modules/src/client/manifest.ts:54`「Entry name == package name」；
  `index.ts:1040-1041` `graphRow(packageName, …)`）。client bundle 必须以
  `window.__ModuleLoader__.load({ id: <npm 包名>, factory: (require) => exports })` 注册，id 必须与图行一致
  （`manifest.ts:316-328` `ClientBundleRegistration`；对照 better-sidebar `lib/client.js:1-3`
  `id: "dsh-better-sidebar"`）。factory 体**只注册工厂**，模块副作用在首次 materialize 时执行（`manifest.ts:9-16`）。
- `dsh.client.inject` 是**包名依赖边**（该包工厂须先到达 + cordis entry 组合用），不是服务注入；
  服务名写在 client 插件对象自己的 `inject` 数组（better-sidebar `src/client/index.tsx:49`
  `inject = ['slots','sessions','locale','modules',…]`）。`external` 声明 runtime module 请求（baseline 之外）；
  **type-only import 被擦除、不产生请求**（package-manifest `types.ts:88-93`）。terminal-controller 自身
  `external: ["@deepseek-ai/dsh-api-gateway/client"]` 因其 client bundle runtime import gateway；本插件 client half
  对宿主包仅 type import → 无需 `external`。
- 修订（Task 1.1 依据）：`dsh.client.inject = ["@deepseek-ai/dsh-api-terminal-controller",
  "@deepseek-ai/dsh-client-ui-sidebar-right", "@deepseek-ai/dsh-client-locale"]`，`manifestVersion: 1` 保留。

### 2. `MessageId` + `agent.inject` 用法（Step 0.2，模板照抄）

- `MessageSourceMap` 自行 declare（`packages/jobs/tool-jobs/src/index.ts:24-28`）：
  `declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'sidebar-terminal-tools': { kind: 'sidebar-terminal-tools' } & ContextFormed } }`
- 消息构造（`tool-jobs/src/index.ts:284-307`）：`createUserMessage({ content: [{ type:'text', text }],
  source: { kind: 'sidebar-terminal-tools', form: 'notice', summary } })` 然后 `owner.inject(message)`。
  **`MessageId` 不用自己生成**：`createUserMessage`（`packages/llm/llm/src/message.ts:246-249`）内部经
  `createMessage` 用 `randomUUID()` 打 id（`message.ts:226`）。
- `summary` 用 `boundContextSummary`（`message.ts:129-133`）截到 120 字符（`CONTEXT_SUMMARY_MAX_CHARS`，
  `message.ts:122`）；`ContextFormed` 为 `{ form:'notice' } | { form:'relay' } | { form:'recall' }`
  （`message.ts:98-101`）。`inject` 不唤醒空闲 agent（设计文档已核实）。

### 3. `openTabIn` 行为（Step 0.3）

- 签名 `openTabIn(sessionId, kind, { params, …placement })`（`packages/client/ui-sidebar-right/src/client/service.ts:354-357`）
  → `placeTab`（:394-404，未注册的 kind 抛错）→ `place`（:407-444）→ `actions.openContent` + `tabDomain.navigate`。
- `openContent` 的 layout ops 固定含 `planSetExpanded(state, true)`（`packages/client/ui-sidebar-right/src/client/stores.ts:308-311`）：
  **会展开右侧栏列**并把 tab 激活到所在 pane（上游语义「an open behind a collapsed panel is not an open」，
  `stores.ts:304-307`），但**不抢 DOM 键盘焦点**（路径上无 `openWithFocus`/`focus` 调用）。**没有**「后台打开」选项——
  自动出现正是本插件目标，行为可接受，README 注明。
- 官方恢复模板（被注释掉的前例，`packages/client/ui-sidebar-terminal/src/client/index.ts:102-122`）：
  `ctx.webTerminals.recover(sessionId).then(terminals => { for (const info of terminals)
  ctx.sidebarRight.openTabIn(sessionId, 'terminal', { params: { terminalId: info.id } }) })`。
- `recover(sessionId)`（`packages/api/terminal-controller/src/client/index.ts:190-196`）：`remote.list` 后滤掉本窗口
  已有视图（held）、未完成关闭、已关闭的 —— **自带去重**；`stb-` 过滤叠加在其结果上即可。
- 会话枚举：`ctx.sidebarRight.openTabs` 是 `ObservableSnapshot<readonly { sessionId, tabId, kind, contentId }[]>`
  （`packages/client/ui-sidebar-right/src/client/tab-inventory.ts:8-20`，覆盖已保存+已采纳会话）；
  `ctx.sidebarRight.mounted` 为当前挂载会话。`openTabIn` 对 store 未采纳的会话**静默无操作**（`service.ts:334-336`）。
- 客户端服务名：`webTerminals`（terminal-controller `client/index.ts:56`）、`sidebarRight`
  （ui-sidebar-right `client/index.ts:123`）、locale 词典 `ctx.locale.register(ns, { zh, en })`
  （ui-sidebar-terminal `client/index.ts:70` 前例）。

## 清理记录（已完成 2026-09-30）

- profile web：`dsh plugin remove @huanlin/dsh-plugin-terminal-extension-wait-for` 已执行，
  依赖与 bundles 条目已清、悬空 symlink 已删
- `dsh-preset-ptc-custom/cordis.patch.yml`：`tool-terminal-wait-for` 行已移除
- 本地目录 `D:\Projects\deepseek-harness\dsh-plugin-terminal-extension-wait-for` 已删除
- **未发布 npm**（无需 unpublish）；GitHub 仓库保留为 wait_for 核心的取回源（`4dae4b8`）
