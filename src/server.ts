/**
 * ai-web-chat-mcp-server — MCP stdio server that chats with AI desktop apps
 * (chatgpt, claude, gemini, deepseek, grok, zai, kimi, qwen). All eight run
 * as taskbar-pinned Chrome PWAs (chrome_proxy --app-id=...) driven through
 * the omp computer-tool supervisor.
 *
 * Tools: status, new_chat, send, read_reply, screenshot — each takes a
 * `provider`. All desktop actions are mutex-serialized; PWA input always
 * uses foreground delivery (Chromium drops background input); replies are
 * read from returned screenshots (Chromium keeps reply text out of AX).
 */
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ComputerSupervisor } from "@oh-my-pi/pi-coding-agent/src/tools/computer/supervisor";

const CHROME_PROXY = "C:/Program Files/Google/Chrome/Application/chrome_proxy.exe";

// Each AI runs as a taskbar-pinned Chrome PWA (chrome_proxy --app-id=...);
// launching a running PWA focuses its single window instead of opening a tab.
// `first` is the composer position as [width, height] fractions, tried before
// the generic candidate list (Cursor's composer sits high, ~0.22h).
const PROVIDERS = {
	chatgpt: { appId: "nnjgmfocjdenbibfdolbnhohghkkaeed", keyword: "ChatGPT" },
	claude: { appId: "fmpnliohjhemenmnlpbfagaolkdacoja", keyword: "Claude" },
	gemini: { appId: "gdfaincndogidkdcdkhapmbffkckdkhn", keyword: "Gemini" },
	deepseek: { appId: "hmjcdonmhijmnefklekckjkeoknbiipb", keyword: "DeepSeek" },
	grok: { appId: "ggjocahimgaohmigbfhghnlfcnjemagj", keyword: "Grok" },
	zai: { appId: "gdgigfecimkcdjjhnglafmbeafpchpmf", keyword: "Z.ai" },
	kimi: { appId: "glpbkcdjcimgmjagngpeidnkiojjookh", keyword: "Kimi" },
	qwen: { appId: "callopjomjkljkgpgnflciibleibpnbp", keyword: "Qwen" },
	cursor: { appId: "appgkjomdnhhdolojlpkjafpklojikld", keyword: "Cursor", first: [0.5, 0.22] },
} as const;

type Provider = keyof typeof PROVIDERS;
const PROVIDER_ENUM = z.enum(Object.keys(PROVIDERS) as [Provider, ...Provider[]]);

const SUPERVISOR_PATH = path.join(
	os.homedir(),
	".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/tools/computer/supervisor.ts",
);

const SNAPSHOT = {
	cwd: process.cwd(),
	sessionId: "ai-web-chat-mcp-server",
	captureMaxWidth: 1920,
	captureMaxHeight: 1200,
	display: "all",
	readOnly: false,
};

let sup: ComputerSupervisor | null = null;
let supLoading: Promise<ComputerSupervisor> | null = null;

async function getSupervisor(): Promise<ComputerSupervisor> {
	if (sup) return sup;
	if (!supLoading) {
		supLoading = (async () => {
			// Runtime-resolved path under the user home; static import cannot
			// express it, and the module is TypeScript executed directly by Bun.
			const mod = await import(pathToFileURL(SUPERVISOR_PATH).href);
			sup = new mod.ComputerSupervisor({}) as ComputerSupervisor;
			return sup;
		})();
	}
	return supLoading;
}

// Serialization mutex: desktop automation is exclusive per desktop.
let mutex: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
	const next = mutex.then(fn, fn);
	mutex = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

const sleep = (ms: number): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
};

type Win = { id: string; x: number; y: number; width: number; height: number };

async function runSup(code: string, timeoutMs: number): Promise<{ returnValue: unknown; screenshots: Array<{ path: string }> }> {
	const s = await getSupervisor();
	return s.run(code, timeoutMs, SNAPSHOT);
}

