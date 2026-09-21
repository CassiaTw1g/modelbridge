import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { STATE_DIR, type JobContext, type JobInput, type JobResult, type JobRunner } from "../agent/jobs.ts";
import { DEFAULT_ALLOW, autoApproveOn, listPending } from "../agent/approvals.ts";

/**
 * Runs a task by spawning Claude Code in headless mode, pointed at DeepSeek.
 *
 * Claude Code is the harness — it owns the loop, the tools, context compaction
 * and prompt caching. This module only starts it, watches it, and reports what
 * it did. None of the file/shell safety logic lives here; Claude Code's own
 * permission system is the control, which is why the allowlist below matters.
 */

/**
 * `PowerShell` is the command tool on Windows, `Bash` elsewhere. Naming both is
 * deliberate: a probe run that listed only `Bash` had every single command
 * denied, and the model burned four attempts discovering that. Listing a tool
 * that does not exist on this platform is harmless.
 */
const DEFAULT_ALLOWED = "Read Write Edit Glob Grep Bash PowerShell";

/**
 * The same list minus the command tools. Approval and pre-approval are not
 * compatible for the *same* tool, and — measured — `--allowedTools` does not
 * restrict anything anyway: passing only "Read" still let PowerShell run. Its
 * only real effect is pre-approval, which is exactly what must not happen to
 * the command tool once a human is supposed to be in the loop.
 */
const APPROVAL_ALLOWED = "Read Write Edit Glob Grep";

/**
 * Every tool the approval MCP is supposed to arbitrate.
 *
 * `ask` is the only lever that makes `--permission-prompt-tool` fire at all
 * (see `prepareApprovalFiles`), and the file tools now belong in it. They used
 * to be pre-approved here and waved through by the MCP on the theory that
 * `--add-dir` bounded them; `--add-dir` adds a directory and restricts
 * nothing, so a job could read any path this account can read, silently. With
 * them listed, each call is put to `approval-mcp.ts`, which allows anything
 * inside the workspace without waking anybody and sends everything else to the
 * human queue.
 *
 * `MultiEdit`/`NotebookEdit` are named even though the job may never call them:
 * an unlisted tool is not denied, it is simply not asked about, and that is the
 * failure mode being closed here.
 */
const ASK_TOOLS = [
  "PowerShell",
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
];

/** Namespace Claude Code assigns to an MCP server called `bridge`. */
const APPROVAL_TOOL = "mcp__bridge__approval_prompt";

/**
 * Appended to Claude Code's own system prompt for every job.
 *
 * Measured, three validation runs in a row: asked to reverse a file's contents,
 * the sub-agent writes one multi-statement PowerShell line. Every such line
 * carries a `;` or a `|`, and the approval gate routes those to a human by
 * design — so each run stopped for a click that had nothing to do with what the
 * command actually did.
 *
 * `node` is pre-approved and `node reverse.mjs` contains none of the characters
 * the chaining guard looks for, so the identical work runs unattended. This is
 * a nudge, not enforcement: the gate is untouched, so a run that ignores it
 * still pauses for a human rather than failing.
 *
 * An earlier draft of this prompt told the model to avoid `node .\script.mjs`
 * because it "would be refused as a full path". That is not true, and the test
 * suite said so: the allowlist reads the *first word* only, so every spelling
 * of `node <anything>` is approved and only `.\node x.mjs` is refused. The
 * prompt now claims nothing about paths.
 */
const EXTRA_SYSTEM_PROMPT = [
  "在本机做计算或文本处理时,优先「写一个脚本文件,再用 node 运行」,不要写多语句的 PowerShell 一行流:",
  "  1. 用 Write 工具在当前工作目录里写一个小脚本(例如 reverse.mjs)",
  "  2. 运行:node reverse.mjs",
  "原因:含 ; 或 | 的 PowerShell / Bash 命令会被暂停、等人工批准,会拖慢任务;而 node <脚本名> 是直接放行的。",
  "读取单个文件、列目录这类简单操作,直接用 Get-Content / Get-ChildItem / ls 等**单个**只读命令即可。",
  "**这条对 Bash 和 PowerShell 一样成立,别以为换个工具就绕过去了**:",
  "  - 不要写 `find ... | head -100`、`ls -la; pwd`、`a && b`、`x > out.txt` 这类串联 —— 它们一律转人工,",
  "    任务会停在「等待批准」,直到有人到电脑上点确认,超时就直接拒绝。",
  "  - 要截断或过滤输出,就在 node 脚本里做(`.slice()`、`.filter()`),不要把管道写进命令行。",
  "",
  "任务有工具调用次数上限,超了会被强制中止。请省着用:",
  "  - 先用 Glob / Grep 定位,再 Read;读大文件用 offset/limit 只取需要的段落,不要整篇读。",
  "  - 要看好几个文件时,在同一轮里并行发起多个 Read,不要一个文件一轮。",
  "审查、分析、调研这类任务:**边看边把已经确认的结论追加写进工作区里的报告文件**(例如 报告.md),不要等全部看完再一次性写。",
  "  这样即使任务中途被上限中止,已经查实的内容也留在磁盘上,不会白跑。",
].join("\n");

