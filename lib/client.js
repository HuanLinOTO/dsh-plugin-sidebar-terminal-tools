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
		* in ui-sidebar-terminal is commented out upstream), so this plugin polls
		* `ctx.webTerminals.recover(sessionId)` for every inventoried session and
		* opens each `stb-`-prefixed terminal with `ctx.sidebarRight.openTabIn`.
		*
		* Notes on the consumed surfaces (verified against the 0.2.0-rc.1 sources):
		* - `recover` already excludes terminals this window shows and terminals with
		*   unfinished closes, so the poll is naturally idempotent; the local `opened`
		*   set additionally guards the window between poll and tab mount,
		* - `openTabIn` expands the sidebar column but does not steal keyboard focus,
		*   and silently does nothing for a session whose layout is not adopted,
		* - only the `stb-` prefix is touched; the user's manual terminals never match.
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
		const DEFAULT_POLL_INTERVAL_MS = 3e3;
		const MIN_POLL_INTERVAL_MS = 250;
		/** Resolve the poll interval loudly rather than degrading silently. */
		function resolvePollIntervalMs(requested) {
			const resolved = requested ?? 3e3;
			if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved < 250) throw new Error(`sidebar-terminal-tools client: pollIntervalMs must be a safe integer >= 250`);
			return resolved;
		}
		/** Every session worth polling: the inventoried layouts plus the mounted seat. */
		function sessionsToPoll(sidebarRight) {
			const ids = /* @__PURE__ */ new Set();
			for (const tab of sidebarRight.openTabs.getSnapshot()) ids.add(tab.sessionId);
			const mounted = sidebarRight.mounted.getSnapshot();
			if (mounted !== void 0) ids.add(mounted);
			return [...ids];
		}
		/**
		* Start the auto-open polling.
		* @param ctx - client context providing `webTerminals`, `sidebarRight`, `locale`.
		* @param config - optional client configuration.
		*/
		function apply(ctx, config = {}) {
			const intervalMs = resolvePollIntervalMs(config.pollIntervalMs);
			const opened = /* @__PURE__ */ new Set();
			let busy = false;
			let failureWarned = false;
			const log = (level, text, vars) => {
				const sink = ctx.logger?.[level];
				if (sink === void 0) return;
				sink.call(ctx.logger, formatText(ctx.locale.resolveText(text), vars));
			};
			const poll = async () => {
				if (busy) return;
				busy = true;
				try {
					for (const sessionId of sessionsToPoll(ctx.sidebarRight)) {
						let recovered;
						try {
							recovered = await ctx.webTerminals.recover(sessionId);
						} catch {
							continue;
						}
						for (const entry of pickUnopened(STB_PREFIX, recovered, opened)) {
							opened.add(entry.id);
							ctx.sidebarRight.openTabIn(sessionId, "terminal", { params: { terminalId: entry.id } });
							log("info", CLIENT_STRINGS.autoOpened, { id: entry.id });
						}
					}
					failureWarned = false;
				} catch (error) {
					if (!failureWarned) {
						failureWarned = true;
						log("warn", CLIENT_STRINGS.recoverFailed, { error: error instanceof Error ? error.message : String(error) });
					}
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
		exports.MIN_POLL_INTERVAL_MS = MIN_POLL_INTERVAL_MS;
		exports.apply = apply;
		exports.inject = inject;
		exports.resolvePollIntervalMs = resolvePollIntervalMs;
		return module.exports;
	}
});