async function listProviderWindows(keyword: string): Promise<Win[]> {
	const r = await runSup(`
const ws = await desktop.windows();
ws.filter(w => String(w.app) === "Google Chrome" && String(w.title).includes(${JSON.stringify(keyword)}))
	.map(w => ({ id: String(w.id), x: w.x, y: w.y, width: w.width, height: w.height, focused: w.focused === true, title: String(w.title) }))`, 20_000);
	return (r.returnValue as Array<Win & { focused: boolean; title: string }> | null) ?? [];
}

const windowCache = new Map<Provider, string>();

const winByIdCode = (id: string): string => `
const ws = await desktop.windows();
const hit = ws.find(w => String(w.id) === ${JSON.stringify(id)});
hit ? { id: String(hit.id), x: hit.x, y: hit.y, width: hit.width, height: hit.height } : null`;

/** Launch the provider's PWA app; focus its single window or wait for it to appear. */
async function findProviderWindow(name: Provider): Promise<Win> {
	// Cached window id survives the post-send title churn (title becomes the
	// conversation topic, which no longer contains the provider keyword).
	const cachedId = windowCache.get(name);
	if (cachedId) {
		const r = await runSup(winByIdCode(cachedId), 20_000);
		if (r.returnValue) return r.returnValue as Win;
		windowCache.delete(name);
	}
	const { appId, keyword } = PROVIDERS[name];
	const rank = (wins: Array<Win & { focused: boolean; title?: string }>) =>
		wins.find(w => w.title === keyword) ?? wins.find(w => w.focused) ?? wins[0];
	const existing = await listProviderWindows(keyword);
	if (existing.length > 0) {
		const ranked = rank(existing as Array<Win & { focused: boolean }>);
		if (ranked) {
			windowCache.set(name, ranked.id);
			return ranked;
		}
	}
	Bun.spawn([CHROME_PROXY, "--profile-directory=Default", `--app-id=${appId}`]);
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		await sleep(1500);
		const wins = await listProviderWindows(keyword);
		if (wins.length > 0) {
			const found = rank(wins as Array<Win & { focused: boolean }>)!;
			windowCache.set(name, found.id);
			return found;
		}
	}
	throw new Error(`${name}: PWA window did not appear — check the taskbar pin`);
}

async function lastShotBase64(shots: Array<{ path: string }>): Promise<string | null> {
	const shot = shots[shots.length - 1];
	if (!shot) return null;
	try {
		const buf = await Bun.file(shot.path).arrayBuffer();
		return Buffer.from(buf).toString("base64");
	} catch {
		return null;
	}
}

function imageBlock(b64: string) {
	return { type: "image" as const, data: b64, mimeType: "image/png" };
}
function textBlock(value: unknown) {
	return { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 1) };
}

const FIND_HINT = (win: Win): string => `await desktop.window(${JSON.stringify(win.id)})`;

// ── Tool bodies ─────────────────────────────────────────────────────────────

async function toolStatus(provider: Provider): Promise<ContentBlock[]> {
	const win = await findProviderWindow(provider);
	const r = await runSup(
		`const w = ${FIND_HINT(win)};
w.raise();
const caps = await desktop.capabilities();
({ found: true, id: ${JSON.stringify(win.id)}, x: ${win.x}, y: ${win.y}, width: ${win.width}, height: ${win.height}, capabilities: caps })`,
		20_000,
	);
	return [textBlock(r.returnValue)];
}