export interface ClaudeCodeOptions {
  bin?: string;
  allowedTools?: string;
  permissionMode?: string;
  /** MCP tool that answers permission prompts — see `--permission-prompt-tool`. */
  permissionPromptTool?: string;
  /** Route unlisted commands to the human approval queue. Default on. */
  approval?: boolean;
  approvalAllow?: string[];
  approvalTimeoutMs?: number;
  /**
   * Instructions appended to Claude Code's own system prompt. Overrides
   * `BRIDGE_CC_EXTRA_PROMPT`; an empty string omits the flag altogether.
   */
  extraSystemPrompt?: string;
  /** Hard stop after this many tool calls, enforced by killing the child. */
  maxSteps?: number;
  timeoutMs?: number;
  /** Isolated config dir; keeps the child off the operator's personal account. */
  configDir?: string;
  stateDir?: string;
}

function resolveBin(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.BRIDGE_CLAUDE_BIN) return process.env.BRIDGE_CLAUDE_BIN;

  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = [join(home, ".local", "bin", exe), join(home, ".claude", "local", exe)];
  for (const c of candidates) if (home && existsSync(c)) return c;
  return exe;
}

/**
 * Point the child at DeepSeek and nowhere else.
 *
 * Two things are being prevented here. First, billing: the bridge must spend
 * its own dedicated DeepSeek key, never the operator's Anthropic account.
 * Second, inheritance — the operator's own `ANTHROPIC_*` variables, and their
 * `~/.claude/settings.json`, would otherwise silently redirect a job onto their
 * personal subscription.
 */
/**
 * Claude Code reads plugins, MCP servers and permission rules from
 * CLAUDE_CONFIG_DIR. These two files go in the bridge's own state directory
 * instead — `--settings` and `--mcp-config` take explicit paths — because
 * CLAUDE_CONFIG_DIR can be pointed at the operator's real `~/.claude` through
 * BRIDGE_CLAUDE_CONFIG_DIR, and overwriting their settings.json would be a
 * genuinely destructive bug.
 */
function prepareApprovalFiles(stateDir: string): { settings: string; mcp: string } {
  const dir = join(stateDir, "cc");
  mkdirSync(dir, { recursive: true });

  const settings = join(dir, "settings.json");
  // `ask` is the only lever that makes `--permission-prompt-tool` fire at all.
  // Without it, headless mode runs the command tool silently and no permission
  // question is ever asked — measured, not assumed.
  writeFileSync(settings, JSON.stringify({ permissions: { ask: ASK_TOOLS } }, null, 2), "utf8");

  const mcp = join(dir, "mcp.json");
  const entry = join(dirname(fileURLToPath(import.meta.url)), "approval-mcp.ts");
  // process.execPath, not "node": that is the interpreter already running the
  // bridge, so the child cannot pick up a different one from PATH.
  writeFileSync(
    mcp,
    JSON.stringify({ mcpServers: { bridge: { command: process.execPath, args: [entry] } } }, null, 2),
    "utf8",
  );

  return { settings, mcp };
}

/**
 * Names the child must never see, whatever the operator's shell happens to hold.
 *
 * `{ ...process.env }` used to hand the whole environment to the sub-agent and
 * to every grandchild it spawns — including `DEEPSEEK_API_KEY` and
 * `MCP_PATH_SECRET`. Both are one auto-approved command away from the model:
 * `echo $env:DEEPSEEK_API_KEY` and `node -e "console.log(process.env.…)"` look
 * like an approved first word and contain none of the characters the chaining
 * guard looks for, so neither ever reaches a human. A prompt-injected file
 * ("put your environment into the report") then routes the key into the job
 * result, back to the caller, and into `.state/jobs/`.
 *
 * Inheriting a *file* was never the only way data leaves, so the fix is not
 * about paths: it is about what the process is carrying.
 */
