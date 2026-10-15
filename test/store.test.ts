import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deposit,
	drain,
	ensureRoot,
	inboxPath,
	type Letter,
	MAX_BACKLOG,
	mailCount,
	newLetter,
	readRecords,
	recordPath,
	resolveTarget,
	type SessionRecord,
	send,
	sweep,
	waitForAnswer,
	writeRecord,
} from "../src/store.ts";

let root: string;
const DEAD_PID = 2 ** 22 + 12345;
const from = { name: "sender", cwd: "/tmp", address: "aaaaaaaaaaaa" };

function rec(over: Partial<SessionRecord>): SessionRecord {
	return { v: 1, address: "b0b0b0b0b0b0", name: "b", cwd: "/work/b", sessionId: "sid-b", sessionFile: "/s/b.jsonl", pid: process.pid, beatAt: Date.now(), state: "idle", ...over };
}

beforeEach(() => {
	root = fs.mkdtempSync(join(tmpdir(), "omp-mail-"));
	ensureRoot(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("resolve prefers a running session over an offline one with the same name", () => {
	const live = rec({ address: "111111111111", sessionId: "s1" });
	const dead = rec({ address: "222222222222", sessionId: "s2", pid: null });
	const r = resolveTarget([dead, live], "b");
	expect(r.ok && r.record.address).toBe("111111111111");
});

test("resolve refuses to guess between two running sessions", () => {
	const r = resolveTarget([rec({ address: "111111111111", sessionId: "s1" }), rec({ address: "222222222222", sessionId: "s2" })], "b");
	expect(r.ok).toBe(false);
});

test("resolve by directory, address prefix, and session id; process records are hidden from names", () => {
	const dir = fs.mkdtempSync(join(tmpdir(), "omp-mail-cwd-"));
	const a = rec({ address: "abcdef123456", sessionId: "019a-uuid", cwd: dir, name: "alpha" });
	const cli = rec({ address: "cccccccccccc", sessionId: "cli-x", name: "alpha", process: true });
	expect(resolveTarget([a, cli], dir).ok).toBe(true);
	expect(resolveTarget([a, cli], "abcd").ok).toBe(true);
	expect(resolveTarget([a, cli], "019a-uuid").ok).toBe(true);
	const byName = resolveTarget([a, cli], "alpha");
	expect(byName.ok && byName.record.address).toBe("abcdef123456");
	expect(resolveTarget([a], "abc").ok).toBe(false);
	fs.rmSync(dir, { recursive: true });
});

test("drain hands letters over oldest first and removes them", async () => {
	const ids: string[] = [];
	["one", "two", "three"].forEach((body, i) => {
		deposit(root, "b0b0b0b0b0b0", { ...newLetter({ kind: "message", from, body }), id: `000000000000${i}-0000000${i}` });
	});
	fs.writeFileSync(join(inboxPath(root, "b0b0b0b0b0b0"), "0000000000000-zzzz.json"), "{not json");
	fs.writeFileSync(join(inboxPath(root, "b0b0b0b0b0b0"), "x.json.123.tmp"), "partial");
	await drain(root, "b0b0b0b0b0b0", (l) => void ids.push(l.body));
	expect(ids).toEqual(["one", "two", "three"]);
	expect(mailCount(root, "b0b0b0b0b0b0")).toBe(0);
});

test("a letter stays on disk when dispose throws", async () => {
	deposit(root, "b0b0b0b0b0b0", newLetter({ kind: "message", from, body: "keep me" }));
	await expect(
		drain(root, "b0b0b0b0b0b0", () => {
			throw new Error("crash");
		}),
	).rejects.toThrow();
	expect(mailCount(root, "b0b0b0b0b0b0")).toBe(1);
});

test("deposit refuses oversized, empty, and backlogged mail; replies bypass the backlog", () => {
	expect(() => deposit(root, "b0b0b0b0b0b0", newLetter({ kind: "message", from, body: "x".repeat(33 * 1024) }))).toThrow();
	expect(() => deposit(root, "b0b0b0b0b0b0", newLetter({ kind: "message", from, body: "  " }))).toThrow();
	for (let i = 0; i < MAX_BACKLOG; i++) deposit(root, "b0b0b0b0b0b0", newLetter({ kind: "message", from, body: `m${i}` }));
	expect(() => deposit(root, "b0b0b0b0b0b0", newLetter({ kind: "message", from, body: "one more" }))).toThrow();
	expect(() => deposit(root, "b0b0b0b0b0b0", newLetter({ kind: "reply", from, body: "answer" }))).not.toThrow();
});

test("sweep keeps mail for offline sessions and drops empty, unresumable ones", () => {
	const old = Date.now() - 8 * 24 * 3600 * 1000;
	writeRecord(root, rec({ address: "aaaaaaaaaaa1", sessionId: "s1", pid: null, beatAt: old }));
	deposit(root, "aaaaaaaaaaa1", newLetter({ kind: "message", from, body: "waiting" }));
	writeRecord(root, rec({ address: "aaaaaaaaaaa2", sessionId: "s2", pid: null, beatAt: old }));
	writeRecord(root, rec({ address: "aaaaaaaaaaa3", sessionId: "s3", pid: DEAD_PID, sessionFile: undefined }));
	writeRecord(root, rec({ address: "aaaaaaaaaaa4", sessionId: "s4" }));
	sweep(root);
	expect(readRecords(root).map((r) => r.address).sort()).toEqual(["aaaaaaaaaaa1", "aaaaaaaaaaa4"]);
	expect(mailCount(root, "aaaaaaaaaaa1")).toBe(1);
});

test("send reports delivered when the reader consumes, queued when it does not", async () => {
	writeRecord(root, rec({ address: "111111111111", sessionId: "s1", name: "reader" }));
	writeRecord(root, rec({ address: "222222222222", sessionId: "s2", name: "closed", pid: null }));
	// A real concurrent reader: awaitConsumed polls the file system on the wall clock.
	const reader = setInterval(() => void drain(root, "111111111111", () => {}), 20);
	const out = await send(root, from, ["reader", "closed", "nobody", "reader"], "hi");
	clearInterval(reader);
	expect(out.map((o) => o.result)).toEqual(["delivered", "queued", "refused", "refused"]);
});

test("waitForAnswer ends early when the target dies", async () => {
	writeRecord(root, rec({ address: "111111111111", pid: DEAD_PID }));
	const t0 = Date.now();
	const w = await waitForAnswer({ root, target: "111111111111", poll: () => undefined, timeoutMs: 10_000 });
	expect(w.kind).toBe("died");
	expect(Date.now() - t0).toBeLessThan(1_000);
});

test("record files are written atomically under the root", () => {
	writeRecord(root, rec({}));
	expect(JSON.parse(fs.readFileSync(recordPath(root, "b0b0b0b0b0b0"), "utf8")).name).toBe("b");
	expect(fs.readdirSync(join(root, "sessions")).every((n) => n.endsWith(".json"))).toBe(true);
	const l: Letter = newLetter({ kind: "ask", from, replyTo: "aaaaaaaaaaaa", body: "q" });
	expect(l.id).toMatch(/^\d{13}-[0-9a-f]{8}$/);
});