async function toolNewChat(provider: Provider): Promise<ContentBlock[]> {
	// Every PWA resumes its last conversation; the sidebar new-chat button
	// (localized variants below) starts a fresh one in the same window.
	const win = await findProviderWindow(provider);
	const r = await runSup(
		`const w = ${FIND_HINT(win)};
w.raise();
await new Promise(r => setTimeout(r, 500));
await w.screenshot({ silent: true });
const btns = await w.find({ role: "button", limit: 300 });
let target = null;
for (const b of btns) {
	try {
		const t = String(b.title || "");
		if (/new chat|新對話|新对话|新聊天|新建会话|新建會話/i.test(t)) {
			const bd = await b.bounds();
			if (bd.width > 40) { target = { cx: bd.x - ${win.x} + Math.round(bd.width / 2), cy: bd.y - ${win.y} + Math.round(bd.height / 2) }; break; }
		}
	} catch {}
}
let ok = false;
if (target) {
	await w.click(target.cx, target.cy, { delivery: "foreground" });
	await new Promise(r => setTimeout(r, 1500));
	ok = true;
}
await w.screenshot({ silent: false });
({ ok })`,
		30_000,
	);
	const v = r.returnValue as { ok: boolean };
	const shot = await lastShotBase64(r.screenshots);
	const blocks: ContentBlock[] = [textBlock(v)];
	if (shot) blocks.push(imageBlock(shot));
	return blocks;
}

