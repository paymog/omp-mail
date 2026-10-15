import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ompMail from "../extensions/omp-mail.ts";
import { addressFor, deposit, drain, type Letter, newLetter, readRecord } from "../src/store.ts";

let root: string;
const ASKER = "a5a5a5a5a5a5";

/** Just enough of omp's ExtensionAPI to drive the extension's handlers. */
async function load() {
	const handlers: Record<string, (e: unknown, ctx?: unknown) => Promise<unknown>> = {};
	const tools: Record<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }> = {};
	const sent: { content: string; details: { id: string } }[] = [];
	const passthrough = (o: unknown) => o;
	const pi = {
		typebox: { Type: { Object: passthrough, String: passthrough, Array: passthrough, Optional: passthrough, Number: passthrough } },
		on: (name: string, h: (e: unknown) => Promise<unknown>) => (handlers[name] = h),
		registerTool: (t: { name: string }) => (tools[t.name] = t as never),
		registerCommand: () => {},
		sendMessage: (m: { content: string; details: { id: string } }) => sent.push(m),
		getSessionName: () => undefined,
	};
	ompMail(pi as never);
	const ctx = {
		cwd: "/work/b",
		isIdle: () => true,
		hasUI: false,
		sessionManager: { getSessionId: () => "sid-b", getSessionFile: () => "/s/b.jsonl" },
	};
	await handlers.session_start({}, ctx);
	return { handlers, tools, sent, address: addressFor("sid-b") };
}

/** Yield to the event loop until the extension's inbox watcher has acted. */
async function until(cond: () => boolean) {
	while (!cond()) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

async function answers(): Promise<Letter[]> {
	const got: Letter[] = [];
	await drain(root, ASKER, (l) => void got.push(l));
	return got;
}

const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason });
const ask = (body: string) => newLetter({ kind: "ask", from: { name: "a", cwd: "/work/a", address: ASKER }, replyTo: ASKER, body });

beforeEach(() => {
	root = fs.mkdtempSync(join(tmpdir(), "omp-mail-ext-"));
	process.env.OMP_MAIL_DIR = root;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("a run's final message answers only the questions that entered its context", async () => {
	const b = await load();
	const q = ask("what is the code?");
	deposit(root, b.address, q);
	await until(() => b.sent.length === 1);
	expect(b.sent[0].content).toContain(q.id);

	// A run that ends before the question reaches context must not answer it.
	await b.handlers.agent_end({ messages: [assistant("unrelated work")] });
	expect(await answers()).toEqual([]);

	await b.handlers.message_end({ message: { role: "custom", customType: "omp-mail", details: b.sent[0].details } });
	await b.handlers.agent_end({ messages: [assistant("CODE-42")], willContinue: true });
	expect(await answers()).toEqual([]);

	await b.handlers.agent_end({ messages: [assistant("thinking"), assistant("CODE-42")] });
	expect(await answers()).toMatchObject([{ kind: "reply", inReplyTo: q.id, status: "done", body: "CODE-42" }]);

	// Answered once: a later run does not answer again, and mail_reply refuses.
	await b.handlers.agent_end({ messages: [assistant("again")] });
	expect(await answers()).toEqual([]);
	await expect(b.tools.mail_reply.execute("t", { ask_id: q.id, message: "x" })).rejects.toThrow();
	await b.handlers.session_shutdown({});
});

test("an aborted run answers stopped; shutdown fails open questions and keeps the session addressable", async () => {
	const b = await load();
	const first = ask("q1");
	deposit(root, b.address, first);
	await until(() => b.sent.length === 1);
	await b.handlers.message_end({ message: { role: "custom", customType: "omp-mail", details: b.sent[0].details } });
	await b.handlers.agent_end({ messages: [assistant("half", "aborted")] });
	expect(await answers()).toMatchObject([{ inReplyTo: first.id, status: "stopped" }]);

	const second = ask("q2");
	deposit(root, b.address, second);
	await until(() => b.sent.length === 2);
	await b.handlers.session_shutdown({});
	expect(await answers()).toMatchObject([{ inReplyTo: second.id, status: "failed" }]);
	expect(readRecord(root, b.address)?.pid).toBeNull();
});
