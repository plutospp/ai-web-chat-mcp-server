/**
 * Tests the `research` MCP tool: sends a research query through the MCP
 * protocol, waits for GPT Researcher to retrieve via DuckDuckGo + embed
 * locally + synthesize via qwen3.8-max, and prints the report + sources.
 */
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
	command: "C:/Users/User/.bun/bin/bun.exe",
	args: ["run", path.join(import.meta.dir, "src/server.ts")],
	stderr: "inherit",
});
const client = new Client({ name: "research-test", version: "1.0.0" });
await client.connect(transport);

console.log("dispatching research...");
const res = await client.callTool(
	{
		name: "research",
		arguments: { query: "What is Model Context Protocol (MCP) in two paragraphs?" },
	},
	undefined,
	{ timeout: 360_000 },
);

if (res.isError) {
	console.error("FAIL:", JSON.stringify(res.content[0]));
	process.exit(1);
}
const text = res.content.find(b => b.type === "text")?.text ?? "";
const parsed = JSON.parse(text) as { query: string; report: string; sources: Array<{ title: string; url: string }> };
console.log("query:", parsed.query);
console.log("sources count:", parsed.sources?.length ?? 0);
console.log("--- report excerpt ---");
console.log(String(parsed.report || "").slice(0, 800));
await client.close();
process.exit(parsed.report ? 0 : 2);
