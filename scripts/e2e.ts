#!/usr/bin/env bun
/**
 * End-to-end check against real omp sessions over RPC. Spends model tokens.
 *
 *   bun scripts/e2e.ts [scenario...] [--model M]
 *
 * Scenarios: idle busy resume ask ask-auto ask-dies cli-ask (default: all).
 * Each scenario starts fresh sessions with only this extension loaded and an
 * isolated mail directory, and prints one JSON line with pass/fail.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FileSink, Subprocess } from "bun";

const REPO = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const modelIdx = args.indexOf("--model");
const MODEL = modelIdx >= 0 ? args.splice(modelIdx, 2)[1] : "claude-sonnet-4-6";
const ALL = ["idle", "busy", "resume", "ask", "ask-auto", "ask-dies", "cli-ask"];
const scenarios = args.length > 0 ? args : ALL;

type Event = Record<string, any>;

/** Sessions of the running scenario, dumped when it fails. */
const live: Session[] = [];

class Session {
	proc: Subprocess;
	events: Event[] = [];
	#waiters: (() => void)[] = [];
	readonly t0 = Date.now();

	constructor(cwd: string, env: Record<string, string>, extra: string[] = []) {
		this.proc = Bun.spawn(
			["omp", "--mode", "rpc", "--no-ui", "--no-extensions", "--no-skills", "--no-rules", "--no-title", "--model", MODEL, "-e", REPO, ...extra],
			{ cwd, env: { ...process.env, ...env }, stdin: "pipe", stdout: "pipe", stderr: "ignore" },
		);
		void this.#read();
		live.push(this);
	}

	async #read() {
		let buf = "";
		for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
			buf += new TextDecoder().decode(chunk);
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				try {
					this.events.push({ ...JSON.parse(line), _t: Date.now() });
				} catch {}
				for (const w of this.#waiters.splice(0)) w();
			}
		}
	}

	send(obj: Event) {
		const stdin = this.proc.stdin as FileSink;
		stdin.write(`${JSON.stringify(obj)}\n`);
		stdin.flush();
	}

	async waitFor(pred: (e: Event) => boolean, timeoutMs: number): Promise<Event | undefined> {
		const end = Date.now() + timeoutMs;
		let seen = 0;
		while (Date.now() < end) {
			for (; seen < this.events.length; seen++) if (pred(this.events[seen])) return this.events[seen];
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.push(resolve);
			await Promise.race([promise, Bun.sleep(Math.max(0, end - Date.now()))]);
		}
		return undefined;
	}

	async prompt(message: string, timeoutMs = 180_000): Promise<Event | undefined> {
		const id = randomBytes(4).toString("hex");
		this.send({ type: "prompt", message, id });
		return this.waitFor((e) => e.type === "prompt_result" && e.id === id, timeoutMs);
	}

	/** Every tool call and result in the session, as text. */
	transcript(): string {
		return JSON.stringify(this.events.filter((e) => e.type === "message_end").map((e) => e.message));
	}

	finalText(): string {
		const ends = this.events.filter((e) => e.type === "message_end" && e.message?.role === "assistant");
		const content = ends.at(-1)?.message?.content ?? [];
		return content.filter((c: Event) => c.type === "text").map((c: Event) => c.text).join("\n");
	}

	async close() {
		this.proc.kill();
		await this.proc.exited;
	}
}

function setup() {
	const root = fs.mkdtempSync(join(tmpdir(), "omp-mail-e2e-"));
	for (const d of ["a", "b", "mail"]) fs.mkdirSync(join(root, d));
	return { root, a: join(root, "a"), b: join(root, "b"), env: { OMP_MAIL_DIR: join(root, "mail"), PI_NO_TITLE: "1" } };
}

const nonce = (p: string) => `${p}-${randomBytes(3).toString("hex").toUpperCase()}`;
const STARTUP_MS = 8_000;

