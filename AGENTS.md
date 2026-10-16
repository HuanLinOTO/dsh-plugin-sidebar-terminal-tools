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
| `src/endpoint.ts` | `createEndpoint` (open/send/read/waitFor/close/list), follow consumer, `detectControllerChange`, `buildUserNotice`, `MessageSourceMap` declare |
| `src/registry.ts` | `EndpointRegistry`, `TranscriptBuffer`, `mintTerminalId`/`mintAttachmentId`, `TERMINAL_ID_PREFIX` |
| `src/sanitize.ts` | ANSI/control-code stripping (keeps `\n` only) |
| `src/shadow.ts` | Structural shadow of the terminal controller + `remoteErrorCode/Details` |
| `src/wait-for.ts` | Retrieved wait core (do not reformat; upstream at huanlinoto/dsh-plugin-terminal-extension-wait-for@4dae4b8) |
| `src/client/index.ts` | Client half: poll loop over `webTerminals.recover` + `sidebarRight.openTabIn` |
| `src/client/pick.ts` | Pure `pickUnopened(prefix, recovered, openedIds)` |
| `src/client/locales.ts` | Bilingual client strings (`ctx.locale.resolveText`) |
| `tests/` | vitest: wait-for (23), sanitize, endpoint (fake controller), tools (mocked defineTool), client-pick + loop |

## Commands

```sh
pnpm run typecheck    # host tsconfig + client tsconfig
pnpm test             # vitest run
pnpm run build        # tsdown host → tsc client d.ts → tsdown client bundle (order matters: client tsdown has clean:false)
```

## Control-flow invariants

- New `follow` attachment = exclusive input controller. `send` catches `terminal/control-unavailable`, aborts the old follower, re-follows (fresh attachment), retries the write once, reports `regained_control: true`.
- Re-follow aborts the previous consumer FIRST — the old follower would otherwise double-append output; the new stream's snapshot REPLACES the transcript, which also heals any overlap.
- Takeover notice fires once per episode (`takeoverNotified`), re-arms when a frame shows our attachment back in control.
- `snapshot` frames replace the transcript; `output` frames append. An unterminated pending tail counts as the newest line so live prompts stay matchable.
- `exec.signal` is honored in `wait_for` (returned as `cancelled`, not thrown); `open`/`close` propagate infrastructure errors, map `terminal/limit-reached`/`terminal/unavailable` to canonical outcomes.

## Gotchas

- `openTabIn` expands the sidebar column (upstream: "an open behind a collapsed panel is not an open") but does not steal keyboard focus; there is no background-open option.
- `exports["./client"]` must use a `default` condition (string) — `client-modules`'s `clientExportOf` only accepts a string or an object with a string `default`; an `import`-only condition throws at boot.
- The client bundle must have zero runtime imports (services only through `ctx`); a stray value import fails the module table at runtime and the loader purity rules upstream.
- `pnpm-workspace.yaml` and `pnpm-lock.yaml` are gitignored on purpose (local dev only), mirroring dsh-sleep.
- Schema type inference: `type` + `oneOf` on the same property collapses the type (nulls disappear) — nullable fields use `oneOf` WITHOUT `type` (see `exitCode`, `shellPath` in `src/tools.ts`).
