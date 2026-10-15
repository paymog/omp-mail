/**
 * The shared mail directory: who exists, where they work, and their inboxes.
 *
 *   <root>/sessions/<address>.json   presence record, written by its owner
 *   <root>/inbox/<address>/<id>.json one letter per file, consumed by the owner
 *
 * No daemon and no socket. Sending is a rename into someone's inbox; the
 * receiver unlinking the file is the receipt.
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const MAX_BODY_BYTES = 32 * 1024;
export const MAX_BACKLOG = 50;
export const HEARTBEAT_MS = 10_000;
export const STALE_AFTER_MS = 45_000;
export const RECEIPT_TIMEOUT_MS = 1_500;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Kind = "message" | "ask" | "reply";
export type Status = "done" | "stopped" | "failed";

export interface Letter {
	v: 1;
	id: string;
	kind: Kind;
	from: { name: string; cwd: string; address?: string };
	/** Asks: where the answer goes. Absent for senders without an inbox. */
	replyTo?: string;
	/** Replies: the ask this answers. */
	inReplyTo?: string;
	status?: Status;
	sentAt: number;
	body: string;
}

export interface SessionRecord {
	v: 1;
	address: string;
	name: string;
	cwd: string;
	sessionId: string;
	/** Absent when the session cannot be resumed; its record goes when it exits. */
	sessionFile?: string;
	/** Null once the owner has shut down cleanly. */
	pid: number | null;
	beatAt: number;
	state: "idle" | "working";
	/** Address this session's open ask is waiting on. */
	waitingOn?: string;
	/** A CLI ask: reachable for its answer, hidden from listings. */
	process?: boolean;
}

export type Presence = "live" | "stalled" | "offline";

export function mailRoot(): string {
	return process.env.OMP_MAIL_DIR ?? join(homedir(), ".omp", "mail");
}

export function ensureRoot(root: string): void {
	fs.mkdirSync(join(root, "sessions"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(join(root, "inbox"), { recursive: true, mode: 0o700 });
	fs.chmodSync(root, 0o700);
}

/** A conversation's address. Hashing pi's session id keeps it stable across resumes. */
export function addressFor(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
}

export const recordPath = (root: string, address: string) => join(root, "sessions", `${address}.json`);
export const inboxPath = (root: string, address: string) => join(root, "inbox", address);

function writeAtomic(path: string, data: string): void {
	const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, data, { mode: 0o600 });
	fs.renameSync(tmp, path);
}

export function writeRecord(root: string, record: SessionRecord): void {
	writeAtomic(recordPath(root, record.address), JSON.stringify(record));
}

export function readRecord(root: string, address: string): SessionRecord | undefined {
	try {
		const r = JSON.parse(fs.readFileSync(recordPath(root, address), "utf8"));
		return r?.v === 1 && typeof r.address === "string" ? r : undefined;
	} catch {
		return undefined;
	}
}

export function readRecords(root: string): SessionRecord[] {
	let names: string[];
	try {
		names = fs.readdirSync(join(root, "sessions"));
	} catch {
		return [];
	}
	return names
		.filter((n) => n.endsWith(".json"))
		.map((n) => readRecord(root, n.slice(0, -5)))
		.filter((r): r is SessionRecord => r !== undefined);
}

export function removeSession(root: string, address: string): void {
	fs.rmSync(recordPath(root, address), { force: true });
	fs.rmSync(inboxPath(root, address), { recursive: true, force: true });
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function presenceOf(r: SessionRecord, now = Date.now()): Presence {
	if (r.pid === null || !pidAlive(r.pid)) return "offline";
	return now - r.beatAt <= STALE_AFTER_MS ? "live" : "stalled";
}

export function mailCount(root: string, address: string): number {
	try {
		return fs.readdirSync(inboxPath(root, address)).filter((n) => n.endsWith(".json")).length;
	} catch {
		return 0;
	}
}

/**
 * Drop what nothing will read. Mail outranks tidiness: a non-empty inbox is
 * kept for 30 days after its owner last ran, an empty one for 7 (or at once
 * when the session cannot be resumed).
 */
export function sweep(root: string, now = Date.now()): void {
	const known = new Set<string>();
	for (const r of readRecords(root)) {
		known.add(r.address);
		if (presenceOf(r, now) !== "offline") continue;
		const age = now - r.beatAt;
		const keep = mailCount(root, r.address) > 0 ? age < 30 * DAY_MS : r.sessionFile && age < 7 * DAY_MS;
		if (!keep) removeSession(root, r.address);
	}
	let inboxes: string[] = [];
	try {
		inboxes = fs.readdirSync(join(root, "inbox"));
	} catch {}
	for (const a of inboxes) if (!known.has(a) && mailCount(root, a) === 0) fs.rmSync(inboxPath(root, a), { recursive: true, force: true });
}

export class SendError extends Error {}

export function newLetter(fields: Omit<Letter, "v" | "id" | "sentAt">): Letter {
	const sentAt = Date.now();
	return { v: 1, id: `${String(sentAt).padStart(13, "0")}-${randomBytes(4).toString("hex")}`, sentAt, ...fields };
}

/** Spool a letter into an inbox. Returns its path, which vanishes once the owner reads it. */
export function deposit(root: string, address: string, letter: Letter): string {
	if (Buffer.byteLength(letter.body) > MAX_BODY_BYTES) throw new SendError(`Message is over ${MAX_BODY_BYTES / 1024} KiB. Send a summary and a file path instead.`);
	if (!letter.body.trim()) throw new SendError("Message is empty.");
	const dir = inboxPath(root, address);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (letter.kind !== "reply" && mailCount(root, address) >= MAX_BACKLOG) throw new SendError(`Inbox is full (${MAX_BACKLOG} unread).`);
	const path = join(dir, `${letter.id}.json`);
	writeAtomic(path, JSON.stringify(letter));
	return path;
}

export async function awaitConsumed(path: string, timeoutMs = RECEIPT_TIMEOUT_MS): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (!fs.existsSync(path)) return true;
		await Bun.sleep(50);
	}
	return !fs.existsSync(path);
}

