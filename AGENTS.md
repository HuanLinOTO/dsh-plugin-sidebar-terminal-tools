# sidebar-terminal-tools — Agent Guide

## Plugin overview

Bundle + dual-half DSH plugin (`@huanlin/dsh-plugin-sidebar-terminal-tools`) bridging the official sidebar terminal stack (`ctx.terminalController`) to the model: six `sidebar_terminal_*` tools, auto-appearing native sidebar tabs, user takeover with one-shot inject notices, and a retrieved `wait_for` core.

## Key conventions

- **Bundle form**: root-level `cordis.patch.yml` inserts one plugin row. NEVER move the insert into a preset/isolate group — `terminalController` lives in the web-app root realm. Zero source patches to DSH.
- **Pre-built `lib/` strategy**: `lib/` is committed; no `prepare` script; github/npm installs work without build scripts.
- **Dual half**: host = `src/index.ts` (ESM, `lib/index.js`); client = `src/client/index.ts` (CJS closure factory, `lib/client.js`, registered via `window.__ModuleLoader__.load({ id: <npm package name>, factory })` — the id MUST equal the package name, and `exports["./client"]` must carry a string `default`).
- **Shadow types**: never import `@deepseek-ai/dsh-api-terminal-controller`. `src/shadow.ts` declares the structural slice + the `Context.terminalController` augmentation; update it in one place when upstream drifts.
- **Naming is contract**: plugin `name = 'sidebar-terminal-tools'`, tools `sidebar_terminal_*`, terminal ids `stb-<seq>-<rand>` (`src/registry.ts`), client prefix `stb-` (`src/client/pick.ts`) — keep both prefixes in sync.
- **Ownership isolation**: tools only reach `(ownerId, terminalId)` pairs in `EndpointRegistry`; user manual terminals are never registered and never touched.
- **Peer deps**: `@deepseek-ai/cordis` + `@deepseek-ai/dsh-tools` + `@deepseek-ai/dsh-llm` (optional, provided by host). `schemastery` is a direct dependency.
- **ESM-only host**: `"type": "module"`, relative imports use `.js` extensions (NodeNext).

## File responsibilities

| File | Role |
|------|------|
| `src/index.ts` | Entry: `name`, `inject = ['terminalController','tools']`, `Config` (Schemastery), `resolveConfig` fail loud, `apply` |
| `src/tools.ts` | Six `defineTool` registrations; schema + execute + render; canonical shapes are the contract |
| `src/endpoint.ts` | `createEndpoint` (open/send/read/waitFor/close/list), attachment consumer, `detectControllerChange`, `buildUserNotice`, `MessageSourceMap` declare |
| `src/attachment.ts` | `AttachmentChannel`: per-attachment numbered input queue (the synthesized invocation's uplink) + per-sequence ack waiters |
| `src/registry.ts` | `EndpointRegistry`, `TranscriptBuffer`, `mintTerminalId`, `TERMINAL_ID_PREFIX` |
| `src/sanitize.ts` | ANSI/control-code stripping (keeps `\n` only) |
| `src/shadow.ts` | Structural shadow of the terminal controller (duplex `attach`), `RemoteInvocationShadow`, `terminalSurfaceOf` adapter, `remoteErrorCode/Details` |
| `src/wait-for.ts` | Retrieved wait core (do not reformat; upstream at huanlinoto/dsh-plugin-terminal-extension-wait-for@4dae4b8) |
| `src/client/index.ts` | Client half: activity-window discovery over `webTerminals.recover(sessionId, true)` (driven by the forwarded `api-session/status` event) + `sidebarRight.openTabIn`; timed polling only as a fallback |
| `src/client/pick.ts` | Pure `pickUnopened(prefix, recovered, openedIds)` |
| `src/client/locales.ts` | Bilingual client strings (`ctx.locale.resolveText`) |
| `tests/` | vitest: wait-for (23), sanitize, endpoint (fake surface), tools (mocked defineTool + real `terminalSurfaceOf` over a cordis-stand-in ctx), client-pick + loop |

## Commands

```sh
pnpm run typecheck    # host tsconfig + client tsconfig
pnpm test             # vitest run
pnpm run build        # tsdown host → tsc client d.ts → tsdown client bundle (order matters: client tsdown has clean:false)
```

## Control-flow invariants

- Host-side `attach` rides a synthetic `RemoteInvocation` through `ctx.extend({ invocation }).terminalController` — the same mechanism the gateway dispatches Remote calls with (cordis rebinds the service's ctx to the accessing context). The invocation's `uplink` is the `AttachmentChannel` input queue; in-process carriers impose no `uplinkWindow`.
- New `attach` = fresh exclusive input controller (upstream: every attachment supersedes prior controllers; older attachments keep receiving output). Commands are numbered from 1 within each attachment — a sequence gap fails the stream.
- `send` awaits the per-sequence `ack`. A refusal (`read-only`/`not-running`) or a dead channel surfaces as `terminal/control-unavailable`; `send` then disposes the old channel, re-attaches (fresh attachment), retries the write once, reports `regained_control: true`.
- Re-attach disposes the previous channel FIRST — its queued frames die with it, so the control broadcast our own re-attach causes never reaches the old consumer (no double-append, no self-notified takeover); the new stream's snapshot REPLACES the transcript, which also heals any overlap.
- `snapshot` frames replace the transcript; `output` frames append. An unterminated pending tail counts as the newest line so live prompts stay matchable.
- Control is the `writable` bit on `snapshot`/`state` frames (upstream dropped `info.controllerId`): writable → ours; not writable while running → user (a running terminal with no controller is indistinguishable and reported as `user`); exited/failed → none.
- Takeover notice fires once per episode (`takeoverNotified`), re-arms when a frame shows our attachment writable again.
- `exec.signal` is honored in `wait_for` (returned as `cancelled`, not thrown); `open`/`close` propagate infrastructure errors, map `terminal/limit-reached`/`terminal/unavailable` to canonical outcomes.

## Gotchas

- Upstream caps one input command at `maxInputBytes` (default 64 KiB): an oversized `write` fails the whole attachment stream (surfaced as an infrastructure error, not an ack refusal) — keep `sidebar_terminal_send` payloads under it.
- `webTerminals.recover(sessionId, refresh)` reads the Client's settled inventory when `refresh` is false and the Host never pushes its terminal list, so every discovery MUST pass `true`: with the cached read, a terminal created after the first read settled never produced a tab (fixed in 0.2.1). Each such read is one `POST /api/terminal/list`, which is why discovery is scoped to a turn's activity window instead of a global timer — a 3 s timer over every inventoried Session kept the endpoint busy while nothing was happening.
- `openTabIn` expands the sidebar column (upstream: "an open behind a collapsed panel is not an open") but does not steal keyboard focus; there is no background-open option.
- `exports["./client"]` must use a `default` condition (string) — `client-modules`'s `clientExportOf` only accepts a string or an object with a string `default`; an `import`-only condition throws at boot.
- The client bundle must have zero runtime imports (services only through `ctx`); a stray value import fails the module table at runtime and the loader purity rules upstream.
- `pnpm-workspace.yaml` and `pnpm-lock.yaml` are gitignored on purpose (local dev only), mirroring dsh-sleep.
- Schema type inference: `type` + `oneOf` on the same property collapses the type (nulls disappear) — nullable fields use `oneOf` WITHOUT `type` (see `exitCode`, `shellPath` in `src/tools.ts`).
- `tsconfig.json` `include` is `src` only — tests are NOT typechecked by `pnpm run typecheck`; run `tsc --noEmit` over `tests/` explicitly when touching shadow shapes (silent fixture debt otherwise).