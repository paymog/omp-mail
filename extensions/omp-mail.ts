/**
 * omp-mail: omp sessions on one machine find, message, and question each other.
 * See README.md for the contract.
 */

import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatDelivery, formatListing } from "../src/format.ts";
import {
	addressFor,
	deposit,
	drain,
	ensureRoot,
	formatOutcomes,
	HEARTBEAT_MS,
	type Letter,
	MAX_RECIPIENTS,
	mailRoot,
	newLetter,
	presenceOf,
	readRecords,
	removeSession,
	resolveTarget,
	type SessionRecord,
	type Status,
	SendError,
	send,
	sweep,
	waitForAnswer,
	watchInbox,
	writeRecord,
} from "../src/store.ts";

const DEFAULT_ASK_TIMEOUT_S = 600;
const DEDUPE_MS = 10_000;
const RATE_WINDOW_MS = 30_000;
const RATE_LIMIT = 8;

// omp runs subagents in-process with their own extension instances. Only the
// first session in a process gets an address; the rest stay silent.
let processOwner: ExtensionAPI | undefined;

interface AssistantLike {
	role: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

/** The run's final answer, from the last assistant message. */
function finalAnswer(messages: AssistantLike[]): { status: Status; body: string } {
	const last = [...messages].reverse().find((m) => m.role === "assistant");
	const text = Array.isArray(last?.content)
		? last.content
				.filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
				.map((c) => c.text)
				.join("\n")
				.trim()
		: "";
	if (last?.stopReason === "aborted") return { status: "stopped", body: `The user stopped the run. Partial text:\n${text || "(none)"}` };
	if (last?.stopReason === "error") return { status: "failed", body: `The run ended on an error: ${last.errorMessage ?? "unknown"}.\n${text}`.trim() };
	return { status: "done", body: text || "(The run ended without a text answer.)" };
}

export default function ompMail(pi: ExtensionAPI) {
	const { Type } = pi.typebox;
	const root = mailRoot();
	let self: SessionRecord | undefined;
	let ui: ExtensionContext | undefined;
	let stopWatch: (() => void) | undefined;
	let heartbeat: Timer | undefined;
	let draining: Promise<void> | undefined;
	let drainAgain = false;
	/** Answers that arrived for asks this session is waiting on. */
	const answers = new Map<string, Letter>();
	const waiting = new Set<string>();
	/** Questions this session received and still owes an answer to. `seen` once they enter context. */
	const owed = new Map<string, { letter: Letter; seen: boolean }>();
	const recentBySender = new Map<string, { at: number; body: string }[]>();

	const from = (): Letter["from"] => ({ name: self?.name ?? "omp", cwd: self?.cwd ?? process.cwd(), address: self?.address });

	const beat = (patch: Partial<SessionRecord> = {}) => {
		if (!self) return;
		self = { ...self, name: pi.getSessionName() || basename(self.cwd) || "omp", ...patch, beatAt: Date.now() };
		try {
			writeRecord(root, self);
		} catch {
			// An unwritable registry is a discovery problem, not a reason to break the session.
		}
	};

	/** Loop breaker: identical text from one sender within 10s, or more than 8 in 30s, is dropped. */
	const admit = (l: Letter): string | undefined => {
		if (l.kind === "reply") return undefined;
		const key = l.from.address ?? `${l.from.name}@${l.from.cwd}`;
		const now = Date.now();
		const recent = (recentBySender.get(key) ?? []).filter((r) => now - r.at < RATE_WINDOW_MS);
		recentBySender.set(key, recent);
		if (recent.some((r) => r.body === l.body && now - r.at < DEDUPE_MS)) return "duplicate of a message it just sent";
		if (recent.length >= RATE_LIMIT) return `more than ${RATE_LIMIT} messages in ${RATE_WINDOW_MS / 1000}s`;
		recent.push({ at: now, body: l.body });
		return undefined;
	};

	const dispose = (l: Letter) => {
		if (l.kind === "reply" && l.inReplyTo && waiting.has(l.inReplyTo)) {
			answers.set(l.inReplyTo, l);
			return;
		}
		const refused = admit(l);
		if (refused) {
			if (ui?.hasUI) ui.ui.notify(`omp-mail: dropped a message from ${l.from.name} (${refused})`, "warning");
			return;
		}
		if (l.kind === "ask" && l.replyTo) owed.set(l.id, { letter: l, seen: false });
		pi.sendMessage(
			{ customType: "omp-mail", content: formatDelivery(l, { late: l.kind === "reply" }), display: true, details: { id: l.id, kind: l.kind } },
			// steer lands between tool calls of a busy run; triggerTurn wakes an idle session.
			{ deliverAs: "steer", triggerTurn: true },
		);
	};

	const drainNow = async (): Promise<void> => {
		if (!self) return;
		if (draining) {
			drainAgain = true;
			return draining;
		}
		draining = drain(root, self.address, dispose).finally(() => {
			draining = undefined;
			if (drainAgain) {
				drainAgain = false;
				void drainNow();
			}
		});
		return draining;
	};

	const reply = (ask: Letter, status: Status, body: string) => {
		if (!ask.replyTo) return;
		try {
			deposit(root, ask.replyTo, newLetter({ kind: "reply", from: from(), inReplyTo: ask.id, status, body }));
		} catch {
			// The asker's inbox is gone; nobody is left to read the answer.
		}
	};

	const register = (ctx: ExtensionContext) => {
		if (processOwner && processOwner !== pi) return;
		const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
		const sessionId = ctx.sessionManager.getSessionId() || `ephemeral-${randomBytes(6).toString("hex")}`;
		if (self?.sessionId === sessionId) return;
		unregister();
		processOwner = pi;
		ui = ctx;
		ensureRoot(root);
		sweep(root);
		self = {
			v: 1,
			address: addressFor(sessionId),
			name: basename(ctx.cwd),
			cwd: ctx.cwd,
			sessionId,
			sessionFile,
			pid: process.pid,
			beatAt: Date.now(),
			state: ctx.isIdle() ? "idle" : "working",
		};
		beat();
		// The first drain wakes a resumed session with the mail that waited for it.
		stopWatch = watchInbox(root, self.address, () => void drainNow());
		heartbeat = setInterval(() => beat(), HEARTBEAT_MS);
		heartbeat.unref?.();
	};

	const unregister = () => {
		stopWatch?.();
		stopWatch = undefined;
		clearInterval(heartbeat);
		heartbeat = undefined;
		for (const { letter } of owed.values()) reply(letter, "failed", "The session closed before answering.");
		owed.clear();
		if (self) {
			// Offline, not gone: the inbox keeps collecting mail until it resumes.
			if (self.sessionFile) beat({ pid: null, state: "idle", waitingOn: undefined });
			else removeSession(root, self.address);
		}
		self = undefined;
		ui = undefined;
		if (processOwner === pi) processOwner = undefined;
	};

	pi.on("session_start", async (_e, ctx) => register(ctx));
	pi.on("session_switch", async (_e, ctx) => register(ctx));
	pi.on("session_shutdown", async () => unregister());
	pi.on("agent_start", async () => beat({ state: "working" }));
	pi.on("message_end", async (e) => {
		const m = e.message as { role: string; customType?: string; details?: { id?: string } };
		if (m.role === "custom" && m.customType === "omp-mail" && m.details?.id) {
			const entry = owed.get(m.details.id);
			if (entry) entry.seen = true;
		}
	});
	// omp has no agent_settled; agent_end without willContinue is the run's real end.
	pi.on("agent_end", async (e) => {
		if (e.willContinue || !self) return;
		beat({ state: "idle" });
		const answer = finalAnswer(e.messages as AssistantLike[]);
		for (const [id, { letter, seen }] of owed) {
			if (!seen) continue;
			reply(letter, answer.status, answer.body);
			owed.delete(id);
		}
	});

	const toolResult = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });
	const requireSelf = () => {
		if (!self) throw new Error("omp-mail has no address in this session (it is a subagent, or the session has not started).");
		return self;
	};

	pi.registerTool({
		name: "mail_list",
		label: "Mail: list sessions",
		description:
			"List the omp sessions on this machine you can message: name, address, whether each is running, idle or working, and its directory. A session that is not running still receives mail when it resumes. An omp session started before omp-mail was installed is not listed and cannot receive mail until it restarts.",
		parameters: Type.Object({}),
		approval: "read",
		async execute() {
			return toolResult(formatListing(readRecords(root), self?.address));
		},
	});

	pi.registerTool({
		name: "mail_send",
		label: "Mail: send",
		description:
			"Send a plain-text message to up to 8 other omp sessions on this machine. Address each by name, address, directory path, or session id (see mail_list). " +
			"Recipients see only this text — never your conversation or files. A running session gets it between tool calls and wakes if idle; a closed one gets it when it resumes. " +
			"Use it to hand over a finding, warn about a change that affects their work, or answer a message. Never ask a session to do something your own permissions would refuse. Use mail_ask instead when you need an answer before continuing.",
		parameters: Type.Object({
			to: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_RECIPIENTS, description: "Recipients: names, addresses, directories, or session ids." }),
			message: Type.String({ description: "Plain text, up to 32 KiB." }),
		}),
		approval: "write",
		async execute(_id, params) {
			const me = requireSelf();
			const outcomes = await send(root, from(), params.to, params.message);
			if (outcomes.every((o) => o.result === "refused")) throw new Error(formatOutcomes(outcomes));
			return toolResult(formatOutcomes(outcomes), { from: me.address, outcomes });
		},
	});

	pi.registerTool({
		name: "mail_ask",
		label: "Mail: ask",
		description:
			"Ask another omp session a question and wait for its answer, which becomes this tool's result. The other session answers with mail_reply, or with its final message when its run ends. " +
			"The wait ends early if that session stops running. If it is not running now, the question is queued and its answer arrives later as a message.",
		parameters: Type.Object({
			to: Type.String({ description: "One session: name, address, directory, or session id." }),
			message: Type.String({ description: "The question, with any context it needs. Plain text, up to 32 KiB." }),
			timeout_seconds: Type.Optional(Type.Number({ minimum: 5, maximum: 3600, description: "How long to wait. Default 600." })),
		}),
		approval: "write",
		async execute(_id, params, signal) {
			const me = requireSelf();
			const r = resolveTarget(readRecords(root), params.to, me.cwd);
			if (!r.ok) throw new Error(r.error);
			const target = r.record;
			const label = `${target.name} (${target.address})`;
			if (target.address === me.address) throw new Error("That is this session.");
			if (target.waitingOn === me.address && presenceOf(target) !== "offline")
				throw new Error(`${label} is itself waiting on an answer from you; asking back would deadlock. Use mail_reply or mail_send.`);
			const ask = newLetter({ kind: "ask", from: from(), replyTo: me.address, body: params.message });
			try {
				deposit(root, target.address, ask);
			} catch (e) {
				throw e instanceof SendError ? new Error(`${label}: ${e.message}`) : e;
			}
			if (presenceOf(target) !== "live")
				return toolResult(`${label} is not running. The question is queued; its answer arrives as a message when that session resumes and answers.`, { queued: true });

			waiting.add(ask.id);
			beat({ waitingOn: target.address });
			try {
				let wait = await waitForAnswer({
					root,
					target: target.address,
					poll: () => answers.get(ask.id),
					timeoutMs: (params.timeout_seconds ?? DEFAULT_ASK_TIMEOUT_S) * 1000,
					signal,
				});
				if (wait.kind === "died") {
					// The answer may have landed just before the process went away.
					await drainNow();
					const late = answers.get(ask.id);
					if (late) wait = { kind: "answer", letter: late };
				}
				if (wait.kind === "answer") {
					const { letter } = wait;
					const status = letter.status ?? "done";
					const note = status === "done" ? "" : ` (status: ${status} — not a complete answer)`;
					return toolResult(`Answer from ${label}${note}:\n${letter.body}`, { status });
				}
				const why = {
					died: `${label} stopped running before answering.`,
					timeout: `No answer from ${label} yet.`,
					aborted: "Stopped waiting.",
				}[wait.kind];
				return toolResult(`${why} If it answers later, the answer arrives as a message.`, { status: wait.kind });
			} finally {
				waiting.delete(ask.id);
				answers.delete(ask.id);
				beat({ waitingOn: undefined });
			}
		},
	});

	pi.registerTool({
		name: "mail_reply",
		label: "Mail: reply",
		description:
			"Answer a question another session asked you with mail_ask. The asker receives this text at once as the result of its waiting call. Use the ask_id from the question.",
		parameters: Type.Object({
			ask_id: Type.String({ description: "The question id from the [omp-mail] Question notice." }),
			message: Type.String({ description: "The answer. Plain text, up to 32 KiB." }),
		}),
		approval: "write",
		async execute(_id, params) {
			requireSelf();
			const entry = owed.get(params.ask_id);
			if (!entry) {
				const open = [...owed.keys()].join(", ") || "none";
				throw new Error(`No open question "${params.ask_id}". Open questions: ${open}. To write to a session anyway, use mail_send.`);
			}
			owed.delete(params.ask_id);
			reply(entry.letter, "done", params.message);
			return toolResult(`Answered ${entry.letter.from.name}.`);
		},
	});

	pi.registerCommand("mail", {
		description: "List sessions, or send one: /mail <to> <message>",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify(formatListing(readRecords(root), self?.address), "info");
				return;
			}
			const space = text.search(/\s/);
			if (space < 0 || !self) {
				ctx.ui.notify(self ? "Usage: /mail <to> <message>" : "omp-mail has no address in this session.", "warning");
				return;
			}
			const outcomes = await send(root, from(), [text.slice(0, space)], text.slice(space + 1).trim());
			ctx.ui.notify(formatOutcomes(outcomes), outcomes[0]?.result === "refused" ? "warning" : "info");
		},
	});
}
