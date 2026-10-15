#!/usr/bin/env bun
/** Send to omp sessions from scripts, hooks, or a shell. */

import { randomBytes } from "node:crypto";
import { formatListing } from "../src/format.ts";
import {
	addressFor,
	deposit,
	drain,
	ensureRoot,
	formatOutcomes,
	type Letter,
	mailRoot,
	newLetter,
	presenceOf,
	readRecords,
	removeSession,
	resolveTarget,
	send,
	waitForAnswer,
	writeRecord,
} from "../src/store.ts";

const USAGE = `usage:
  omp-mail list
  omp-mail send <to>[,<to>...] <message...>     message "-" reads stdin
  omp-mail ask <to> <question...> [--timeout S]  prints the answer; exit 2 if none

<to> is a session name, address, directory, or session id.
--name N sets the sender name (default: omp-mail-cli).`;

function fail(msg: string, code = 1): never {
	console.error(msg);
	process.exit(code);
}

const argv = process.argv.slice(2);
const flag = (name: string) => {
	const i = argv.indexOf(name);
	if (i < 0) return undefined;
	const [, value] = argv.splice(i, 2);
	if (value === undefined) fail(`${name} needs a value`);
	return value;
};
const name = flag("--name") ?? "omp-mail-cli";
const timeoutS = Number(flag("--timeout") ?? 600);
const [cmd, to, ...rest] = argv;
const root = mailRoot();
ensureRoot(root);
const body = rest.length === 1 && rest[0] === "-" ? await new Response(Bun.stdin.stream()).text() : rest.join(" ");

if (cmd === "list") {
	console.log(formatListing(readRecords(root)));
} else if (cmd === "send" && to && body) {
	const outcomes = await send(root, { name, cwd: process.cwd() }, to.split(","), body);
	console.log(formatOutcomes(outcomes));
	if (outcomes.some((o) => o.result === "refused")) process.exitCode = 1;
} else if (cmd === "ask" && to && body) {
	await ask(to, body);
} else {
	fail(USAGE);
}

async function ask(to: string, question: string) {
	const r = resolveTarget(readRecords(root), to);
	if (!r.ok) fail(r.error);
	if (presenceOf(r.record) !== "live") fail(`${r.record.name} is not running; use send to queue a message instead.`, 2);
	// A hidden, short-lived inbox so the answer has somewhere to land.
	const sessionId = `cli-${randomBytes(8).toString("hex")}`;
	const address = addressFor(sessionId);
	const cwd = process.cwd();
	writeRecord(root, { v: 1, address, name, cwd, sessionId, pid: process.pid, beatAt: Date.now(), state: "working", waitingOn: r.record.address, process: true });
	process.on("SIGINT", () => {
		removeSession(root, address);
		process.exit(130);
	});
	try {
		const letter = newLetter({ kind: "ask", from: { name, cwd, address }, replyTo: address, body: question });
		deposit(root, r.record.address, letter);
		let answer: Letter | undefined;
		const wait = await waitForAnswer({
			root,
			target: r.record.address,
			timeoutMs: timeoutS * 1000,
			poll: async () => {
				await drain(root, address, (l) => {
					if (l.kind === "reply" && l.inReplyTo === letter.id) answer = l;
				});
				return answer;
			},
		});
		if (wait.kind !== "answer") {
			console.error(`no answer (${wait.kind})`);
			process.exitCode = 2;
			return;
		}
		if (wait.letter.status && wait.letter.status !== "done") console.error(`status: ${wait.letter.status}`);
		console.log(wait.letter.body);
	} finally {
		removeSession(root, address);
	}
}