async function run(name: string): Promise<Record<string, unknown>> {
	const { a, b, env } = setup();
	const t0 = Date.now();
	const secs = () => Math.round((Date.now() - t0) / 100) / 10;
	switch (name) {
		case "idle": {
			const B = new Session(b, env);
			const A = new Session(a, env);
			await Bun.sleep(STARTUP_MS);
			const token = nonce("PING");
			await A.prompt(`Use mail_send to send exactly "${token}" to the session in directory ${b}. Report the delivery result.`);
			const hit = await B.waitFor((e) => JSON.stringify(e).includes(token), 30_000);
			const woke = B.events.some((e) => e.type === "agent_start");
			await Promise.all([A.close(), B.close()]);
			return { pass: !!hit && woke, delivered: !!hit, b_woke: woke, a_result: A.finalText().slice(0, 200) };
		}
		case "busy": {
			const B = new Session(b, env);
			const A = new Session(a, env);
			await Bun.sleep(STARTUP_MS);
			B.send({ type: "prompt", id: "busy", message: "Run exactly this bash command: sleep 40 . Then reply DONE. If a message arrives meanwhile, quote it verbatim in your final reply." });
			await B.waitFor((e) => e.type === "tool_execution_start", 60_000);
			const busyAt = Date.now();
			const token = nonce("BUSY");
			await A.prompt(`Use mail_send to send exactly "${token}" to the session in directory ${b}.`);
			const hit = await B.waitFor((e) => e.type === "message_end" && JSON.stringify(e).includes(token), 90_000);
			await B.waitFor((e) => e.type === "prompt_result" && e.id === "busy", 120_000);
			const quoted = B.finalText().includes(token);
			await Promise.all([A.close(), B.close()]);
			return { pass: !!hit && quoted, delivered: !!hit, seconds_after_busy_start: hit ? Math.round((hit._t - busyAt) / 100) / 10 : null, b_quoted: quoted };
		}
		case "resume": {
			const B1 = new Session(b, env);
			await Bun.sleep(STARTUP_MS);
			await B1.prompt("Reply with the single word READY.");
			await B1.close();
			const A = new Session(a, env);
			await Bun.sleep(STARTUP_MS);
			const token = nonce("LATER");
			await A.prompt(`Use mail_send to send exactly "${token}" to the session in directory ${b}. It is not running; that is expected. Report the result.`);
			const queued = /queued/i.test(A.transcript());
			const B2 = new Session(b, env, ["--continue"]);
			const hit = await B2.waitFor((e) => JSON.stringify(e).includes(token), 60_000);
			const woke = await B2.waitFor((e) => e.type === "agent_start", 30_000);
			await Promise.all([A.close(), B2.close()]);
			return { pass: queued && !!hit && !!woke, a_saw_queued: queued, delivered_on_resume: !!hit, b_woke: !!woke };
		}
		case "ask":
		case "ask-auto": {
			// ask-auto blocks mail_reply in B, so only the automatic answer at run end can reply.
			const B = new Session(b, env, name === "ask-auto" ? ["-e", join(REPO, "scripts/no-reply-tool.ts")] : []);
			const A = new Session(a, env);
			await Bun.sleep(STARTUP_MS);
			const code = nonce("CODE");
			const style = name === "ask-auto" ? "If another session asks for it, answer with the code word as plain text." : "If another session asks for it, answer.";
			await B.prompt(`Remember this code word: ${code}. Do not write it anywhere. ${style} Reply OK now.`);
			const askAt = Date.now();
			await A.prompt(`Use mail_ask to ask the session in directory ${b} for its code word. Then tell me the code word it returned.`, 240_000);
			const inResult = A.events.some((e) => e.type === "message_end" && e.message?.role === "toolResult" && JSON.stringify(e.message).includes(code));
			const bCalledReply = B.events.some(
				(e) => e.type === "message_end" && e.message?.role === "assistant" && JSON.stringify(e.message.content.filter((c: Event) => c.type === "toolCall")).includes("mail_reply"),
			);
			await Promise.all([A.close(), B.close()]);
			return { pass: inResult, answer_in_ask_result: inResult, b_called_mail_reply: bCalledReply, seconds: Math.round((Date.now() - askAt) / 1000) };
		}
		case "ask-dies": {
			const B = new Session(b, env);
			const A = new Session(a, env);
			await Bun.sleep(STARTUP_MS);
			B.send({ type: "prompt", id: "busy", message: "Run exactly this bash command: sleep 120 . Then reply DONE." });
			await B.waitFor((e) => e.type === "tool_execution_start", 60_000);
			A.send({ type: "prompt", id: "ask", message: `Use mail_ask to ask the session in directory ${b} what it is working on. Report what the tool returned.` });
			await A.waitFor((e) => e.type === "tool_execution_start" && JSON.stringify(e).includes("mail_ask"), 120_000);
			await Bun.sleep(3_000);
			const killedAt = Date.now();
			B.proc.kill(9);
			const end = await A.waitFor((e) => e.type === "tool_execution_end" && JSON.stringify(e).includes("stopped running"), 30_000);
			await A.close();
			return { pass: !!end, ended_with_stopped_running: !!end, seconds_after_kill: end ? Math.round((end._t - killedAt) / 100) / 10 : null };
		}
		case "cli-ask": {
			const B = new Session(b, env);
			await Bun.sleep(STARTUP_MS);
			const code = nonce("CLI");
			await B.prompt(`Remember this code word: ${code}. Reply OK.`);
			const cli = Bun.spawn(["bun", join(REPO, "bin/omp-mail.ts"), "ask", b, "What is your code word? Answer with only the code word.", "--timeout", "180"], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
			const out = await new Response(cli.stdout).text();
			const code_ = await cli.exited;
			await B.close();
			return { pass: code_ === 0 && out.includes(code), exit: code_, stdout: out.trim().slice(0, 200), seconds: secs() };
		}
		default:
			throw new Error(`unknown scenario ${name}`);
	}
}

let failed = 0;
for (const name of scenarios) {
	live.length = 0;
	const result: Record<string, unknown> = await run(name).catch((e) => ({ pass: false, error: String(e) }));
	if (!result.pass) {
		failed++;
		result.events = join(tmpdir(), `omp-mail-e2e-${name}-${Date.now()}.json`);
		fs.writeFileSync(result.events as string, JSON.stringify(live.map((s) => s.events)));
	}
	console.log(JSON.stringify({ scenario: name, ...result }));
}
process.exit(failed > 0 ? 1 : 0);
