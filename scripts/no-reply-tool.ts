/** e2e fixture: a model that never calls mail_reply, so only the automatic answer can reply. */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (e) => {
		if (JSON.stringify(e).includes("mail_reply")) return { block: true, reason: "mail_reply is unavailable. Answer in plain text instead." };
	});
}