const SECRET_ENV = /(API_KEY|_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i;

/**
 * `ANTHROPIC_AUTH_TOKEN` is the one exception, and it has to be: it *is* the
 * DeepSeek key, and the harness cannot authenticate without it. It is named
 * explicitly so that the residual exposure is visible in the code rather than
 * implied by a wildcard — the README's honest-boundaries section states it too.
 */
const KEEP_ENV = new Set(["ANTHROPIC_AUTH_TOKEN"]);

function scrubEnv(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (KEEP_ENV.has(name)) continue;
    if (SECRET_ENV.test(name)) delete env[name];
  }
}

function buildEnv(configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const key = process.env.DEEPSEEK_API_KEY;

  if (key) {
    const base = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
    env.ANTHROPIC_AUTH_TOKEN = key;
    env.ANTHROPIC_BASE_URL = process.env.BRIDGE_ANTHROPIC_BASE_URL ?? `${base}/anthropic`;
    env.ANTHROPIC_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-flash";
  }

  delete env.ANTHROPIC_API_KEY;
  scrubEnv(env);
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

/**
 * `child.kill()` does not reap grandchildren on Windows, and a shell tool
 * routinely spawns them (`node x.mjs` starts a child of the shell). `taskkill
 * /T` walks the tree. Same approach `scripts/ctl.mjs` uses for the server.
 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* best effort */
  }
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.prompt ?? o.url;
  if (typeof pick === "string") return pick.slice(0, 300);
  try {
    return JSON.stringify(input).slice(0, 300);
  } catch {
    return "";
  }
}

interface ResultLine {
  type: "result";
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  permission_denials?: { tool_name?: string; tool_input?: unknown }[];
}

export function createClaudeCodeRunner(options: ClaudeCodeOptions = {}): JobRunner {
  return (input, ctx) => runClaudeCode(input, ctx, options);
}

