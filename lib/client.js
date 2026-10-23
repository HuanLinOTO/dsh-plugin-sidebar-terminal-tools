window.__ModuleLoader__.load({
	id: "@huanlin/dsh-plugin-sidebar-terminal-tools",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/pick.ts
		/**
		* The pure half of the client's auto-open decision: which recovered terminals
		* deserve a tab. The prefix (`stb-`) is the same one the host half mints ids
		* with (src/registry.ts TERMINAL_ID_PREFIX) — keep them in sync.
		*
		* @module @huanlin/dsh-plugin-sidebar-terminal-tools/client/pick
		*/
		/** Terminal id prefix identifying terminals this plugin created. */
		const STB_PREFIX = "stb-";
		/**
		* Select the recovered terminals to open as tabs: only the model prefix, none
		* already opened (or still in flight) in this window, deduplicated, order kept.
		* @param prefix - the model-terminal id prefix.
		* @param recovered - one session's recover() result.
		* @param openedIds - ids this window already opened or is opening.
		*/
		function pickUnopened(prefix, recovered, openedIds) {
			const seen = /* @__PURE__ */ new Set();
			const picked = [];
			for (const entry of recovered) {
				if (!entry.id.startsWith(prefix)) continue;
				if (openedIds.has(entry.id) || seen.has(entry.id)) continue;
				seen.add(entry.id);
				picked.push(entry);
			}
			return picked;
		}
		//#endregion
		//#region src/client/locales.ts
		/** The client's whole dictionary. */
		const CLIENT_STRINGS = {
			/** Logged when a model terminal is opened as a native sidebar tab. */
			autoOpened: {
				en: "sidebar-terminal-tools: opened model terminal {id} as a sidebar tab",
				zh: "sidebar-terminal-tools：已将模型终端 {id} 打开为侧栏标签页"
			},
			/** Logged (once per outage) when a recovery poll fails. */
			recoverFailed: {
				en: "sidebar-terminal-tools: terminal recovery poll failed: {error}",
				zh: "sidebar-terminal-tools：终端恢复轮询失败：{error}"
			}
		};
		/**
		* Substitute `{name}` placeholders in a localized template.
		* @param template - the resolved template string.
		* @param vars - replacement values by name; unknown placeholders stay verbatim.
		*/
		function formatText(template, vars) {
			return template.replace(/\{(\w+)\}/g, (match, name) => name in vars ? vars[name] : match);
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Client half — auto-open the terminals the model creates as native sidebar
		* tabs. The official stack ships no automatic path (the recovery entry point
		* in ui-sidebar-terminal is commented out upstream), so this plugin watches
		* `ctx.webTerminals.recover(sessionId)` and opens each `stb-`-prefixed
		* terminal with `ctx.sidebarRight.openTabIn`.
		*
		* Discovery is ACTIVITY-SCOPED, never idle-polled. The Host never pushes its
		* terminal list, so every discovery is an `POST /api/terminal/list` round
		* trip: polling every session on a timer cost one request per session per
		* interval while nothing was happening. The forwarded `api-session/status`
		* Remote Event (idle ⇄ running, one pair per turn) therefore drives the loop
		* instead:
		*
		* - `running: true` opens that Session's activity window, which polls at
		*   `pollIntervalMs` (default 3000) so a terminal the model opens mid-turn
		*   appears within one interval,
		* - `running: false` closes the window and takes one last look, which is what
		*   catches a terminal created in the turn's final step,
		* - an idle page issues no discovery request at all. `MAX_ACTIVITY_WINDOW_MS`
		*   bounds one window so a lost status event cannot poll forever.
		*
		* Notes on the consumed surfaces (verified against the 0.2.1-rc.1 sources):
		* - `recover(sessionId, refresh)` reads the Client's settled terminal
		*   inventory unless `refresh` is true. A cached read never discovers a
		*   terminal created after the first read settled (the Host list is not
		*   pushed), so every discovery passes `refresh: true`,
		* - `recover` already excludes terminals this window shows and terminals with
		*   unfinished closes, so a repeated discovery is naturally idempotent; the
		*   local `opened` set additionally guards the window between discovery and
		*   tab mount,
		* - `openTabIn` expands the sidebar column but does not steal keyboard focus,
		*   and silently does nothing for a session whose layout is not adopted,
		* - only the `stb-` prefix is touched; the user's manual terminals never match,
		* - a host without forwarded events (`interactions=none`) has no status
		*   signal: there the loop falls back to timed polling over the inventoried
		*   Sessions, which is the pre-0.2.2 behavior.
		*
		* The bundle registers through `window.__ModuleLoader__.load({ id: <package
		* name>, factory })` (see tsdown.client.config.ts) and consumes services only
		* through the context — there are zero runtime imports.
		*
		* @module @huanlin/dsh-plugin-sidebar-terminal-tools/client
		*/
		/** Services this half waits on before applying. */
		const inject = [
			"webTerminals",
			"sidebarRight",
			"locale"
		];
		/** Narrow an optional service to the forwarded-event face. */
		function isRemoteEvents(value) {
			if (value === null || typeof value !== "object") return false;
			return typeof Reflect.get(value, "$on") === "function";
		}
		const DEFAULT_POLL_INTERVAL_MS = 3e3;
		const MIN_POLL_INTERVAL_MS = 250;
		/** Bounds one activity window so a lost `running: false` event cannot poll forever. */
		const MAX_ACTIVITY_WINDOW_MS = 6e5;
		/** Resolve the poll interval loudly rather than degrading silently. */
		function resolvePollIntervalMs(requested) {
			const resolved = requested ?? 3e3;
			if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved < 250) throw new Error(`sidebar-terminal-tools client: pollIntervalMs must be a safe integer >= 250`);
			return resolved;
		}
		/** Every session worth a first look: the inventoried layouts plus the mounted seat. */
		function sessionsToRestore(sidebarRight) {
			const ids = /* @__PURE__ */ new Set();
			for (const tab of sidebarRight.openTabs.getSnapshot()) ids.add(tab.sessionId);
			const mounted = sidebarRight.mounted.getSnapshot();
			if (mounted !== void 0) ids.add(mounted);
			return [...ids];
		}
		/**
		* Start the auto-open loop.
		* @param ctx - client context providing `webTerminals`, `sidebarRight`, `locale`.
		* @param config - optional client configuration.
		*/
		function apply(ctx, config = {}) {
			const intervalMs = resolvePollIntervalMs(config.pollIntervalMs);
			const opened = /* @__PURE__ */ new Set();
			const windows = /* @__PURE__ */ new Map();
			const inflight = /* @__PURE__ */ new Set();
			let failureWarned = false;
			let disposed = false;
			const log = (level, text, vars) => {
				const sink = ctx.logger?.[level];
				if (sink === void 0) return;
				sink.call(ctx.logger, formatText(ctx.locale.resolveText(text), vars));
			};
			/** One Session's discovery, deduplicated per Session. */
			const discover = async (sessionId) => {
				if (disposed || inflight.has(sessionId)) return;
				inflight.add(sessionId);
				try {
					const recovered = await ctx.webTerminals.recover(sessionId, true);
					for (const entry of pickUnopened(STB_PREFIX, recovered, opened)) {
						opened.add(entry.id);
						ctx.sidebarRight.openTabIn(sessionId, "terminal", { params: { terminalId: entry.id } });
						log("info", CLIENT_STRINGS.autoOpened, { id: entry.id });
					}
					failureWarned = false;
				} catch (error) {
					if (!failureWarned) {
						failureWarned = true;
						log("warn", CLIENT_STRINGS.recoverFailed, { error: error instanceof Error ? error.message : String(error) });
					}
				} finally {
					inflight.delete(sessionId);
				}
			};
			const closeWindow = (sessionId) => {
				const window = windows.get(sessionId);
				if (window === void 0) return;
				globalThis.clearInterval(window.timer);
				windows.delete(sessionId);
			};
			const tick = (sessionId) => {
				const window = windows.get(sessionId);
				if (window === void 0) return;
				if (Date.now() >= window.expiresAt) {
					closeWindow(sessionId);
					return;
				}
				discover(sessionId);
			};
			const openWindow = (sessionId) => {
				const window = windows.get(sessionId);
				if (window !== void 0) {
					window.expiresAt = Date.now() + MAX_ACTIVITY_WINDOW_MS;
					return;
				}
				const timer = globalThis.setInterval(() => {
					tick(sessionId);
				}, intervalMs);
				windows.set(sessionId, {
					timer,
					expiresAt: Date.now() + MAX_ACTIVITY_WINDOW_MS
				});
				discover(sessionId);
			};
			/** One status event: a turn started or ended. */
			const onStatus = (sessionId, running) => {
				if (running) {
					openWindow(sessionId);
					return;
				}
				closeWindow(sessionId);
				discover(sessionId);
			};
			const subscribe = (() => {
				const remote = ctx.get?.("remote");
				if (!isRemoteEvents(remote)) return void 0;
				try {
					return remote.$on("api-session/status", onStatus);
				} catch {
					return;
				}
			})();
			ctx.effect(() => () => {
				disposed = true;
				for (const sessionId of [...windows.keys()]) closeWindow(sessionId);
				subscribe?.();
			}, "sidebar-terminal-tools: auto-open loop");
			if (subscribe !== void 0) {
				for (const sessionId of sessionsToRestore(ctx.sidebarRight)) discover(sessionId);
				return;
			}
			let busy = false;
			const poll = async () => {
				if (busy) return;
				busy = true;
				try {
					for (const sessionId of sessionsToRestore(ctx.sidebarRight)) await discover(sessionId);
				} finally {
					busy = false;
				}
			};
			ctx.effect(() => {
				const timer = globalThis.setInterval(() => {
					poll();
				}, intervalMs);
				poll();
				return () => {
					globalThis.clearInterval(timer);
				};
			}, "sidebar-terminal-tools: auto-open polling");
		}
		//#endregion
		exports.DEFAULT_POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;
		exports.MAX_ACTIVITY_WINDOW_MS = MAX_ACTIVITY_WINDOW_MS;
		exports.MIN_POLL_INTERVAL_MS = MIN_POLL_INTERVAL_MS;
		exports.apply = apply;
		exports.inject = inject;
		exports.resolvePollIntervalMs = resolvePollIntervalMs;
		exports.sessionsToRestore = sessionsToRestore;
		return module.exports;
	}
});