function parseLetter(raw: string): Letter | undefined {
	try {
		const l = JSON.parse(raw);
		if (l?.v !== 1 || typeof l.id !== "string" || typeof l.body !== "string" || typeof l.from?.name !== "string") return undefined;
		if (!["message", "ask", "reply"].includes(l.kind)) l.kind = "message";
		return l;
	} catch {
		return undefined;
	}
}

/**
 * Hand each waiting letter to `dispose`, oldest first, and unlink it only
 * after: a crash mid-delivery redelivers rather than loses. Unparseable
 * letters are deleted so they cannot block every later drain.
 */
export async function drain(root: string, address: string, dispose: (l: Letter) => void | Promise<void>): Promise<void> {
	const dir = inboxPath(root, address);
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
	} catch {
		return;
	}
	for (const name of names) {
		const path = join(dir, name);
		let raw: string;
		try {
			raw = fs.readFileSync(path, "utf8");
		} catch {
			continue;
		}
		const letter = parseLetter(raw);
		if (letter) await dispose(letter);
		fs.rmSync(path, { force: true });
	}
}

/** Watch an inbox. fs.watch is fast but not guaranteed, so a poll backs it up. */
export function watchInbox(root: string, address: string, onChange: () => void, pollMs = 2_000): () => void {
	const dir = inboxPath(root, address);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	let watcher: fs.FSWatcher | undefined;
	try {
		watcher = fs.watch(dir, () => onChange());
	} catch {}
	const timer = setInterval(onChange, pollMs);
	timer.unref?.();
	onChange();
	return () => {
		watcher?.close();
		clearInterval(timer);
	};
}

export type Resolution = { ok: true; record: SessionRecord } | { ok: false; error: string };

/** Prefer live sessions; refuse rather than guess between two. */
function pick(matches: SessionRecord[], target: string): Resolution | undefined {
	if (matches.length === 0) return undefined;
	const live = matches.filter((r) => presenceOf(r) !== "offline");
	const pool = live.length > 0 ? live : matches;
	if (pool.length === 1) return { ok: true, record: pool[0] };
	const list = pool.map((r) => `${r.name} (${r.address}, ${r.cwd})`).join("; ");
	return { ok: false, error: `"${target}" matches ${pool.length} sessions: ${list}. Use an address.` };
}

/**
 * A target may be an address, a session name, a directory, or pi's session id.
 * Prefixes of addresses and session ids work when unique and at least 4 chars.
 */
