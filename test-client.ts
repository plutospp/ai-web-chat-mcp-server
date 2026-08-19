/**
 * Live acceptance client for ai-web-chat-mcp-server: spawns the server over
 * stdio and walks status → new_chat → send → read_reply for every provider
 * (chatgpt, claude, gemini, deepseek, grok, zai, kimi), saving reply
 * screenshots to shots/<provider>-reply.png. A provider failure prints
 * SKIP and continues; exits 0 when at least one provider fully passed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BUN = "C:/Users/User/.bun/bin/bun.exe";
const QUESTIONS: Record<string, string> = {
	chatgpt: "What's the difference between the Plus and Pro subscription tiers?",
	claude: "Explain what an MCP server is in two sentences.",
	gemini: "Name three use cases for Gemini API function calling.",
	deepseek: "What is DeepSeek-V3's context window size?",
	grok: "What's new in the latest Grok release?",
	zai: "What models does Z.ai currently offer?",
	kimi: "What is the maximum context length you support?",
	qwen: "What coding models are available right now?",
};
const PROVIDERS = ["chatgpt", "claude", "gemini", "deepseek", "grok", "zai", "kimi", "qwen"] as const;

const shotsDir = path.join(import.meta.dir, "shots");
mkdirSync(shotsDir, { recursive: true });

const transport = new StdioClientTransport({
	command: BUN,
	args: ["run", path.join(import.meta.dir, "src/server.ts")],
	stderr: "inherit",
});
const client = new Client({ name: "ai-web-chat-test-client", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map(t => t.name).sort().join(", "));

const passed: string[] = [];
const skipped: string[] = [];

for (const provider of PROVIDERS) {
	const question = QUESTIONS[provider];
	try {
		const status = await client.callTool({ name: "status", arguments: { provider } });
		if (status.isError) throw new Error(`status: ${JSON.stringify(status.content[0])}`);

		const newChat = await client.callTool({ name: "new_chat", arguments: { provider } });
		if (newChat.isError) throw new Error(`new_chat: ${JSON.stringify(newChat.content[0])}`);

		const send = await client.callTool({ name: "send", arguments: { provider, message: question } });
		if (send.isError) throw new Error(`send: ${JSON.stringify(send.content[0])}`);

		const reply = await client.callTool({ name: "read_reply", arguments: { provider, waitMs: 35_000 } });

		const textBlock = reply.content.find(b => b.type === "text");
		const imageBlock = reply.content.find(b => b.type === "image");
		if (!imageBlock || imageBlock.type !== "image") throw new Error("read_reply returned no screenshot");
		writeFileSync(path.join(shotsDir, `${provider}-reply.png`), Buffer.from(imageBlock.data, "base64"));

		const payload = textBlock && textBlock.type === "text" ? JSON.parse(textBlock.text) : {};
		console.log(`${provider}: PASS (complete=${payload.complete}) → shots/${provider}-reply.png`);
		if (provider === "qwen" && typeof payload.text === "string") {
			console.log(`qwen reply: ${payload.text.replace(/\s+/g, " ").slice(0, 400)}`);
		}
		passed.push(provider);
	} catch (error) {
		console.log(`${provider}: SKIP — ${error instanceof Error ? error.message : String(error)}`);
		skipped.push(provider);
	}
}

console.log(`summary: passed=[${passed.join(",")}] skipped=[${skipped.join(",")}]`);
await client.close();
process.exit(passed.length > 0 ? 0 : 1);