async function toolSend(provider: Provider, message: string): Promise<ContentBlock[]> {
	const win = await findProviderWindow(provider);
	const msgLit = JSON.stringify(message);
	const r = await runSup(
		`const w = ${FIND_HINT(win)};
w.raise();
await new Promise(r => setTimeout(r, 3000));
const baseShot = await w.screenshot({ silent: true });
const hashPng = async (p) => {
	try {
		const buf = await Bun.file(p).arrayBuffer();
		const view = new Uint8Array(buf);
		let a = 0;
		for (let i = 0; i < view.length; i += 61) { a = (a * 31 + view[i]) | 0; }
		return view.length + ":" + a;
	} catch { return ""; }
};
let baseHash = "";
for (let i = 0; i < 8; i++) {
	const h1 = await hashPng((await w.screenshot({ silent: true })).path);
	await new Promise(r => setTimeout(r, 700));
	const h2 = await hashPng((await w.screenshot({ silent: true })).path);
	if (h1 && h1 === h2) { baseHash = h1; break; }
}
const msg = ${msgLit};
const norm = s => String(s).replace(/\\s+/g, "");
const probe = msg.slice(0, 30);
let savedClip = "";
try { savedClip = String(await desktop.clipboard.read() ?? ""); } catch {}
await desktop.clipboard.write(msg);
const candidates = [
	// provider-specific composer position (Cursor: high composer at ~0.22h)
	${PROVIDERS[provider].first ? `[Math.round(${win.width} * ${PROVIDERS[provider].first[0]}), Math.round(${win.height} * ${PROVIDERS[provider].first[1]})],` : ""}
	// Qwen Studio / sidebar-offset new-chat layout (center of right pane)
	[Math.round(${win.width} * 0.63), Math.round(${win.height} * 0.485)],
	// Centered new-chat layouts (ChatGPT, Claude, Grok, Z.ai)
	[Math.round(${win.width} * 0.5), Math.round(${win.height} * 0.40)],
	[Math.round(${win.width} * 0.5), Math.round(${win.height} * 0.44)],
	[Math.round(${win.width} * 0.5), Math.round(${win.height} * 0.52)],
	[Math.round(${win.width} * 0.5), Math.round(${win.height} * 0.85)],
	[Math.round(${win.width} * 0.5), ${win.height} - 40],
	[Math.round(${win.width} * 0.5), ${win.height} - 60],
	[Math.round(${win.width} * 0.5), ${win.height} - 90],
	[Math.round(${win.width} * 0.5), ${win.height} - 110],
];
let confirmed = "";
const checkDraft = async (cx, cy) => {
	try {
		const fe = await desktop.focusedElement();
		const val = fe ? String(await fe.value()) : "";
		if (val.includes(probe) || norm(val).includes(norm(probe))) return true;
	} catch {}
	try {
		const el = await desktop.elementAt(${win.x} + cx, ${win.y} + cy);
		const title = el ? String(el.title || "") : "";
		if (title.includes(probe) || norm(title).includes(norm(probe))) return true;
	} catch {}
	return false;
};
const axBlind = async () => {
	try {
		const fe = await desktop.focusedElement();
		const val = fe ? String(await fe.value()) : "";
		return /^https?:\\/\\//.test(val) || val === "undefined";
	} catch { return true; }
};
let typedUsed = false;
for (let round = 0; round < 2 && !confirmed; round++) {
	if (round > 0) await new Promise(r => setTimeout(r, 1500));
	for (const [cx, cy] of candidates) {
		await w.click(cx, cy, { delivery: "foreground" });
		await new Promise(r => setTimeout(r, 300));
		await w.press("ctrl+a", { delivery: "foreground" });
		await w.press("ctrl+v", { delivery: "foreground" });
		await new Promise(r => setTimeout(r, 400));
		if (await checkDraft(cx, cy)) { confirmed = "paste"; break; }
		if (!typedUsed) {
			const blind = await axBlind();
			if (blind) {
				typedUsed = true;
				const parts = msg.split(" ");
				for (let i = 0; i < parts.length; i++) {
					await w.type(parts[i], { delivery: "foreground" });
					if (i < parts.length - 1) {
						await w.press("escape", { delivery: "foreground" });
						await w.press("space", { delivery: "foreground" });
						await new Promise(r => setTimeout(r, 60));
					}
				}
				await new Promise(r => setTimeout(r, 400));
				if (await checkDraft(cx, cy)) { confirmed = "typed"; break; }
				const afterHash = await hashPng((await w.screenshot({ silent: true })).path);
				if (afterHash && afterHash !== baseHash) { confirmed = "typed-unverified"; break; }
			} else {
				typedUsed = true;
				await w.press("ctrl+a", { delivery: "foreground" });
				await w.press("Delete", { delivery: "foreground" });
				let empty = false;
				try {
					const fe = await desktop.focusedElement();
					const val = fe ? String(await fe.value()) : "";
					empty = norm(val).length === 0;
				} catch {}
				if (empty) {
					const parts = msg.split(" ");
					for (let i = 0; i < parts.length; i++) {
						await w.type(parts[i], { delivery: "foreground" });
						if (i < parts.length - 1) {
							await w.press("escape", { delivery: "foreground" });
							await w.press("space", { delivery: "foreground" });
							await new Promise(r => setTimeout(r, 60));
						}
					}
					await new Promise(r => setTimeout(r, 400));
					if (await checkDraft(cx, cy)) { confirmed = "typed"; break; }
				}
			}
		}
	}
}
try { await desktop.clipboard.write(savedClip); } catch {}
if (!confirmed) throw new Error("send: draft not confirmed at any composer candidate");
await w.press("Enter", { delivery: "foreground" });
await new Promise(r => setTimeout(r, 1200));
await w.screenshot({ silent: false });
({ ok: true, confirmed })`,
		45_000,
	);
	const v = r.returnValue as { ok: boolean; confirmed: boolean };
	const shot = await lastShotBase64(r.screenshots);
	const blocks: ContentBlock[] = [textBlock(v)];
	if (shot) blocks.push(imageBlock(shot));
	return blocks;
}

async function toolReadReply(provider: Provider, waitMs: number): Promise<ContentBlock[]> {
	const win = await findProviderWindow(provider);
	const r = await runSup(
		`const w = ${FIND_HINT(win)};
w.raise();
await new Promise(r => setTimeout(r, 400));
const waitMs = ${waitMs};
const start = Date.now();
let prevHash = "";
let stable = 0;
let complete = false;
while (true) {
	const shot = await w.screenshot({ silent: true });
	let curHash = "";
	try {
		const buf = await Bun.file(shot.path).arrayBuffer();
		const view = new Uint8Array(buf);
		let a = 0;
		for (let i = 0; i < view.length; i += 61) { a = (a * 31 + view[i]) | 0; }
		curHash = view.length + ":" + a;
	} catch {}
	if (curHash && curHash === prevHash) stable += 1; else stable = 0;
	prevHash = curHash;
	const elapsed = Date.now() - start;
	if (stable >= 2 && elapsed >= 8000) { complete = true; break; }
	if (elapsed >= waitMs) break;
	await new Promise(r => setTimeout(r, 3000));
}
await w.screenshot({ silent: false });
({ complete })`,
		waitMs + 15_000,
	);
	const v = r.returnValue as { complete: boolean };
	const shot = await lastShotBase64(r.screenshots);
	const blocks: ContentBlock[] = [
		textBlock({
			complete: v.complete,
			note: "Chromium keeps reply text out of the accessibility tree; extract the reply from the returned screenshot.",
		}),
	];
	if (shot) blocks.push(imageBlock(shot));
	return blocks;
}