export function resolveTarget(records: SessionRecord[], target: string, cwd = process.cwd()): Resolution {
	const t = target.trim();
	const visible = records.filter((r) => !r.process);
	const exact = records.find((r) => r.address === t || r.sessionId === t);
	if (exact) return { ok: true, record: exact };
	if (t.startsWith("/") || t.startsWith("~") || t.startsWith(".")) {
		const real = (p: string) => {
			try {
				return fs.realpathSync(p);
			} catch {
				return resolve(p);
			}
		};
		const abs = real(resolve(cwd, t.replace(/^~(?=$|\/)/, homedir())));
		const hit = pick(visible.filter((r) => real(r.cwd) === abs), t);
		if (hit) return hit;
	}
	const lower = t.toLowerCase();
	const named = pick(visible.filter((r) => r.name.toLowerCase() === lower), t);
	if (named) return named;
	if (t.length >= 4) {
		const prefixed = pick(visible.filter((r) => r.address.startsWith(t) || r.sessionId.startsWith(t)), t);
		if (prefixed) return prefixed;
	}
	const names = visible.map((r) => `${r.name} (${r.address})`).join(", ") || "none";
	return { ok: false, error: `No session matches "${t}". Known sessions: ${names}.` };
}

export interface Outcome {
	to: string;
	result: "delivered" | "queued" | "refused";
	detail: string;
}

export const MAX_RECIPIENTS = 8;

/** Send one letter body to each target. Reports per recipient whether it was read or is waiting. */
export async function send(root: string, from: Letter["from"], targets: string[], body: string): Promise<Outcome[]> {
	if (targets.length > MAX_RECIPIENTS) throw new SendError(`At most ${MAX_RECIPIENTS} recipients per send.`);
	const records = readRecords(root);
	const seen = new Set<string>();
	const outcomes = targets.map(async (to): Promise<Outcome> => {
		const r = resolveTarget(records, to, from.cwd);
		if (!r.ok) return { to, result: "refused", detail: r.error };
		const { record } = r;
		const label = `${record.name} (${record.address})`;
		if (record.address === from.address) return { to: label, result: "refused", detail: "That is this session." };
		if (seen.has(record.address)) return { to: label, result: "refused", detail: "Duplicate recipient." };
		seen.add(record.address);
		let path: string;
		try {
			path = deposit(root, record.address, newLetter({ kind: "message", from, body }));
		} catch (e) {
			if (e instanceof SendError) return { to: label, result: "refused", detail: e.message };
			throw e;
		}
		const presence = presenceOf(record);
		if (presence === "live" && (await awaitConsumed(path))) return { to: label, result: "delivered", detail: "It is in their context now." };
		if (presence === "offline")
			return {
				to: label,
				result: "queued",
				detail: `that session closed ${since(record.beatAt)} ago. It gets the mail only if that exact session is resumed. An omp session started before omp-mail was installed is not listed and cannot receive mail until it restarts.`,
			};
		const why = presence === "live" ? "not read yet" : "the session is not responding";
		return { to: label, result: "queued", detail: `${why}; it is delivered when the session reads its inbox.` };
	});
	return Promise.all(outcomes);
}

export const formatOutcomes = (outcomes: Outcome[]) => outcomes.map((o) => `${o.to}: ${o.result} — ${o.detail}`).join("\n");

export function since(at: number, now = Date.now()): string {
	const m = Math.max(0, Math.round((now - at) / 60_000));
	if (m < 60) return `${m}m`;
	if (m < 48 * 60) return `${Math.round(m / 60)}h`;
	return `${Math.round(m / 1440)}d`;
}

export type Wait = { kind: "answer"; letter: Letter } | { kind: "died" | "timeout" | "aborted" };

/** Wait for an answer, ending early if the target stops running or the caller aborts. */
export async function waitForAnswer(opts: {
	root: string;
	target: string;
	poll: () => Letter | undefined | Promise<Letter | undefined>;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<Wait> {
	const end = Date.now() + opts.timeoutMs;
	let nextCheck = 0;
	while (true) {
		const letter = await opts.poll();
		if (letter) return { kind: "answer", letter };
		if (opts.signal?.aborted) return { kind: "aborted" };
		const now = Date.now();
		if (now >= end) return { kind: "timeout" };
		if (now >= nextCheck) {
			const r = readRecord(opts.root, opts.target);
			if (!r || presenceOf(r, now) === "offline") return { kind: "died" };
			nextCheck = now + 1_000;
		}
		await Bun.sleep(100);
	}
}