export async function runClaudeCode(
  input: JobInput,
  ctx: JobContext,
  options: ClaudeCodeOptions = {},
): Promise<JobResult> {
  const workspace = input.workspace;
  // Two different failures, and only one of them is the caller's doing.
  //
  // A missing workspace means the registry this runner is wired to was handed a
  // job that is not an agent job — a flash job has no directory, because it
  // never touches the filesystem. That is a wiring mistake, and the fix belongs
  // at the wiring. It must certainly not be answered by falling back to
  // `process.cwd()`: the workspace is the boundary the approval layer enforces,
  // so inventing one would silently widen it to whatever directory the server
  // happened to be started in.
  if (!workspace) {
    throw new Error("子代理任务缺少工作区:agent runner 收到了一个没有 workspace 的任务(接线错误)。");
  }
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`工作区不存在或不是目录:${workspace}`);
  }

  const bin = resolveBin(options.bin);
  const maxSteps = options.maxSteps ?? 120;
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;

  const stateDir = options.stateDir ?? STATE_DIR;
  // Deliberately not `process.env.BRIDGE_CC_APPROVAL !== "off"` any more. That
  // value is frozen at boot by `dotenv/config`, so the only way to reach
  // unattended mode was to edit `.env` and restart — which is how a security
  // setting ends up toggled by hand-editing and then forgotten. `autoApproveOn`
  // re-reads the flag file per job, so `npm run auto:on` takes effect on the
  // *next* job with no restart, and the restart is what turns it back off.
  const approvalOn = options.approval ?? !autoApproveOn(stateDir);
  const approvalAllow = options.approvalAllow ?? DEFAULT_ALLOW;
  const approvalTimeoutMs =
    options.approvalTimeoutMs ?? Number(process.env.BRIDGE_APPROVAL_TIMEOUT_MS ?? 5 * 60_000);

  // Bridge-scoped, not job-scoped: config isolation is about keeping the child
  // off the operator's account, and putting it in the workspace would litter
  // every job's output directory with a config tree.
  const configDir = options.configDir ?? join(tmpdir(), "modelbridge-claude-config");
  const env = buildEnv(configDir);

  const args = [
    "-p",
    input.task,
    "--output-format",
    "stream-json",
    // Required by this CLI version whenever --print and stream-json are combined.
    "--verbose",
    "--add-dir",
    workspace,
    "--permission-mode",
    options.permissionMode ?? "acceptEdits",
  ];

  const extraPrompt = options.extraSystemPrompt ?? process.env.BRIDGE_CC_EXTRA_PROMPT ?? EXTRA_SYSTEM_PROMPT;
  if (extraPrompt) args.push("--append-system-prompt", extraPrompt);

  if (approvalOn) {
    const files = prepareApprovalFiles(stateDir);
    args.push(
      "--settings",
      files.settings,
      "--mcp-config",
      files.mcp,
      "--permission-prompt-tool",
      options.permissionPromptTool ?? APPROVAL_TOOL,
      "--allowedTools",
      options.allowedTools ?? APPROVAL_ALLOWED,
    );
    // The approval MCP server reads these from its own environment, which it
    // inherits through the Claude Code child. That is what lets a single shared
    // mcp.json serve every job instead of one file per job.
    env.BRIDGE_JOB_ID = ctx.jobId;
    env.BRIDGE_STATE_DIR = stateDir;
    env.BRIDGE_APPROVE_ALLOW = approvalAllow.join(",");
    env.BRIDGE_APPROVAL_TIMEOUT_MS = String(approvalTimeoutMs);
    // The boundary the file tools are checked against. Without it the approval
    // MCP has no way to tell "inside the job's workspace" from "anywhere on
    // disk", and it fails closed — which would stall every job on its first
    // edit rather than quietly allowing everything.
    env.BRIDGE_WORKSPACE = workspace;
  } else {
    args.push("--allowedTools", options.allowedTools ?? DEFAULT_ALLOWED);
    if (options.permissionPromptTool) args.push("--permission-prompt-tool", options.permissionPromptTool);
  }
  // Deliberately opt-in: Claude Code prices against Claude rates, so a budget
  // set here reads as ~100x the real DeepSeek cost and would cut jobs off early.
  const budget = process.env.BRIDGE_CC_MAX_BUDGET_USD;
  if (budget) args.push("--max-budget-usd", budget);

  const child = spawn(bin, args, {
    cwd: workspace,
    env,
    windowsHide: true, // otherwise a console window flashes on the operator's desktop
    // stdin must be ignored, not left open: with --print the CLI waits ~3s for
    // input before proceeding, on every single job.
    stdio: ["ignore", "pipe", "pipe"],
  });

  let toolCalls = 0;
  let final: ResultLine | undefined;
  let stderr = "";
  let killedFor: string | undefined;

  // Kept so an aborted run still yields something. A stop used to discard
  // everything the sub-agent had read and reasoned about: a review that hit the
  // ceiling at step 41 came back as a bare one-line error, leaving the caller
  // with nothing to narrow down or resume from — and no way to tell "it did
  // nothing" apart from "it did most of it and ran out of room".
  const notes: string[] = [];
  const toolTrace: string[] = [];

  /**
   * What to hand back when the run is stopped mid-flight. Deliberately loud that
   * this is NOT a result: the whole risk of salvaging partial work is that a
   * caller reads a half-finished survey as a finished one.
   */
  const partialReport = (reason: string): string => {
    const counts = new Map<string, number>();
    for (const name of toolTrace) counts.set(name, (counts.get(name) ?? 0) + 1);
    const summary = [...counts].map(([name, n]) => `${name}×${n}`).join("  ");
    const tail = notes.join("\n---\n").slice(-3000);
    return [
      `任务在完成前被中止:${reason}`,
      "",
      "下面只是它中止前已经做到的部分,**不是结论、也没有核查完整**,不能当作任务结果使用。",
      "",
      "【它最后说过的内容(可能半途而止)】",
      tail || "(它还没来得及输出任何文字)",
      "",
      "【已执行的工具调用】",
      summary || "(无)",
    ].join("\n");
  };

  const stop = (reason: string) => {
    if (killedFor) return;
    killedFor = reason;
    if (child.pid) killTree(child.pid);
  };

  const onAbort = () => stop("任务被取消。");
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop(`任务超过 ${Math.round(timeoutMs / 60_000)} 分钟上限,已中止。`), timeoutMs);
  timer.unref();

  // Two cross-process signals arrive by file, not in the child's output, so
  // both have to be polled: "a human is being asked" (approval queue), and
  // "stop" (`npm run ctl -- job kill`, which is a different process and cannot
  // reach this job's AbortController any other way). Neither is visible in the
  // stream — a job waiting on approval looks exactly like a job that went quiet.
  let pendingSeen = -1;
  const watch = setInterval(() => {
    if (ctx.checkCancelled()) {
      stop("任务被取消。");
      return;
    }
    if (!approvalOn) return;

    const pending = listPending(stateDir).filter((p) => p.jobId === ctx.jobId);
    if (pending.length === pendingSeen) return;
    pendingSeen = pending.length;
    ctx.setWaitingApproval(pending.length > 0);
    if (pending.length > 0) {
      ctx.record({
        step: toolCalls,
        type: "note",
        detail: `等待批准:${pending[0].command.slice(0, 200)}`,
      });
    }
  }, 500);
  watch.unref();

  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
  }

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // The CLI prints non-JSON warnings (e.g. unrecognized_model) on stdout.
        return;
      }

      if (obj.type === "assistant") {
        const blocks = (obj.message as { content?: unknown[] } | undefined)?.content;
        if (!Array.isArray(blocks)) return;
        for (const block of blocks) {
          const b = block as { type?: string; name?: string; input?: unknown; text?: string };
          if (b?.type === "tool_use") {
            toolCalls++;
            toolTrace.push(String(b.name ?? "?"));
            ctx.setSteps(toolCalls);
            ctx.record({
              step: toolCalls,
              type: "tool",
              name: String(b.name ?? "?"),
              detail: summarizeInput(b.input),
            });
            if (toolCalls > maxSteps) stop(`任务超过 ${maxSteps} 步上限,已中止。`);
          } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
            notes.push(b.text.trim());
            // Only the tail can be salvaged anyway; without a cap a chatty run
            // holds every paragraph it ever wrote.
            if (notes.length > 40) notes.shift();
            ctx.record({ step: toolCalls, type: "note", detail: b.text.slice(0, 300) });
          }
        }
        return;
      }

      if (obj.type === "result") final = obj as unknown as ResultLine;
    });
  }

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => {
    ctx.signal.removeEventListener("abort", onAbort);
    clearTimeout(timer);
    clearInterval(watch);
  });

  const usage = final?.usage;
  const usageOut = usage
    ? {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      }
    : undefined;

  if (usage?.cache_read_input_tokens) {
    ctx.record({ step: toolCalls, type: "note", detail: `缓存命中 ${usage.cache_read_input_tokens} 输入 token` });
  }

  // Returned, not thrown: a deliberate stop still has salvageable work in it,
  // and `incomplete` is what keeps the caller from mistaking it for an answer.
  if (killedFor) {
    return { text: partialReport(killedFor), steps: toolCalls, incomplete: killedFor };
  }

  if (!final) {
    const tail = stderr.trim().slice(0, 400);
    const last = notes.at(-1);
    throw new Error(
      `Claude Code 没有返回结果(退出码 ${exitCode})。${tail ? `stderr: ${tail}` : "无 stderr 输出。"}` +
        (last ? `\n\n(它中断前最后说过的内容,未完成:)\n${last.slice(0, 800)}` : ""),
    );
  }

  const denials = Array.isArray(final.permission_denials) ? final.permission_denials : [];
  for (const d of denials) {
    ctx.record({
      step: toolCalls,
      type: "error",
      name: String(d.tool_name ?? "?"),
      detail: `权限被拒: ${summarizeInput(d.tool_input)}`,
    });
  }

  const text = typeof final.result === "string" ? final.result : "";
  if (final.is_error) {
    throw new Error(`Claude Code 报告任务失败:${text.slice(0, 300) || "(无说明)"}`);
  }
  if (!text.trim()) {
    throw new Error("Claude Code 结束但没有产出内容。");
  }

  return {
    // Surface denials to the caller: a run that "succeeded" after being blocked
    // from the tools it needed is a different thing from one that really did
    // the work, and the calling model should not have to guess which it got.
    text: denials.length ? `${text}\n\n[注意:有 ${denials.length} 次工具调用被权限拒绝,结果可能不完整。]` : text,
    steps: toolCalls,
    usage: usageOut,
  };
}