async function toolScreenshot(provider: Provider): Promise<ContentBlock[]> {
	const win = await findProviderWindow(provider);
	const r = await runSup(
		`const w = ${FIND_HINT(win)};
w.raise();
await new Promise(r => setTimeout(r, 400));
await w.screenshot({ silent: false });
({ ok: true })`,
		20_000,
	);
	const shots = r.screenshots;
	const shot = shots[shots.length - 1];
	const blocks: ContentBlock[] = [textBlock({ path: shot?.path ?? null })];
	const b64 = await lastShotBase64(shots);
	if (b64) blocks.push(imageBlock(b64));
	return blocks;
}

// ── Server wiring ───────────────────────────────────────────────────────────

const server = new McpServer({ name: "ai-web-chat-mcp-server", version: "1.0.0" });

function withErrorBoundary(fn: () => Promise<ContentBlock[]>): Promise<CallToolResult> {
	return withLock(fn).then(
		content => ({ content }),
		(error: unknown) => ({
			content: [{ type: "text" as const, text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }],
			isError: true,
		}),
	);
}

const providerDesc = "chatgpt | claude | gemini | deepseek | grok | zai | kimi | qwen | cursor";

server.registerTool(
	"status",
	{
		description: `Locate (or open) the ${providerDesc} desktop app window; returns geometry and capabilities.`,
		inputSchema: { provider: PROVIDER_ENUM },
	},
	args => withErrorBoundary(() => toolStatus(args.provider)),
);

server.registerTool(
	"new_chat",
	{
		description: `Open a fresh conversation in the ${providerDesc} desktop app. Returns a screenshot of the new-chat view.`,
		inputSchema: { provider: PROVIDER_ENUM },
	},
	args => withErrorBoundary(() => toolNewChat(args.provider)),
);

server.registerTool(
	"send",
	{
		description:
			`Send a message in the ${providerDesc} desktop app. Write messages in natural human style — never loop-test phrasing or automation language. Returns a screenshot; verify the user bubble is visible.`,
		inputSchema: {
			provider: PROVIDER_ENUM,
			message: z.string().describe("Message text to send"),
		},
	},
	args => withErrorBoundary(() => toolSend(args.provider, args.message)),
);

server.registerTool(
	"read_reply",
	{
		description:
			"Wait for the provider's reply to stabilize (screenshot pixel stability) and return the final screenshot. Read the reply text from the image. If complete=false, call again with a larger waitMs.",
		inputSchema: {
			provider: PROVIDER_ENUM,
			waitMs: z.number().optional().describe("Max wait in milliseconds (default 20000)"),
		},
	},
	args => withErrorBoundary(() => toolReadReply(args.provider, args.waitMs ?? 20_000)),
);

server.registerTool(
	"screenshot",
	{
		description: `Capture the current ${providerDesc} desktop app window; returns the PNG path and image.`,
		inputSchema: { provider: PROVIDER_ENUM },
	},
	args => withErrorBoundary(() => toolScreenshot(args.provider)),
);

async function shutdown(): Promise<void> {
	try {
		await sup?.close();
	} catch {}
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const transport = new StdioServerTransport();
transport.onclose = () => void shutdown();
await server.connect(transport);
