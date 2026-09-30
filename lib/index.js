import z from "@deepseek-ai/schemastery";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/registry.ts
/** Plugin-wide terminal identity prefix (the client half matches the same prefix). */
const TERMINAL_ID_PREFIX = "stb-";
/** Terminal identity rule of the controller, mirrored (`/^[\w-]{1,128}$/`). */
const CONTROLLER_ID_RE = /^[\w-]{1,128}$/;
let attachmentCounter = 0;
/**
* Mint one attachment identity for a follow subscription. Re-following with a
* fresh identity is what reclaims exclusive input control.
*/
function mintAttachmentId() {
	attachmentCounter += 1;
	return `stb-att-${attachmentCounter}-${Math.random().toString(36).slice(2, 10)}`;
}
/**
* Mint the model-facing terminal id for registry sequence `seq`
* (`stb-<seq>-<rand>`): controller-legal, monotonic in `seq`, unique per call.
*/
function mintTerminalId(seq) {
	const id = `${TERMINAL_ID_PREFIX}${seq}-${Math.random().toString(36).slice(2, 10)}`;
	if (!CONTROLLER_ID_RE.test(id) || !/^stb-[\w-]{1,120}$/.test(id)) throw new Error(`sidebar-terminal-tools: minted an invalid terminal id ${id}`);
	return id;
}
/** Byte length in UTF-8 without allocating when the text is plain ASCII. */
function byteLength(text) {
	return Buffer.byteLength(text, "utf8");
}
/** Keep the trailing `maxBytes` of `text`, dropping a damaged leading surrogate. */
function tailBytes(text, maxBytes) {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= maxBytes) return text;
	return bytes.subarray(bytes.byteLength - maxBytes).toString("utf8").replace(/^\uFFFD/, "");
}
/**
* A line/byte-bounded plain-text transcript fed by the follow consumer.
* `read` pages with newest-relative offsets (the contract `scanPage` in
* wait-for.ts expects); an unterminated pending tail counts as the newest
* line so live prompts stay matchable.
*/
var TranscriptBuffer = class {
	limits;
	lines = [];
	pending = "";
	bytes = 0;
	truncated = false;
	constructor(limits) {
		this.limits = limits;
	}
	/** Total effective lines, pending tail included. */
	get totalLines() {
		return this.lines.length + (this.pending.length > 0 ? 1 : 0);
	}
	/** Whether any content was ever dropped or shortened by the bounds. */
	get wasTruncated() {
		return this.truncated;
	}
	/** Append an output delta; complete lines commit, the tail stays pending. */
	append(text) {
		this.pending += text;
		const parts = this.pending.split("\n");
		this.pending = parts.pop() ?? "";
		for (const line of parts) this.commitLine(line);
		this.boundPending();
	}
	/** Replace the whole transcript with a serialized screen (re-attach snapshot). */
	replace(text) {
		this.lines = [];
		this.pending = "";
		this.bytes = 0;
		const parts = text.split("\n");
		this.pending = parts.pop() ?? "";
		for (const line of parts) this.commitLine(line);
		this.boundPending();
	}
	/** Newest-relative paged read over the effective (complete + pending) lines. */
	read(request = {}) {
		const offset = Math.max(0, Math.floor(request.offset ?? 0));
		const count = Math.max(1, Math.floor(request.count ?? 500));
		const total = this.totalLines;
		if (offset >= total) return {
			text: "",
			totalLines: total,
			lineBegin: offset,
			lineEnd: offset,
			truncated: this.truncated
		};
		const end = total - offset;
		const start = Math.max(0, end - count);
		const text = (this.pending.length > 0 ? [...this.lines, this.pending] : this.lines).slice(start, end).join("\n");
		return {
			text,
			totalLines: total,
			lineBegin: offset,
			lineEnd: offset + (text.length === 0 ? 0 : text.split("\n").length),
			truncated: this.truncated
		};
	}
	commitLine(line) {
		this.lines.push(line);
		this.bytes += byteLength(line) + 1;
		this.trim();
	}
	/** Keep the newest bytes of a runaway pending tail (no-newline firehoses). */
	boundPending() {
		if (byteLength(this.pending) <= this.limits.maxBytes) return;
		this.pending = tailBytes(this.pending, this.limits.maxBytes);
		this.truncated = true;
	}
	trim() {
		while (this.lines.length > this.limits.maxLines) this.dropOldest();
		while (this.bytes > this.limits.maxBytes) {
			if (this.lines.length <= 1) {
				const kept = tailBytes(this.lines[0] ?? "", this.limits.maxBytes);
				this.bytes = byteLength(kept);
				this.lines = kept.length > 0 ? [kept] : [];
				this.truncated = true;
				return;
			}
			this.dropOldest();
		}
	}
	dropOldest() {
		const oldest = this.lines.shift();
		if (oldest === void 0) return;
		this.bytes -= byteLength(oldest) + 1;
		if (this.bytes < 0) this.bytes = 0;
		this.truncated = true;
	}
};
/**
* Terminals this plugin created, keyed by owner session id, with a process-wide
* monotonic id sequence. Nothing here ever lists a user's manual terminal.
*/
var EndpointRegistry = class {
	owners = /* @__PURE__ */ new Map();
	sequence = 0;
	/** Advance and read the terminal id sequence (monotonic, never reissued). */
	nextSequence() {
		this.sequence += 1;
		return this.sequence;
	}
	/** The largest issued sequence (diagnostics). */
	get issuedSequences() {
		return this.sequence;
	}
	/** Look up one managed terminal for an owner. */
	get(ownerId, terminalId) {
		return this.owners.get(ownerId)?.terminals.get(terminalId);
	}
	/** All managed terminals of one owner, in creation order. */
	list(ownerId) {
		const owner = this.owners.get(ownerId);
		return owner === void 0 ? [] : [...owner.terminals.values()];
	}
	/** Register a freshly created terminal (idempotent per owner+id). */
	register(agent, terminalId, info, limits) {
		let owner = this.owners.get(agent.id);
		if (owner === void 0) {
			owner = {
				agent,
				terminals: /* @__PURE__ */ new Map()
			};
			this.owners.set(agent.id, owner);
		}
		const existing = owner.terminals.get(terminalId);
		if (existing !== void 0) return existing;
		const managed = {
			info,
			attachmentId: "",
			transcript: new TranscriptBuffer(limits),
			follow: new AbortController(),
			takeoverNotified: false
		};
		owner.terminals.set(terminalId, managed);
		return managed;
	}
	/** Drop one terminal record (returns the removed record, if present). */
	remove(ownerId, terminalId) {
		const owner = this.owners.get(ownerId);
		const removed = owner?.terminals.get(terminalId);
		owner?.terminals.delete(terminalId);
		if (owner !== void 0 && owner.terminals.size === 0) this.owners.delete(ownerId);
		return removed;
	}
	/** Abort every follow consumer and clear all records (plugin dispose). */
	dispose() {
		for (const owner of this.owners.values()) for (const managed of owner.terminals.values()) managed.follow.abort();
		this.owners.clear();
	}
};
//#endregion
//#region src/sanitize.ts
/**
* ANSI/control-code cleaning for terminal transcripts.
*
* The follow stream delivers a serialized xterm screen (`snapshot`) and raw
* PTY deltas (`output`), both full of escape sequences. The transcript keeps
* plain text only: CSI/OSC/DCS and nF escapes are removed, single-character
* control codes are removed, and newlines are preserved as the sole line
* separator (a CRLF pair therefore becomes one `\n`).
*
* @module @huanlin/dsh-plugin-sidebar-terminal-tools/sanitize
*/
/** One alternation per escape family, then the C0-minus-newline sweep. */
const ESCAPE_OR_CONTROL = new RegExp([
	"\\x1b\\[[0-9;?]*[ -/]*[@-~]",
	"\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)",
	"\\x1b[P^_][^\\x1b]*(?:\\x1b\\\\)?",
	"\\x1b[ -/]*[0-~]",
	"[\\x00-\\x09\\x0b-\\x1f\\x7f]"
].join("|"), "g");
/**
* Strip ANSI escape sequences and non-newline control codes from terminal text.
* @param text - raw screen serialization or PTY output delta.
* @returns plain text whose only control character is `\n`.
*/
function sanitizeTerminalText(text) {
	return text.replace(ESCAPE_OR_CONTROL, "");
}
//#endregion
//#region src/shadow.ts
/** Narrow an unknown thrown value to its RemoteError-style `code`, if any. */
function remoteErrorCode(error) {
	if (typeof error !== "object" || error === null) return void 0;
	const code = error.code;
	return typeof code === "string" ? code : void 0;
}
/** Read the `details` payload of a RemoteError-shaped value, when present. */
function remoteErrorDetails(error) {
	if (typeof error !== "object" || error === null) return void 0;
	const details = error.details;
	return typeof details === "object" && details !== null ? details : void 0;
}
//#endregion
//#region src/wait-for.ts
/**
* Compile the caller pattern as a JavaScript regular expression; a pattern that
* fails to compile falls back to verbatim substring matching (better-sidebar
* precedent). Matching is case-sensitive and stateless.
*/
function compilePattern(pattern) {
	try {
		const expression = new RegExp(pattern);
		return {
			source: pattern,
			isRegex: true,
			match(line) {
				const found = expression.exec(line);
				return found === null ? null : {
					index: found.index,
					match: found[0]
				};
			}
		};
	} catch {
		return {
			source: pattern,
			isRegex: false,
			match(line) {
				const index = line.indexOf(pattern);
				return index < 0 ? null : {
					index,
					match: pattern
				};
			}
		};
	}
}
/**
* Resolve a per-call `timeout_ms` against the configured bounds: a missing or
* non-finite request uses the default; everything else is floored and clamped.
*/
function resolveTimeoutMs(requested, config) {
	const base = typeof requested === "number" && Number.isFinite(requested) ? Math.floor(requested) : config.defaultTimeoutMs;
	return Math.min(config.maxTimeoutMs, Math.max(config.minTimeoutMs, base));
}
/**
* Sleep for `ms`, resolving `false` when `signal` aborts first and `true` when
* the timer completes. An already-aborted signal resolves `false` without
* scheduling a timer; the abort listener is removed on both paths.
*/
function sleepWithAbort(ms, signal) {
	if (signal.aborted) return Promise.resolve(false);
	if (!(ms > 0)) return Promise.resolve(true);
	return new Promise((resolve) => {
		let timer;
		const onAbort = () => {
			if (timer !== void 0) clearTimeout(timer);
			resolve(false);
		};
		timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
function boundChars(text, maxChars) {
	if (maxChars <= 0) return "";
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…[truncated]`;
}
/**
* Keep the trailing UTF-8 bytes of `text`. A cut through a code point drops the
* damaged leading replacement character rather than emitting it.
*/
function boundTailBytes(text, maxBytes) {
	if (maxBytes <= 0) return "";
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= maxBytes) return text;
	return buffer.subarray(buffer.byteLength - maxBytes).toString("utf8").replace(/^\uFFFD/, "");
}
/**
* Scan one retained-output page for the first line matching `pattern`. The
* absolute line index is `totalLines - lineEnd + indexInPage`, matching the
* backend's newest-relative paging.
*/
function scanPage(page, pattern, options) {
	const lines = page.text.length === 0 ? [] : page.text.split("\n");
	const absoluteStart = Math.max(0, page.totalLines - page.lineEnd);
	let match = null;
	let line = -1;
	let lineText = "";
	for (let index = 0; index < lines.length; index += 1) {
		const found = pattern.match(lines[index] ?? "");
		if (found !== null) {
			match = found;
			line = absoluteStart + index;
			lineText = lines[index] ?? "";
			break;
		}
	}
	const tailSource = options.tailLines > 0 ? lines.slice(-options.tailLines).join("\n") : "";
	return {
		match,
		line,
		column: match?.index ?? -1,
		lineText: boundChars(lineText, options.maxLineTextChars),
		totalLines: page.totalLines,
		tail: boundTailBytes(tailSource, options.maxTailBytes),
		scannedLines: lines.length
	};
}
/** Recognize the terminal registry's `NO_SESSION` error by its stable code. */
function isNoSessionError(error) {
	return typeof error === "object" && error !== null && error.code === "NO_SESSION";
}
/**
* Poll retained output until the pattern matches, the deadline elapses, the
* session exits or disappears, or the signal aborts. The first scan happens
* immediately, so a pattern already present resolves without sleeping.
*/
async function waitForPattern(deps, request) {
	const start = deps.now();
	for (;;) {
		let page;
		try {
			page = deps.read(request.sessionId);
		} catch (error) {
			if (isNoSessionError(error)) return {
				kind: "gone",
				elapsedMs: deps.now() - start
			};
			throw error;
		}
		const scan = scanPage(page, request.pattern, request);
		if (scan.match !== null) return {
			kind: "found",
			match: scan.match.match,
			line: scan.line,
			column: scan.column,
			lineText: scan.lineText,
			elapsedMs: deps.now() - start,
			scannedLines: scan.scannedLines
		};
		const snapshot = deps.list().find((item) => item.sessionId === request.sessionId);
		if (snapshot === void 0) return {
			kind: "gone",
			elapsedMs: deps.now() - start
		};
		if (snapshot.status.kind === "exited") return {
			kind: "exited",
			exitCode: snapshot.status.exitCode,
			signal: snapshot.status.signal,
			elapsedMs: deps.now() - start
		};
		const elapsed = deps.now() - start;
		const remaining = request.timeoutMs - elapsed;
		if (remaining <= 0) return {
			kind: "timeout",
			timeoutMs: request.timeoutMs,
			totalLines: scan.totalLines,
			tail: scan.tail,
			scannedLines: scan.scannedLines,
			elapsedMs: elapsed
		};
		if (!await deps.sleep(Math.min(request.pollIntervalMs, remaining), request.signal)) return {
			kind: "cancelled",
			elapsedMs: deps.now() - start
		};
	}
}
/** Project a wait outcome to the model-facing text (pure; replay-safe). */
function renderWaitOutcome(value) {
	switch (value.kind) {
		case "found": return `[found] match ${JSON.stringify(value.match)} at line ${value.line}, column ${value.column} (waited ${value.elapsedMs}ms)\n${value.lineText}`;
		case "timeout": return `[timeout] pattern did not appear within ${value.timeoutMs}ms; ${value.totalLines} lines retained, scanned ${value.scannedLines}. Tail:\n${value.tail}`;
		case "exited": return `[exited] terminal session exited (${value.exitCode ?? value.signal ?? "unknown"}) before the pattern appeared (waited ${value.elapsedMs}ms)`;
		case "gone": return `[gone] terminal session no longer exists; the pattern was not seen (waited ${value.elapsedMs}ms)`;
		case "cancelled": return `[cancelled] wait was cancelled after ${value.elapsedMs}ms`;
	}
}
//#endregion
//#region src/endpoint.ts
/**
* The endpoint core: operations over the shadowed terminal controller and the
* owner-scoped registry. Every operation runs against terminals this plugin
* created; `send` regains control by re-following when the user holds it; the
* follow consumer maintains the sanitized transcript and fires (once per
* episode) an inject notice when the user takes over.
*
* Conventions (plugin-development-guide.md §3):
*   C4 — operations return canonical JSON values; rendering lives in tools.ts.
*   C5 — non-ideal business outcomes (limit_reached, regained_control, the
*        wait_for five-state) are values; infrastructure failures throw.
*   C6 — the caller's signal is honored at every await point.
*
* @module @huanlin/dsh-plugin-sidebar-terminal-tools/endpoint
*/
/**
* Classify who holds input control in a state frame.
* @param info - the frame's terminal metadata.
* @param ourAttachment - the attachment identity our consumer follows with.
* @returns 'user' when someone else controls, 'ours' when we do, 'unattached' otherwise.
*/
function detectControllerChange(info, ourAttachment) {
	if (info.controllerId === void 0) return "unattached";
	return info.controllerId === ourAttachment ? "ours" : "user";
}
/** The takeover reminder the model receives via `agent.inject`. */
const NOTICE_TEMPLATE = (terminalId) => `Sidebar terminal ${terminalId}: the user took over input and may have run their own commands. Read the transcript before acting; your next sidebar_terminal_send will reclaim control.`;
/**
* Build the one-shot user-takeover notice (a frozen user-role message whose
* id `createUserMessage` mints internally).
* @param terminalId - the taken-over terminal.
* @param maxMessageChars - hard bound on the notice text.
*/
function buildUserNotice(terminalId, maxMessageChars) {
	const text = NOTICE_TEMPLATE(terminalId);
	return createUserMessage({
		content: [{
			type: "text",
			text: text.length <= maxMessageChars ? text : `${text.slice(0, Math.max(0, maxMessageChars - 1))}…`
		}],
		source: {
			kind: "sidebar-terminal-tools",
			form: "notice",
			summary: boundContextSummary(`user took over terminal ${terminalId}`)
		}
	});
}
/** Unknown-terminal error for ids outside this owner's registry. */
function unknownTerminal(ownerId, terminalId) {
	return /* @__PURE__ */ new Error(`unknown sidebar terminal ${JSON.stringify(terminalId)} for session ${JSON.stringify(ownerId)}; open one with sidebar_terminal_open or list with sidebar_terminal_list`);
}
/** Map a terminal state to the wait_for session-status shape. */
function statusOf(info) {
	return info.state === "running" ? { kind: "running" } : {
		kind: "exited",
		exitCode: info.exitCode,
		signal: null
	};
}
/**
* Start (or restart) the background follow consumer for one managed terminal.
* Each frame is processed as it arrives — no queueing between frames — which
* is the backpressure answer for the controller's 2 MiB per-follower cap.
* @returns a latch that settles once the baseline snapshot was processed (or
* the stream ended/failed before one arrived).
*/
function attachFollower(controller, registry, owner, terminalId, managed, config) {
	managed.follow.abort();
	managed.follow = new AbortController();
	const attachmentId = mintAttachmentId();
	managed.attachmentId = attachmentId;
	managed.takeoverNotified = false;
	let settleStarted;
	const started = new Promise((resolve) => {
		settleStarted = resolve;
	});
	const signal = managed.follow.signal;
	(async () => {
		let first = true;
		try {
			const iterator = controller.follow(owner, terminalId, attachmentId, signal)[Symbol.asyncIterator]();
			const onAbort = () => {
				iterator.return?.(void 0);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				for (;;) {
					const next = await iterator.next();
					if (next.done === true) break;
					const frame = next.value;
					if (frame.type === "snapshot") {
						managed.info = frame.info;
						managed.transcript.replace(sanitizeTerminalText(frame.screen));
					} else if (frame.type === "output") managed.transcript.append(sanitizeTerminalText(frame.data));
					else {
						managed.info = frame.info;
						const control = detectControllerChange(frame.info, attachmentId);
						if (control === "user" && !managed.takeoverNotified) {
							managed.takeoverNotified = true;
							try {
								owner.inject(buildUserNotice(terminalId, config.maxMessageChars));
							} catch {}
						} else if (control === "ours") managed.takeoverNotified = false;
					}
					if (first) {
						first = false;
						settleStarted();
					}
				}
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		} catch {} finally {
			if (first) settleStarted();
		}
	})();
	return started;
}
/** Bind `read` for wait_for to the live registry record (NO_SESSION → gone). */
function waitRead(ownerId, terminalId, registry, config) {
	return () => {
		const managed = registry.get(ownerId, terminalId);
		if (managed === void 0) throw Object.assign(/* @__PURE__ */ new Error(`terminal ${terminalId} is gone`), { code: "NO_SESSION" });
		return managed.transcript.read({
			offset: 0,
			count: config.transcriptLines
		});
	};
}
/**
* Compose the endpoint core over one controller and registry.
* @param controller - the shadowed `ctx.terminalController`.
* @param registry - this plugin's owner-scoped terminal registry.
* @param config - resolved bounds.
*/
function createEndpoint(controller, registry, config) {
	const limits = {
		maxLines: config.transcriptLines,
		maxBytes: config.transcriptBytes
	};
	return {
		async open(owner, request) {
			const cols = request.cols ?? 80;
			const rows = request.rows ?? 24;
			const terminalId = mintTerminalId(registry.nextSequence());
			let info;
			try {
				info = await controller.create(owner, {
					id: terminalId,
					cols,
					rows,
					...request.shellPath === void 0 ? {} : { shellPath: request.shellPath }
				}, new AbortController().signal);
			} catch (error) {
				if (remoteErrorCode(error) === "terminal/limit-reached") {
					const limit = remoteErrorDetails(error)?.limit;
					return {
						outcome: "limit_reached",
						limit: typeof limit === "number" ? limit : 8,
						message: "The session terminal quota is exhausted (terminals are shared with your manual sidebar terminals); close terminals you no longer need with sidebar_terminal_close and retry."
					};
				}
				throw error;
			}
			await attachFollower(controller, registry, owner, terminalId, registry.register(owner, terminalId, info, limits), config);
			return {
				outcome: "opened",
				terminalId,
				shell: info.shell.name,
				shellPath: info.shell.path,
				cwd: info.cwd,
				cols: info.cols,
				rows: info.rows,
				state: info.state
			};
		},
		async send(owner, terminalId, text, options) {
			const managed = registry.get(owner.id, terminalId);
			if (managed === void 0) throw unknownTerminal(owner.id, terminalId);
			const payload = options?.enter === false ? text : `${text}\r`;
			let regainedControl = false;
			try {
				await controller.write(owner, terminalId, managed.attachmentId, payload);
			} catch (error) {
				if (remoteErrorCode(error) !== "terminal/control-unavailable") throw error;
				regainedControl = true;
				await attachFollower(controller, registry, owner, terminalId, managed, config);
				await controller.write(owner, terminalId, managed.attachmentId, payload);
			}
			return {
				wrote: payload.length,
				regained_control: regainedControl,
				state: managed.info.state
			};
		},
		read(owner, terminalId, request) {
			const managed = registry.get(owner.id, terminalId);
			if (managed === void 0) throw unknownTerminal(owner.id, terminalId);
			return {
				...managed.transcript.read(request),
				state: managed.info.state,
				exitCode: managed.info.exitCode
			};
		},
		async waitFor(owner, terminalId, request, signal) {
			if (registry.get(owner.id, terminalId) === void 0) throw unknownTerminal(owner.id, terminalId);
			return waitForPattern({
				read: waitRead(owner.id, terminalId, registry, config),
				list: () => {
					const live = registry.get(owner.id, terminalId);
					return live === void 0 ? [] : [{
						sessionId: terminalId,
						status: statusOf(live.info)
					}];
				},
				now: () => Date.now(),
				sleep: sleepWithAbort
			}, {
				sessionId: terminalId,
				pattern: compilePattern(request.pattern),
				timeoutMs: resolveTimeoutMs(request.timeoutMs, config),
				pollIntervalMs: config.pollIntervalMs,
				tailLines: config.tailLines,
				maxLineTextChars: config.maxLineTextChars,
				maxTailBytes: config.maxTailBytes,
				signal
			});
		},
		async close(owner, terminalId) {
			const managed = registry.get(owner.id, terminalId);
			if (managed === void 0) throw unknownTerminal(owner.id, terminalId);
			try {
				await controller.close(owner, terminalId);
			} catch (error) {
				if (remoteErrorCode(error) !== "terminal/unavailable") throw error;
			}
			managed.follow.abort();
			registry.remove(owner.id, terminalId);
			return {
				closed: true,
				terminalId
			};
		},
		list(owner) {
			return registry.list(owner.id).map((managed) => {
				const control = detectControllerChange(managed.info, managed.attachmentId);
				return {
					terminalId: managed.info.id,
					title: managed.info.title,
					shell: managed.info.shell.name,
					cwd: managed.info.cwd,
					state: managed.info.state,
					exitCode: managed.info.exitCode,
					lines: managed.transcript.totalLines,
					controller: control === "unattached" ? "none" : control === "ours" ? "plugin" : "user"
				};
			});
		}
	};
}
//#endregion
//#region src/tools.ts
/**
* The six `sidebar_terminal_*` tool definitions: thin adapters that parse
* arguments, drive the endpoint core, and project canonical values to text.
* The canonical shapes are the contract — the schema and the execute return
* value must stay name-for-name identical.
*
* @module @huanlin/dsh-plugin-sidebar-terminal-tools/tools
*/
const OPEN_DESCRIPTION = "Open a new terminal in the user's right sidebar and attach to it. The terminal runs a real interactive shell with the system user's permissions — no Agent sandbox, no approval gate — and appears in the user's sidebar automatically; the user can watch it and take over input at any time. Return its terminalId and use sidebar_terminal_send / sidebar_terminal_read / sidebar_terminal_wait_for to drive it. Terminals share one per-session quota with the user's manual sidebar terminals (8 by default); when the quota is exhausted the result is limit_reached — close unused terminals and retry.";
const SEND_DESCRIPTION = "Write text into a sidebar terminal you opened with sidebar_terminal_open. A carriage return is appended unless enter is false, so the default is \"run this command\". If the user has taken over the terminal, this call silently reclaims input control (regained_control: true) before writing; check the transcript with sidebar_terminal_read first, since the user may have run their own commands.";
const READ_DESCRIPTION = "Read the retained plain-text transcript of one sidebar terminal, newest page first. offset counts lines from the end (0 = newest page); count bounds the page size. Escape sequences are already stripped and the transcript is bounded (oldest lines drop out first).";
const WAIT_FOR_DESCRIPTION = "Block until a pattern appears in a sidebar terminal's retained transcript, or until the timeout elapses, or until the shell exits or the terminal disappears — whichever happens first. Does not write input, so it is safe while a long command is still running. The pattern is a JavaScript regular expression (case-sensitive); a pattern that fails to compile falls back to verbatim substring matching. One pattern may cover several outcomes, e.g. (BUILD OK|BUILD FAIL) — the found result's match field tells which alternative hit. Returns kind=found with the matched text, line number, column and line text; kind=timeout with a bounded tail; kind=exited or kind=gone; or kind=cancelled when the call is aborted.";
const CLOSE_DESCRIPTION = "Close one sidebar terminal you opened (kills its shell) and release its transcript. The per-session terminal quota is shared with the user's manual sidebar terminals, so close what you no longer need.";
const LIST_DESCRIPTION = "List the sidebar terminals this session opened (ids, states, sizes, and who currently holds input control).";
/** Output schema of `sidebar_terminal_open`: the two canonical outcomes. */
const OPEN_SCHEMA = { oneOf: [{
	type: "object",
	additionalProperties: false,
	properties: {
		outcome: {
			type: "string",
			required: true,
			const: "opened"
		},
		terminalId: {
			type: "string",
			required: true,
			description: "Terminal id for the other sidebar_terminal_* tools."
		},
		shell: {
			type: "string",
			required: true,
			description: "Human-readable shell name."
		},
		shellPath: {
			required: true,
			oneOf: [{ type: "string" }, { type: "null" }],
			description: "Shell executable path, or null when the default shell was used."
		},
		cwd: {
			type: "string",
			required: true,
			description: "Initial working directory."
		},
		cols: {
			type: "integer",
			required: true
		},
		rows: {
			type: "integer",
			required: true
		},
		state: {
			type: "string",
			required: true,
			enum: [
				"running",
				"exited",
				"failed"
			]
		}
	}
}, {
	type: "object",
	additionalProperties: false,
	properties: {
		outcome: {
			type: "string",
			required: true,
			const: "limit_reached"
		},
		limit: {
			type: "integer",
			required: true,
			description: "The per-session terminal quota that was exhausted."
		},
		message: {
			type: "string",
			required: true,
			description: "What to do about it."
		}
	}
}] };
/** Output schema of `sidebar_terminal_wait_for`: the five canonical outcomes. */
const OUTCOME_SCHEMA = { oneOf: [
	{
		type: "object",
		additionalProperties: false,
		properties: {
			kind: {
				type: "string",
				required: true,
				const: "found"
			},
			match: {
				type: "string",
				required: true,
				description: "The text that actually matched; for a multi-outcome pattern this tells which alternative hit."
			},
			line: {
				type: "integer",
				required: true,
				description: "0-based line index in the retained transcript."
			},
			column: {
				type: "integer",
				required: true,
				description: "0-based character index of the match within its line."
			},
			lineText: {
				type: "string",
				required: true,
				description: "The full matched line, possibly truncated."
			},
			elapsedMs: {
				type: "integer",
				required: true,
				description: "Wall-clock milliseconds from wait start to the match."
			},
			scannedLines: {
				type: "integer",
				required: true,
				description: "Lines scanned in the matching poll."
			}
		}
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			kind: {
				type: "string",
				required: true,
				const: "timeout"
			},
			timeoutMs: {
				type: "integer",
				required: true,
				description: "The configured timeout that elapsed."
			},
			totalLines: {
				type: "integer",
				required: true,
				description: "Lines retained when the timeout fired."
			},
			tail: {
				type: "string",
				required: true,
				description: "Bounded tail of the retained transcript at the timeout."
			},
			scannedLines: {
				type: "integer",
				required: true,
				description: "Lines scanned in the final poll."
			},
			elapsedMs: {
				type: "integer",
				required: true,
				description: "Wall-clock milliseconds actually waited."
			}
		}
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			kind: {
				type: "string",
				required: true,
				const: "exited"
			},
			exitCode: {
				required: true,
				oneOf: [{ type: "integer" }, { type: "null" }],
				description: "Exit code of the top-level shell, if known."
			},
			signal: {
				required: true,
				oneOf: [{ type: "string" }, { type: "null" }],
				description: "Exit signal of the top-level shell, if killed by one."
			},
			elapsedMs: {
				type: "integer",
				required: true,
				description: "Wall-clock milliseconds waited before the exit was observed."
			}
		}
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			kind: {
				type: "string",
				required: true,
				const: "gone"
			},
			elapsedMs: {
				type: "integer",
				required: true,
				description: "Wall-clock milliseconds waited before the terminal disappeared."
			}
		}
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			kind: {
				type: "string",
				required: true,
				const: "cancelled"
			},
			elapsedMs: {
				type: "integer",
				required: true,
				description: "Wall-clock milliseconds waited before the call was aborted."
			}
		}
	}
] };
/** Register the six tools against `ctx.tools`. */
function registerTools(ctx, deps) {
	const { endpoint, config } = deps;
	const requireAgent = (agent) => {
		if (agent === void 0) throw new Error("sidebar_terminal_* tools require an initiating agent");
		return agent;
	};
	const requireId = (terminalId) => {
		if (typeof terminalId !== "string" || terminalId.length === 0) throw new Error("terminalId must be a non-empty string");
		return terminalId;
	};
	ctx.tools.register(defineTool({
		name: "sidebar_terminal_open",
		description: OPEN_DESCRIPTION,
		parameters: {
			cols: {
				type: "integer",
				description: "Initial width in columns (default 80; 2–500)."
			},
			rows: {
				type: "integer",
				description: "Initial height in rows (default 24; 1–200)."
			},
			shell_path: {
				type: "string",
				description: "Executable path of a discovered shell; omit for the environment default."
			}
		},
		output: {
			schema: OPEN_SCHEMA,
			render: (_args, value) => {
				const opened = value;
				return [{
					type: "text",
					text: opened.outcome === "opened" ? `opened terminal ${opened.terminalId} (${opened.shell}, ${opened.cwd}, ${opened.cols}x${opened.rows})` : `[limit_reached] terminal quota of ${opened.limit} is exhausted — ${opened.message ?? ""}`
				}];
			}
		},
		async execute(args, exec) {
			const owner = requireAgent(exec.agent);
			const input = args;
			return endpoint.open(owner, {
				...input.cols === void 0 ? {} : { cols: input.cols },
				...input.rows === void 0 ? {} : { rows: input.rows },
				...input.shell_path === void 0 || input.shell_path.length === 0 ? {} : { shellPath: input.shell_path }
			});
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Open sidebar terminal${typeof args.shell_path === "string" && args.shell_path.length > 0 ? ` (${args.shell_path})` : ""}`,
			kind: "execute"
		})
	}));
	ctx.tools.register(defineTool({
		name: "sidebar_terminal_send",
		description: SEND_DESCRIPTION,
		parameters: {
			terminalId: {
				type: "string",
				required: true,
				description: "Terminal id returned by sidebar_terminal_open."
			},
			text: {
				type: "string",
				required: true,
				description: "Raw input to deliver; a carriage return is appended unless enter is false."
			},
			enter: {
				type: "boolean",
				description: "Append a carriage return (default true)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					wrote: {
						type: "integer",
						required: true,
						description: "Characters delivered, the appended carriage return included."
					},
					regained_control: {
						type: "boolean",
						required: true,
						description: "True when the user held input control and this call reclaimed it before writing."
					},
					state: {
						type: "string",
						required: true,
						enum: [
							"running",
							"exited",
							"failed"
						]
					}
				}
			},
			render: (_args, value) => {
				const sent = value;
				return [{
					type: "text",
					text: `sent ${sent.wrote} chars (${sent.state}${sent.regained_control ? "; reclaimed control from the user" : ""})`
				}];
			}
		},
		async execute(args, exec) {
			const owner = requireAgent(exec.agent);
			const input = args;
			const terminalId = requireId(input.terminalId);
			if (input.text.length === 0) throw new Error("text must be a non-empty string");
			return endpoint.send(owner, terminalId, input.text, input.enter === void 0 ? {} : { enter: input.enter });
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Send to sidebar terminal ${args.terminalId}`,
			kind: "execute",
			rawInput: args.text
		})
	}));
	ctx.tools.register(defineTool({
		name: "sidebar_terminal_read",
		description: READ_DESCRIPTION,
		parameters: {
			terminalId: {
				type: "string",
				required: true,
				description: "Terminal id returned by sidebar_terminal_open."
			},
			offset: {
				type: "integer",
				description: "Lines from the newest end to skip (default 0)."
			},
			count: {
				type: "integer",
				description: "Maximum lines to return (default 500)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: {
						type: "string",
						required: true,
						description: "The requested page of transcript lines joined by newlines."
					},
					totalLines: {
						type: "integer",
						required: true,
						description: "Lines currently retained."
					},
					lineBegin: {
						type: "integer",
						required: true,
						description: "Newest-relative offset of the first returned line."
					},
					lineEnd: {
						type: "integer",
						required: true,
						description: "Newest-relative offset after the returned page."
					},
					truncated: {
						type: "boolean",
						required: true,
						description: "Whether transcript bounds dropped older content."
					},
					state: {
						type: "string",
						required: true,
						enum: [
							"running",
							"exited",
							"failed"
						]
					},
					exitCode: {
						description: "Exit code once the shell has exited, null while running.",
						required: true,
						oneOf: [{ type: "integer" }, { type: "null" }]
					}
				}
			},
			render: (_args, value) => {
				const page = value;
				return [{
					type: "text",
					text: `${page.text.length > 0 ? page.text : "(no output yet)"}\n[${page.state}; ${page.totalLines} lines retained]`
				}];
			}
		},
		async execute(args, exec) {
			const owner = requireAgent(exec.agent);
			const input = args;
			const terminalId = requireId(input.terminalId);
			return endpoint.read(owner, terminalId, {
				...input.offset === void 0 ? {} : { offset: input.offset },
				...input.count === void 0 ? {} : { count: input.count }
			});
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Read sidebar terminal ${args.terminalId}`,
			kind: "read"
		})
	}));
	ctx.tools.register(defineTool({
		name: "sidebar_terminal_wait_for",
		description: WAIT_FOR_DESCRIPTION,
		parameters: {
			terminalId: {
				type: "string",
				required: true,
				description: "Terminal id returned by sidebar_terminal_open."
			},
			pattern: {
				type: "string",
				required: true,
				description: "JavaScript regular expression to wait for (case-sensitive); an invalid pattern falls back to verbatim substring matching. Must be non-empty."
			},
			timeout_ms: {
				type: "integer",
				description: "Maximum wait in milliseconds. Defaults to the plugin default and is clamped to the plugin bounds."
			}
		},
		output: {
			schema: OUTCOME_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: renderWaitOutcome(value)
			}]
		},
		async execute(args, exec) {
			const owner = requireAgent(exec.agent);
			const input = args;
			const terminalId = requireId(input.terminalId);
			if (input.pattern.length === 0) throw new Error("pattern must be a non-empty string");
			return endpoint.waitFor(owner, terminalId, {
				pattern: input.pattern,
				...input.timeout_ms === void 0 ? {} : { timeoutMs: input.timeout_ms }
			}, exec.signal);
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Wait on sidebar terminal ${args.terminalId}`,
			kind: "read",
			rawInput: args.pattern
		})
	}));
	ctx.tools.register(defineTool({
		name: "sidebar_terminal_close",
		description: CLOSE_DESCRIPTION,
		parameters: { terminalId: {
			type: "string",
			required: true,
			description: "Terminal id returned by sidebar_terminal_open."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					closed: {
						type: "boolean",
						required: true
					},
					terminalId: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `closed terminal ${value.terminalId}`
			}]
		},
		async execute(args, exec) {
			const owner = requireAgent(exec.agent);
			const input = args;
			return endpoint.close(owner, requireId(input.terminalId));
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Close sidebar terminal ${args.terminalId}`,
			kind: "execute"
		})
	}));
	ctx.tools.register(defineTool({
		name: "sidebar_terminal_list",
		description: LIST_DESCRIPTION,
		parameters: {},
		output: {
			schema: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						terminalId: {
							type: "string",
							required: true
						},
						title: {
							type: "string",
							required: true
						},
						shell: {
							type: "string",
							required: true
						},
						cwd: {
							type: "string",
							required: true
						},
						state: {
							type: "string",
							required: true,
							enum: [
								"running",
								"exited",
								"failed"
							]
						},
						exitCode: {
							required: true,
							oneOf: [{ type: "integer" }, { type: "null" }],
							description: "Exit code once the shell has exited, null while running."
						},
						lines: {
							type: "integer",
							required: true,
							description: "Retained transcript lines."
						},
						controller: {
							type: "string",
							required: true,
							enum: [
								"plugin",
								"user",
								"none"
							],
							description: "Who currently holds input control."
						}
					}
				}
			},
			render: (_args, value) => {
				const terminals = value;
				return [{
					type: "text",
					text: terminals.length === 0 ? "(no sidebar terminals opened by this session)" : terminals.map((entry) => `${entry.terminalId} [${entry.state}] controller=${entry.controller} ${entry.lines} lines`).join("\n")
				}];
			}
		},
		async execute(_args, exec) {
			const owner = requireAgent(exec.agent);
			return [...endpoint.list(owner)];
		},
		presentCall: () => ({
			card: "generic",
			title: "List sidebar terminals",
			kind: "read"
		})
	}));
}
//#endregion
//#region src/index.ts
/**
* index.ts — @huanlin/dsh-plugin-sidebar-terminal-tools entry (host half).
*
* Bridges the official sidebar terminal stack (`ctx.terminalController`,
* consumed by service name through structural shadow types — the upstream
* package is never imported) to the model as six `sidebar_terminal_*` tools.
* Every tool only reaches terminals this plugin registered, so the user's
* manual sidebar terminals are never touched.
*
* Security: these terminals run with the system user's permissions, outside
* the Agent sandbox and the approval pipeline (an upstream property of
* `terminalController` that this plugin deliberately exposes to the model).
* Gate the `sidebar_terminal_*` tool names in permission rules if that is not
* what you want; see the README before enabling.
*
* Conventions (plugin-development-guide.md §3): C4 canonical values, C5
* business outcomes as values, C6 signal honored at every await.
*
* Tool registration is effect-based: disposing the plugin fiber (config
* change, unload) unregisters the tools, aborts every follow consumer, and
* the next apply() rebuilds from the fresh config.
*
* @module @huanlin/dsh-plugin-sidebar-terminal-tools
*/
const name = "sidebar-terminal-tools";
const inject = ["terminalController", "tools"];
/** Schemastery configuration schema; defaults mirror {@link resolveConfig}. */
const Config = z.object({
	transcriptLines: z.number().default(5e3).description("Retained transcript lines per terminal."),
	transcriptBytes: z.number().default(1048576).description("Retained transcript bytes per terminal."),
	defaultTimeoutMs: z.number().default(1e4).description("Wait bound used when the model omits timeout_ms."),
	minTimeoutMs: z.number().default(100).description("Smallest wait bound; smaller requests are clamped."),
	maxTimeoutMs: z.number().default(6e5).description("Hard cap for any single wait; larger requests are clamped."),
	pollIntervalMs: z.number().default(150).description("wait_for poll interval in milliseconds."),
	tailLines: z.number().default(30).description("Lines carried by a timeout outcome."),
	maxLineTextChars: z.number().default(1e3).description("Character cap for found.lineText."),
	maxTailBytes: z.number().default(8192).description("UTF-8 byte cap for timeout.tail."),
	maxMessageChars: z.number().default(2e3).description("Character cap for a user-takeover notice.")
});
/** Resolve one optional count with a loud failure instead of silent degradation. */
function resolveCount(label, value, fallback, minimum) {
	const resolved = value ?? fallback;
	if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved < minimum) throw new Error(`sidebar-terminal-tools: ${label} must be a safe integer >= ${minimum}`);
	return resolved;
}
/** Validate configuration loudly; every field resolved. */
function resolveConfig(config = {}) {
	const minTimeoutMs = resolveCount("minTimeoutMs", config.minTimeoutMs, 100, 1);
	const maxTimeoutMs = resolveCount("maxTimeoutMs", config.maxTimeoutMs, 6e5, 1);
	if (maxTimeoutMs < minTimeoutMs) throw new Error("sidebar-terminal-tools: maxTimeoutMs must be >= minTimeoutMs");
	const defaultTimeoutMs = resolveCount("defaultTimeoutMs", config.defaultTimeoutMs, 1e4, 1);
	if (defaultTimeoutMs < minTimeoutMs || defaultTimeoutMs > maxTimeoutMs) throw new Error("sidebar-terminal-tools: defaultTimeoutMs must be within [minTimeoutMs, maxTimeoutMs]");
	return {
		transcriptLines: resolveCount("transcriptLines", config.transcriptLines, 5e3, 1),
		transcriptBytes: resolveCount("transcriptBytes", config.transcriptBytes, 1048576, 1),
		defaultTimeoutMs,
		minTimeoutMs,
		maxTimeoutMs,
		pollIntervalMs: resolveCount("pollIntervalMs", config.pollIntervalMs, 150, 1),
		tailLines: resolveCount("tailLines", config.tailLines, 30, 0),
		maxLineTextChars: resolveCount("maxLineTextChars", config.maxLineTextChars, 1e3, 0),
		maxTailBytes: resolveCount("maxTailBytes", config.maxTailBytes, 8192, 0),
		maxMessageChars: resolveCount("maxMessageChars", config.maxMessageChars, 2e3, 1)
	};
}
/**
* Mount the endpoint core over the host's terminal controller and register
* the six tools.
* @param ctx - host context (requires `terminalController` and `tools`).
* @param config - plugin configuration.
*/
function apply(ctx, config = {}) {
	const resolved = resolveConfig(config);
	const registry = new EndpointRegistry();
	const endpoint = createEndpoint(ctx.terminalController, registry, resolved);
	ctx.effect(() => () => {
		registry.dispose();
	}, "sidebar-terminal-tools: registry disposal");
	registerTools(ctx, {
		endpoint,
		config: resolved
	});
}
//#endregion
export { Config, apply, inject, name, resolveConfig };
