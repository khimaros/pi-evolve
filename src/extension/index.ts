/**
 * pi-evolve — pi-coding-agent extension implementing the hook protocol.
 *
 * loads executable hook scripts from $EVOLVE_WORKSPACE/hooks/, registers their
 * declared tools, and invokes lifecycle stages (mutate_request, observe_message,
 * before_stop, heartbeat, compacting, before_tool/after_tool, execute_tool, recover,
 * format_notification) by forking a subprocess per call with JSON on stdin and
 * JSONL on stdout. existing opencode-evolve hooks run unchanged.
 *
 * see https://github.com/khimaros/hcp-spec/ for the wire contract.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { Type, type TSchema } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	createAgentSession,
	DefaultResourceLoader,
	formatSkillsForPrompt,
	getAgentDir,
	serializeConversation,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai";

// shape of a tool result expected by pi: { content: [...], details, terminate? }
function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

// untyped tool registration — avoids TypeBox-induced deep type instantiation
// across many registerTool calls in this file.
function regTool(pi: ExtensionAPI, def: any): void {
	(pi.registerTool as (d: any) => void)(def);
}

// ─── workspace + config ─────────────────────────────────────────────────────

const DEFAULT_WORKSPACE = path.join(os.homedir(), "workspace");

function resolveWorkspace(): string {
	return process.env.EVOLVE_WORKSPACE || process.env.OPENCODE_EVOLVE_WORKSPACE || DEFAULT_WORKSPACE;
}

const WORKSPACE = resolveWorkspace();
const HOOKS_DIR = path.join(WORKSPACE, "hooks");
const PROMPTS_DIR = path.join(WORKSPACE, "prompts");
const TESTS_DIR = path.join(WORKSPACE, "tests");
const STATE_DIR = path.join(WORKSPACE, "state");
const STATE_FILE = path.join(STATE_DIR, "evolve.json");

// prompt contract — fixed filenames the host loads and injects as ctx.prompts
const PROMPT_FILES = ["preamble", "chat", "heartbeat", "compaction", "recover"] as const;
type PromptStage = (typeof PROMPT_FILES)[number];

// stages whose failure triggers a recover cascade. whitelist (not
// blacklist) so new stages opt in explicitly — the recover path
// re-enters the LLM with synthetic system+user, so the default for any
// observational stage must be "no cascade". current members feed text
// back into the request: mutate_request composes the system prompt;
// heartbeat injects an autonomous user turn. before_stop is excluded
// deliberately — recover-induced re-entry on a stage that exists to
// signal loop termination is a footgun.
const RECOVER_HOOKS = new Set(["mutate_request", "heartbeat"]);

const HOOK_TIMEOUT_MS = Number(process.env.EVOLVE_HOOK_TIMEOUT_MS) || 30_000;
const HEARTBEAT_INTERVAL_MS = Number(process.env.EVOLVE_HEARTBEAT_MS) || 1_800_000;

// append Pi's stock available_skills block to the workspace-built system
// prompt so downstream extensions (e.g. pi-skillful) that target that section
// by regex can still find and patch it. on by default; opt out with
// EVOLVE_PRESERVE_SKILLS=0.
const PRESERVE_SKILLS = process.env.EVOLVE_PRESERVE_SKILLS !== "0";

// ─── small helpers ──────────────────────────────────────────────────────────

function readFileOrEmpty(p: string): string {
	try {
		return fs.readFileSync(p, "utf-8");
	} catch {
		return "";
	}
}

function loadPrompts(): Record<PromptStage, string> {
	const out = {} as Record<PromptStage, string>;
	for (const stage of PROMPT_FILES) {
		out[stage] = readFileOrEmpty(path.join(PROMPTS_DIR, `${stage}.md`));
	}
	return out;
}

function listHookScripts(): string[] {
	if (!fs.existsSync(HOOKS_DIR)) return [];
	return fs
		.readdirSync(HOOKS_DIR)
		.filter((name) => !name.startsWith(".") && !name.startsWith("__"))
		.filter((name) => {
			try {
				const st = fs.statSync(path.join(HOOKS_DIR, name));
				return st.isFile() && (st.mode & 0o111) !== 0;
			} catch {
				return false;
			}
		})
		.sort();
}

function debugLog(line: string): void {
	if (!process.env.EVOLVE_DEBUG) return;
	process.stderr.write(`[evolve] ${line}\n`);
}

// ─── subprocess hook invocation ────────────────────────────────────────────

interface HookResult {
	[key: string]: any;
}

async function runHookScript(scriptPath: string, stage: string, ctx: Record<string, any>): Promise<HookResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(scriptPath, [stage], {
			cwd: WORKSPACE,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, EVOLVE_WORKSPACE: WORKSPACE },
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));

		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`hook ${path.basename(scriptPath)}:${stage} timed out after ${HOOK_TIMEOUT_MS}ms`));
		}, HOOK_TIMEOUT_MS);

		child.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});

		child.on("exit", (code) => {
			clearTimeout(timeout);
			if (stderr.trim()) debugLog(`${path.basename(scriptPath)}:${stage} stderr: ${stderr.trim()}`);
			if (code !== 0) {
				reject(new Error(`hook ${path.basename(scriptPath)}:${stage} exited ${code}: ${stderr.trim()}`));
				return;
			}
			const merged: HookResult = {};
			for (const raw of stdout.split("\n")) {
				const line = raw.trim();
				if (!line) continue;
				let obj: any;
				try {
					obj = JSON.parse(line);
				} catch {
					debugLog(`${path.basename(scriptPath)}:${stage} non-json line: ${line}`);
					continue;
				}
				if (typeof obj !== "object" || obj === null) continue;
				if (typeof obj.log === "string") {
					debugLog(`${path.basename(scriptPath)}:${stage} log: ${obj.log}`);
					continue;
				}
				mergeResult(merged, obj);
			}
			resolve(merged);
		});

		const host = { name: "pi-evolve", version: 2, stages: ["discover", "mutate_request", "before_tool", "after_tool", "execute_tool", "before_stop", "observe_message", "format_notification", "heartbeat", "compacting", "recover"] };
		child.stdin.write(JSON.stringify({ hook: stage, host, prompts: loadPrompts(), ...ctx }));
		child.stdin.end();
	});
}

const ARRAY_KEYS = new Set(["system", "tools", "notifications", "actions", "modified", "notify"]);
const SCALAR_JOIN_KEYS = new Set(["continue", "prompt", "user", "message", "result"]);

function mergeResult(into: HookResult, add: HookResult): void {
	for (const [k, v] of Object.entries(add)) {
		if (ARRAY_KEYS.has(k) && Array.isArray(v)) {
			into[k] = (into[k] as any[] | undefined) ? [...(into[k] as any[]), ...v] : [...v];
		} else if (SCALAR_JOIN_KEYS.has(k) && typeof v === "string") {
			into[k] = into[k] ? `${into[k]}\n${v}` : v;
		} else {
			into[k] = v;
		}
	}
}

// ─── per-hook registration (from discover) ──────────────────────────────────

interface DiscoveredTool {
	name: string;
	description?: string;
	parameters?: Record<string, any>;
	permission?: { arg?: string | string[] };
}

interface RegisteredHook {
	scriptPath: string;
	scriptBase: string;        // bare filename
	name: string;              // tool prefix
	test?: string;             // test script under tests/
	tools: DiscoveredTool[];
}

const HOOKS: RegisteredHook[] = [];

async function discoverAll(): Promise<void> {
	for (const scriptBase of listHookScripts()) {
		const scriptPath = path.join(HOOKS_DIR, scriptBase);
		try {
			const r = await runHookScript(scriptPath, "discover", {});
			const name = (r.name as string) || scriptBase.replace(/\.[^.]+$/, "");
			const tools = (r.tools as DiscoveredTool[]) || [];
			HOOKS.push({ scriptPath, scriptBase, name, test: r.test as string | undefined, tools });
			debugLog(`discovered ${scriptBase} as "${name}" with ${tools.length} tools`);
		} catch (err) {
			debugLog(`discover failed for ${scriptBase}: ${(err as Error).message}`);
		}
	}
}

// run a stage across all hooks (alphabetical), merging results per spec.
// observational stages don't trigger recover.
async function runStageAll(stage: string, ctx: Record<string, any>): Promise<HookResult> {
	const merged: HookResult = {};
	for (const hook of HOOKS) {
		try {
			const r = await runHookScript(hook.scriptPath, stage, ctx);
			mergeResult(merged, r);
		} catch (err) {
			debugLog(`${hook.scriptBase}:${stage} failed: ${(err as Error).message}`);
			if (RECOVER_HOOKS.has(stage)) {
				try {
					const recover = await runHookScript(hook.scriptPath, "recover", {
						error: (err as Error).message,
						failed_hook: stage,
					});
					mergeResult(merged, recover);
				} catch (re) {
					debugLog(`${hook.scriptBase}:recover failed: ${(re as Error).message}`);
				}
			}
		}
	}
	return merged;
}

// ─── dynamic TypeBox schema construction ────────────────────────────────────

function buildParamsSchema(params: Record<string, any> | undefined): TSchema {
	if (!params || Object.keys(params).length === 0) {
		return Type.Object({});
	}
	const props: Record<string, TSchema> = {};
	for (const [key, raw] of Object.entries(params)) {
		const spec: any = typeof raw === "string" ? { type: "string", description: raw } : raw;
		const desc = spec.description as string | undefined;
		let schema: TSchema;
		if (Array.isArray(spec.enum) && spec.enum.length > 0) {
			schema = Type.Union(
				spec.enum.map((v: any) => Type.Literal(v)),
				{ description: desc },
			);
		} else {
			switch (spec.type) {
				case "number":
					schema = Type.Number({ description: desc });
					break;
				case "boolean":
					schema = Type.Boolean({ description: desc });
					break;
				case "object":
					schema = Type.Object({}, { description: desc, additionalProperties: true } as any);
					break;
				case "array":
					schema = Type.Array(Type.Any(), { description: desc });
					break;
				case "any":
					schema = Type.Any({ description: desc });
					break;
				case "string":
				default:
					schema = Type.String({ description: desc });
			}
		}
		props[key] = spec.optional ? Type.Optional(schema) : schema;
	}
	return Type.Object(props);
}

// ─── builtin tools ──────────────────────────────────────────────────────────

const PROMPT_FILE_NAMES = PROMPT_FILES.map((s) => `${s}.md`);

function ensureWithin(dir: string, name: string): string {
	const target = path.resolve(dir, name);
	if (!target.startsWith(path.resolve(dir) + path.sep) && target !== path.resolve(dir)) {
		throw new Error(`path ${name} escapes ${dir}`);
	}
	return target;
}

function applyOffsetLimit(content: string, offset?: number, limit?: number): string {
	if (offset == null && limit == null) return content;
	const lines = content.split("\n");
	const start = offset ?? 0;
	const end = limit != null ? start + limit : lines.length;
	return lines.slice(start, end).join("\n");
}

function findReplace(content: string, find: string, replace: string, replaceAll?: boolean): string {
	if (replaceAll) return content.split(find).join(replace);
	const idx = content.indexOf(find);
	if (idx < 0) throw new Error(`find string not present`);
	if (content.indexOf(find, idx + 1) >= 0) throw new Error(`find string is not unique; use replaceAll`);
	return content.slice(0, idx) + replace + content.slice(idx + find.length);
}

let lastHeartbeatAt: number | undefined;

function readState(): Record<string, any> {
	try {
		return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
	} catch {
		return {};
	}
}

function writeState(s: Record<string, any>): void {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function runHookValidation(hook: RegisteredHook, proposedContent: string): Promise<{ ok: boolean; output: string }> {
	if (!hook.test) return { ok: true, output: "no test configured" };
	const testPath = path.join(TESTS_DIR, hook.test);
	if (!fs.existsSync(testPath)) return { ok: false, output: `test not found: ${testPath}` };
	// write proposed content to a temp file alongside the hook and run the test against it
	const tmp = path.join(HOOKS_DIR, `.${hook.scriptBase}.proposed`);
	fs.writeFileSync(tmp, proposedContent, { mode: 0o755 });
	return new Promise((resolve) => {
		const child = spawn("python3", [testPath, tmp], { cwd: WORKSPACE });
		let out = "";
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (out += d.toString()));
		child.on("exit", (code) => {
			fs.unlinkSync(tmp);
			resolve({ ok: code === 0, output: out });
		});
		child.on("error", (err) => {
			try { fs.unlinkSync(tmp); } catch {}
			resolve({ ok: false, output: err.message });
		});
	});
}

function registerBuiltinTools(pi: ExtensionAPI, hook: RegisteredHook): void {
	const prefix = hook.name;
	const promptNameSchema: TSchema = Type.Union(PROMPT_FILE_NAMES.map((n) => Type.Literal(n)));

	regTool(pi, {
		name: `${prefix}_datetime`,
		label: `${prefix} datetime`,
		description: "current date and time. set timezone to an IANA name (default: UTC).",
		parameters: Type.Object({ timezone: Type.Optional(Type.String({ description: "IANA timezone, default UTC" })) }),
		async execute(_id: string, params: any) {
			const tz = params.timezone || "UTC";
			const s = new Date().toLocaleString("en-US", { timeZone: tz, hour12: false });
			return textResult(`${s} ${tz}`);
		},
	});

	regTool(pi, {
		name: `${prefix}_heartbeat_time`,
		label: `${prefix} heartbeat time`,
		description: "last heartbeat runtime in UTC, or 'never' if no heartbeat has run.",
		parameters: Type.Object({}),
		async execute() {
			return textResult(lastHeartbeatAt ? new Date(lastHeartbeatAt).toISOString() : "never");
		},
	});

	regTool(pi, {
		name: `${prefix}_prompt_list`,
		label: `${prefix} prompt list`,
		description: "list contract prompt files in prompts/.",
		parameters: Type.Object({}),
		async execute() {
			return textResult(PROMPT_FILE_NAMES.join("\n"));
		},
	});

	regTool(pi, {
		name: `${prefix}_prompt_read`,
		label: `${prefix} prompt read`,
		description: "read a contract prompt file.",
		parameters: Type.Object({
			name: promptNameSchema,
			offset: Type.Optional(Type.Number({ description: "0-indexed line offset" })),
			limit: Type.Optional(Type.Number({ description: "max lines to return" })),
		}),
		async execute(_id: string, params: any) {
			const target = ensureWithin(PROMPTS_DIR, params.name);
			return textResult(applyOffsetLimit(readFileOrEmpty(target), params.offset, params.limit));
		},
	});

	regTool(pi, {
		name: `${prefix}_prompt_write`,
		label: `${prefix} prompt write`,
		description: "overwrite an existing contract prompt file. cannot create new files.",
		parameters: Type.Object({
			name: promptNameSchema,
			content: Type.String({ description: "full new file contents" }),
		}),
		async execute(_id: string, params: any) {
			const target = ensureWithin(PROMPTS_DIR, params.name);
			if (!fs.existsSync(target)) return textResult(`error: ${params.name} does not exist`);
			fs.writeFileSync(target, params.content);
			return textResult(`wrote ${params.name}`);
		},
	});

	regTool(pi, {
		name: `${prefix}_prompt_edit`,
		label: `${prefix} prompt edit`,
		description: "find-and-replace inside a contract prompt file.",
		parameters: Type.Object({
			name: promptNameSchema,
			find: Type.String({ description: "exact text to find (must be unique unless replaceAll)" }),
			replace: Type.String({ description: "replacement text" }),
			replaceAll: Type.Optional(Type.Boolean({ description: "replace every occurrence" })),
		}),
		async execute(_id: string, params: any) {
			const target = ensureWithin(PROMPTS_DIR, params.name);
			const cur = readFileOrEmpty(target);
			try {
				fs.writeFileSync(target, findReplace(cur, params.find, params.replace, params.replaceAll));
				return textResult(`edited ${params.name}`);
			} catch (e) {
				return textResult(`error: ${(e as Error).message}`);
			}
		},
	});

	regTool(pi, {
		name: `${prefix}_hook_list`,
		label: `${prefix} hook list`,
		description: "list executable hook files in hooks/.",
		parameters: Type.Object({}),
		async execute() {
			return textResult(listHookScripts().join("\n"));
		},
	});

	regTool(pi, {
		name: `${prefix}_hook_read`,
		label: `${prefix} hook read`,
		description: "read an existing hook file.",
		parameters: Type.Object({
			name: Type.String({ description: "hook filename relative to hooks/" }),
			offset: Type.Optional(Type.Number({ description: "0-indexed line offset" })),
			limit: Type.Optional(Type.Number({ description: "max lines to return" })),
		}),
		async execute(_id: string, params: any) {
			const target = ensureWithin(HOOKS_DIR, params.name);
			return textResult(applyOffsetLimit(readFileOrEmpty(target), params.offset, params.limit));
		},
	});

	regTool(pi, {
		name: `${prefix}_hook_write`,
		label: `${prefix} hook write`,
		description: "overwrite an existing hook. validated against test if configured. cannot create new files.",
		parameters: Type.Object({
			name: Type.String({ description: "hook filename relative to hooks/" }),
			content: Type.String({ description: "full new file contents" }),
		}),
		async execute(_id: string, params: any) {
			const target = ensureWithin(HOOKS_DIR, params.name);
			if (!fs.existsSync(target)) return textResult(`error: ${params.name} does not exist`);
			const targetHook = HOOKS.find((h) => h.scriptBase === params.name);
			if (targetHook?.test) {
				const v = await runHookValidation(targetHook, params.content);
				if (!v.ok) return textResult(`validation failed:\n${v.output}`);
			}
			fs.writeFileSync(target, params.content, { mode: fs.statSync(target).mode });
			return textResult(`wrote ${params.name}`);
		},
	});

	regTool(pi, {
		name: `${prefix}_hook_edit`,
		label: `${prefix} hook edit`,
		description: "find-and-replace inside an existing hook. validated against test if configured.",
		parameters: Type.Object({
			name: Type.String({ description: "hook filename relative to hooks/" }),
			find: Type.String({ description: "exact text to find (must be unique unless replaceAll)" }),
			replace: Type.String({ description: "replacement text" }),
			replaceAll: Type.Optional(Type.Boolean({ description: "replace every occurrence" })),
		}),
		async execute(_id: string, params: any) {
			const target = ensureWithin(HOOKS_DIR, params.name);
			const cur = readFileOrEmpty(target);
			let next: string;
			try {
				next = findReplace(cur, params.find, params.replace, params.replaceAll);
			} catch (e) {
				return textResult(`error: ${(e as Error).message}`);
			}
			const targetHook = HOOKS.find((h) => h.scriptBase === params.name);
			if (targetHook?.test) {
				const v = await runHookValidation(targetHook, next);
				if (!v.ok) return textResult(`validation failed:\n${v.output}`);
			}
			fs.writeFileSync(target, next, { mode: fs.statSync(target).mode });
			return textResult(`edited ${params.name}`);
		},
	});

	regTool(pi, {
		name: `${prefix}_hook_validate`,
		label: `${prefix} hook validate`,
		description: "validate proposed hook content against the registered test without installing.",
		parameters: Type.Object({
			name: Type.String({ description: "hook filename relative to hooks/" }),
			content: Type.String({ description: "proposed file contents to validate" }),
		}),
		async execute(_id: string, params: any) {
			const targetHook = HOOKS.find((h) => h.scriptBase === params.name);
			if (!targetHook) return textResult(`unknown hook: ${params.name}`);
			if (!targetHook.test) return textResult("no test configured");
			const v = await runHookValidation(targetHook, params.content);
			return textResult(v.output);
		},
	});
}

// ─── hook-declared tools ────────────────────────────────────────────────────

function registerDiscoveredTools(pi: ExtensionAPI, hook: RegisteredHook): void {
	for (const tool of hook.tools) {
		const fullName = `${hook.name}_${tool.name}`;
		regTool(pi, {
			name: fullName,
			label: fullName,
			description: tool.description ?? "",
			parameters: buildParamsSchema(tool.parameters),
			async execute(_id: string, params: any) {
				try {
					const r = await runHookScript(hook.scriptPath, "execute_tool", { tool: tool.name, args: params });
					return textResult(typeof r.result === "string" ? r.result : JSON.stringify(r.result ?? ""));
				} catch (e) {
					return textResult(`error: ${(e as Error).message}`);
				}
			},
		});
	}
}

// ─── action handling ────────────────────────────────────────────────────────

async function applyActions(pi: ExtensionAPI, actions: any[] | undefined): Promise<void> {
	if (!actions || !Array.isArray(actions)) return;
	for (const action of actions) {
		if (!action || typeof action !== "object") continue;
		switch (action.type) {
			case "send":
				if (typeof action.message === "string") {
					try {
						pi.sendUserMessage(action.message);
					} catch (e) {
						debugLog(`action send failed: ${(e as Error).message}`);
					}
				}
				break;
			case "create_session":
				// pi only exposes newSession() on command contexts; defer until commands wired
				debugLog(`action create_session deferred (not supported outside command context)`);
				break;
			default:
				debugLog(`unknown action type: ${action.type}`);
		}
	}
}

// ─── conversation history serialization ─────────────────────────────────────

function getHistory(ctx: ExtensionContext): any[] {
	try {
		const branch = (ctx.sessionManager as any).getBranch?.() ?? [];
		return branch
			.filter((e: any) => e?.type === "message")
			.map((e: any) => ({ role: e.message?.role, content: e.message?.content, timestamp: e.message?.timestamp }));
	} catch {
		return [];
	}
}

// ─── extension entrypoint ───────────────────────────────────────────────────

export default async function evolveExtension(pi: ExtensionAPI): Promise<void> {
	if (!fs.existsSync(HOOKS_DIR)) {
		debugLog(`no hooks directory at ${HOOKS_DIR}; extension will idle`);
		return;
	}

	await discoverAll();

	for (const hook of HOOKS) {
		registerBuiltinTools(pi, hook);
		registerDiscoveredTools(pi, hook);
	}

	// mutate_request → before_agent_start. surfaces finalized system /
	// user / model in the payload (parity with airun). user is the most
	// recent user message text from the agent's prepared messages, when
	// available; tools is deferred (pi's API doesn't expose the tool list
	// at this hook point).
	pi.on("before_agent_start", async (event: any) => {
		const msgs: any[] = Array.isArray(event?.messages) ? event.messages : [];
		const lastUser = [...msgs].reverse().find((m: any) => m?.role === "user");
		const userText = Array.isArray(lastUser?.content)
			? lastUser.content.filter((c: any) => c?.type === "text").map((c: any) => c.text || "").join("")
			: (typeof lastUser?.content === "string" ? lastUser.content : "");
		const r = await runStageAll("mutate_request", {
			session: { id: "current" },
			history: msgs,
			system: event?.systemPrompt || "",
			user: userText,
			model: typeof event?.model === "string" ? event.model : (event?.model?.id || ""),
		});
		await applyActions(pi, r.actions);
		if (Array.isArray(r.system) && r.system.length > 0) {
			const replaced = r.system.filter(Boolean).join("\n\n");
			if (replaced) {
				const skills = event?.systemPromptOptions?.skills;
				if (PRESERVE_SKILLS && Array.isArray(skills) && skills.length > 0) {
					return { systemPrompt: `${replaced}\n\n${formatSkillsForPrompt(skills)}` };
				}
				return { systemPrompt: replaced };
			}
		}
		return undefined;
	});

	// observe_message → message_end (observational)
	pi.on("message_end", async (event, _ctx) => {
		const msg: any = event.message;
		if (msg?.role !== "assistant") return;
		const calls = Array.isArray(msg.content)
			? msg.content.filter((c: any) => c.type === "toolCall" || c.type === "tool_call")
			: [];
		const answer = Array.isArray(msg.content)
			? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
			: "";
		const r = await runStageAll("observe_message", {
			session: { id: "current", agent: "evolve" },
			thinking: "",
			calls,
			answer,
		});
		await applyActions(pi, r.actions);
		await maybeFormatNotifications(pi, r.notify);
	});

	// idle → turn_end with no pending tool work. fire-and-forget so other
	// extensions' turn_end handlers (e.g. trigger-compact) don't sit behind
	// our subprocess await, which would let pi advance state and stale their
	// captured ctx.
	pi.on("turn_end", (event, ctx) => {
		const msg: any = event.message;
		const hasToolCall =
			Array.isArray(msg?.content) &&
			msg.content.some((c: any) => c.type === "toolCall" || c.type === "tool_call");
		if (hasToolCall) return;
		const answer = Array.isArray(msg?.content)
			? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
			: "";
		runStageAll("before_stop", { session: { id: "current", agent: "evolve" }, answer })
			.then(async (r) => {
				if (typeof r.continue === "string" && r.continue.trim() && ctx.isIdle()) {
					pi.sendUserMessage(r.continue);
				}
				await applyActions(pi, r.actions);
			})
			.catch((e) => debugLog(`before_stop hook failed: ${(e as Error).message}`));
	});

	// compacting → session_before_compact. when the hook returns a custom
	// `prompt`, run the summarization ourselves with that prompt as the
	// instructions, returning a pre-computed CompactionResult. pi treats this
	// as "extension already compacted" and stores our summary in place of
	// running its default compaction. modeled on
	// pi-coding-agent/examples/extensions/custom-compaction.ts.
	pi.on("session_before_compact", async (event: any, ctx) => {
		const r = await runStageAll("compacting", {
			session: { id: "current" },
			history: getHistory(ctx),
		});
		// prompt contract default: when hook returns no prompt, use compaction.md
		const fromHook = typeof r.prompt === "string" ? r.prompt.trim() : "";
		const fromContract = (loadPrompts().compaction || "").trim();
		const customPrompt = fromHook || fromContract;
		if (!customPrompt) return undefined; // pi default applies
		if (!ctx.model) {
			debugLog("compacting: no model available, falling back to default");
			return undefined;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) {
			debugLog("compacting: no api key, falling back to default");
			return undefined;
		}

		const prep = event.preparation;
		const messagesToSummarize = prep?.messagesToSummarize ?? [];
		const turnPrefix = prep?.turnPrefixMessages ?? [];
		const allMessages = [...messagesToSummarize, ...turnPrefix];
		const conversationText = serializeConversation(convertToLlm(allMessages));
		const previousContext = prep?.previousSummary
			? `\n\nPrevious session summary for context:\n${prep.previousSummary}`
			: "";

		try {
			const response = await complete(
				ctx.model,
				{
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: `${customPrompt}${previousContext}\n\n<conversation>\n${conversationText}\n</conversation>`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers, signal: event.signal },
			);
			const summary = response.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
			if (!summary.trim()) {
				debugLog("compacting: empty summary, falling back to default");
				return undefined;
			}
			return {
				compaction: {
					summary,
					firstKeptEntryId: prep.firstKeptEntryId,
					tokensBefore: prep.tokensBefore,
				},
			};
		} catch (e) {
			debugLog(`compacting custom path failed: ${(e as Error).message}`);
			return undefined;
		}
	});

	// before_tool — honor `deny` by translating to pi's {block, reason}.
	// hook-returned `result` (synthetic substitute without execution) is
	// not supported on pi without a custom-tool path; we log and ignore it.
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		const r = await runStageAll("before_tool", {
			session: { id: "current" },
			tool: (event as any).toolName ?? "unknown",
			callID: event.toolCallId,
			args: (event as any).args ?? {},
		}).catch(() => ({} as any));
		if (typeof r?.deny === "string" && r.deny) {
			return { block: true, reason: r.deny };
		}
		if (typeof r?.result === "string" && r.result) {
			debugLog("before_tool: synthetic `result` substitution not supported on pi; ignoring");
		}
		return undefined;
	});

	// after_tool — honor `result` by translating to pi's
	// {content: [{type: "text", text}]} replacement.
	pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
		const r = await runStageAll("after_tool", {
			session: { id: "current" },
			tool: (event as any).toolName ?? "unknown",
			callID: event.toolCallId,
			title: "",
			output: typeof (event as any).result === "string" ? (event as any).result : JSON.stringify((event as any).result ?? ""),
		}).catch(() => ({} as any));
		if (typeof r?.result === "string" && r.result) {
			return { content: [{ type: "text", text: r.result }] };
		}
		return undefined;
	});

	// heartbeat — timer-driven autonomous prompts. registered per-session via
	// session_start so we capture an ExtensionContext (for ctx.model and
	// ctx.modelRegistry); timer is .unref()'d so it doesn't block process exit.
	// EVOLVE_HEARTBEAT_MS < 0 disables the heartbeat (matches opencode-evolve
	// convention).
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	if (HEARTBEAT_INTERVAL_MS >= 0) {
		pi.on("session_start", (_event, ctx) => {
			if (heartbeatTimer || HOOKS.length === 0) return;
			heartbeatTimer = setInterval(() => fireHeartbeat(pi, ctx), HEARTBEAT_INTERVAL_MS);
			heartbeatTimer.unref();
		});
		pi.on("session_shutdown", () => {
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
				heartbeatTimer = undefined;
			}
		});
	}

	debugLog(`pi-evolve loaded: ${HOOKS.length} hooks, workspace=${WORKSPACE}`);
}

// ─── notifications ──────────────────────────────────────────────────────────

// ─── heartbeat ──────────────────────────────────────────────────────────────

async function fireHeartbeat(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	try {
		const r = await runStageAll("heartbeat", { sessions: [], history: [] });
		lastHeartbeatAt = Date.now();
		writeState({ ...readState(), last_heartbeat_at: lastHeartbeatAt });
		const user = typeof r.user === "string" ? r.user.trim() : "";
		const sys = Array.isArray(r.system) ? (r.system as string[]) : [];
		if (user) {
			if (ctx.model && sys.length > 0) {
				// proper architectural fit: spawn a fresh in-process agent loop
				// with the heartbeat-stage system prompt. modeled on
				// tintinweb/pi-schedule-prompt's `runSubagentOnce`.
				try {
					await runHeartbeatSubagent(ctx, sys, user);
				} catch (e) {
					debugLog(`heartbeat subagent failed: ${(e as Error).message}`);
					pi.sendUserMessage(`[heartbeat] ${user}`, { deliverAs: "followUp" });
				}
			} else {
				// fallback when no model is configured — queue as a follow-up
				// turn in the current session. system prompt is unchanged.
				pi.sendUserMessage(`[heartbeat] ${user}`, { deliverAs: "followUp" });
			}
		}
		await applyActions(pi, r.actions);
	} catch (e) {
		debugLog(`heartbeat failed: ${(e as Error).message}`);
	}
}

async function runHeartbeatSubagent(ctx: ExtensionContext, system: string[], user: string): Promise<void> {
	const agentDir = getAgentDir();
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir,
		// critical: prevent the subagent from re-loading this extension and
		// starting a recursive heartbeat timer.
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: system.join("\n\n"),
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		agentDir,
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		sessionManager: SessionManager.inMemory(ctx.cwd),
		settingsManager: SettingsManager.create(ctx.cwd, agentDir),
		resourceLoader: loader,
	});
	await session.prompt(`[heartbeat] ${user}`);
}

async function maybeFormatNotifications(pi: ExtensionAPI, notifs: any[] | undefined): Promise<void> {
	if (!notifs || notifs.length === 0) return;
	const r = await runStageAll("format_notification", { session: { id: "current" }, notifications: notifs });
	if (typeof r.message === "string" && r.message.trim()) {
		try {
			pi.sendMessage({ customType: "evolve-notification", content: r.message, display: true } as any);
		} catch (e) {
			debugLog(`sendMessage failed: ${(e as Error).message}`);
		}
	}
}
