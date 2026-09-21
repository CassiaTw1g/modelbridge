import "dotenv/config";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.ts";
import { STATE_DIR, createRegistry } from "./agent/jobs.ts";
import { AUTO_APPROVE_FLAG, auditEvent } from "./agent/approvals.ts";
import { createClaudeCodeRunner } from "./harness/claude-code.ts";
import { FLASH_HARD_WALL_MS, FLASH_MAX_CONCURRENT, flashRunner } from "./harness/flash.ts";
import { createPolicy, parseRoots } from "./sandbox.ts";

const PORT = Number(process.env.PORT ?? 8787);
// Loopback only. The tunnel runs on this machine, so nothing outside it has any
// business reaching the port — binding 0.0.0.0 would put the endpoint on the LAN.
const HOST = process.env.HOST ?? "127.0.0.1";
const PATH_SECRET = process.env.MCP_PATH_SECRET ?? "";
/**
 * One bucket, and it counts only `tools/call`.
 *
 * Two things were wrong with the old shape. `trust proxy: true` took `req.ip`
 * from `X-Forwarded-For`, which the caller writes — so the per-IP limit was a
 * per-made-up-IP limit, and rotating a header defeated it. With that gone, the
 * tunnel being on loopback means every caller shares one bucket, i.e. the limit
 * is now a plain global cap on what a leaked URL can spend.
 *
 * The second half is the count. Stateless mode re-runs initialize / tools/list
 * per request on some clients, so a single poll could cost three hits and a
 * long job's own polling was what tripped the 429. Those requests are cheap and
 * change nothing; `tools/call` is where the money and the file writes are.
 */
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 60);
const RATE_LIMIT_WINDOW_MS = 60_000;

if (PATH_SECRET.length < 16) {
  console.error(
    "MCP_PATH_SECRET 未设置或过短(至少 16 字符)。\n" +
      "生成方式:`npm run ctl -- secret`,写进 .env。详见 README。",
  );
  process.exit(1);
}

const MCP_PATH = `/mcp/${PATH_SECRET}`;

// ---------------------------------------------------------------------------
// Unattended mode does not survive a restart
// ---------------------------------------------------------------------------
//
// `npm run auto:on` writes a file rather than editing `.env`, which is what
// makes it take effect on the next job without a restart — but nothing else
// would ever turn it back off, so an operator who flipped it on for one batch
// and walked away would leave the machine open indefinitely.
//
// The clearing lives *here*, not in `ctl`: `ctl` is one way to start this
// process and `node src/server.ts` is another, and a safety default that the
// second path skips is not a default. Every boot — reload, restart, reboot —
// lands back in "needs approval".
const autoApproveFlagFile = join(STATE_DIR, AUTO_APPROVE_FLAG);
if (existsSync(autoApproveFlagFile)) {
  rmSync(autoApproveFlagFile, { force: true });
  auditEvent(STATE_DIR, { type: "auto_approve_cleared", reason: "服务启动,自动收回完全放行。" });
  console.log("检测到「完全放行」标志 —— 已清除,本次启动恢复为需要批准。");
}

// The env var outranks the file, so clearing the file above would be theatre if
// someone had also set this by hand. Say so loudly instead of letting them
// believe the restart protected them.
if (process.env.BRIDGE_CC_APPROVAL === "off") {
  console.warn(
    "⚠️  BRIDGE_CC_APPROVAL=off 仍在 .env 里 —— 完全放行依然生效,\n" +
      "    上面那次「自动收回」对它无效。要真正恢复审批,请从 .env 删掉这一行并重启。",
  );
}

const hits = new Map<string, number[]>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);

  if (hits.size > 1000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < RATE_LIMIT_WINDOW_MS)) hits.delete(k);
    }
  }
  return recent.length > RATE_LIMIT_MAX;
}

// ---------------------------------------------------------------------------
// Agent jobs
// ---------------------------------------------------------------------------

// Fail closed: with no roots configured, every workspace is denied. An agent
// tool that silently defaults to "anywhere on disk" is worse than one that
// refuses to run until someone names the directories they meant.
const allowedRoots = parseRoots(process.env.DEEPSEEK_ALLOWED_ROOTS);
const policy = createPolicy(allowedRoots);

if (allowedRoots.length === 0) {
  console.warn(
    "DEEPSEEK_ALLOWED_ROOTS 未设置 —— agent 工具会拒绝所有工作区。\n" +
      "要启用,请在 .env 里列出允许子代理操作的根目录(多个用 ; 分隔)并重启。",
  );
} else {
  console.log(`允许的工作区根目录:${allowedRoots.join(", ")}`);
}

/**
 * One registry for the whole process — deliberately created out here, not
 * inside the request handler. `createMcpServer()` runs once per request in
 * stateless mode, so a registry built there would forget every job the instant
 * its `start` call returned.
 */
const stepLimit = Number(process.env.BRIDGE_MAX_STEPS ?? 120);
const jobTimeoutMs = Number(process.env.BRIDGE_JOB_TIMEOUT_MS ?? 30 * 60_000);

const registry = createRegistry(
  createClaudeCodeRunner({
    maxSteps: stepLimit,
    timeoutMs: jobTimeoutMs,
  }),
  {
    harnessName: "claude-code",
    // The registry's own wall clock must stay *behind* the runner's timeout, or
    // it becomes the real ceiling — and it reports the loss as a plain
    // cancellation, which says nothing about why. It used to default
    // independently to 20 minutes, silently capping any job whose runner had
    // been given longer than that.
    hardWallMs: jobTimeoutMs + 60_000,
  },
);

/**
 * A second registry for `deepseek_flash`, and it has to be separate.
 *
 * Sharing one would share one concurrency ceiling: a sub-agent job occupies a
 * slot for up to half an hour, so two running agents would leave a flash call —
 * a single HTTP request that is finished in seconds — refused outright. The
 * ceilings are as different as the work is, and so are the runners: this one
 * holds the direct model call, whose only job is to survive longer than the
 * caller's tool-call window without the work being lost.
 */
const flashRegistry = createRegistry(flashRunner, {
  harnessName: "flash",
  maxConcurrent: FLASH_MAX_CONCURRENT,
  hardWallMs: FLASH_HARD_WALL_MS,
});

const app = express();
// No `trust proxy`: this listener is bound to loopback and the only thing that
// ever connects is the tunnel, so an X-Forwarded-For header carries no
// information a caller cannot invent. Trusting it turned the rate limit into
// "20 requests per made-up IP".
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post(MCP_PATH, async (req, res) => {
  const method = req.body?.method ?? "?";

  if (method === "tools/call" && isRateLimited(req.ip ?? "unknown")) {
    console.log(`[${new Date().toISOString()}] RATE LIMITED`);
    res.status(429).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Rate limit exceeded. Try again shortly." },
      id: null,
    });
    return;
  }

  // One line per request. This is how you tell "ChatGPT actually called us"
  // apart from "Sol pretended to call us", which looks identical in the chat.
  const toolName = req.body?.params?.name;
  console.log(`[${new Date().toISOString()}] ${method}${toolName ? ` ${toolName}` : ""}`);

  // Stateless: a fresh server+transport per request. Sharing them across
  // requests leaks state between callers. The registry is passed in precisely
  // because it must NOT be per-request.
  const server = createMcpServer(registry, policy, flashRegistry);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  // Closing the transport aborts the SDK's per-request handler signal, which
  // the client triggers simply by hanging up — routine when a 45-second
  // synchronous window exceeds ChatGPT's own tool timeout. That signal is used
  // only to stop waiting; it is never wired to a job's controller, or every
  // impatient caller would kill its own job.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error." },
        id: null,
      });
    }
  }
});

// Stateless mode has no session to stream or terminate.
const methodNotAllowed = (req: express.Request, res: express.Response) => {
  void req;
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};
app.get(MCP_PATH, methodNotAllowed);
app.delete(MCP_PATH, methodNotAllowed);

// Anything else under /mcp: the capability path is the credential, so a wrong
// path must be indistinguishable from nothing being here.
app.use("/mcp", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`modelbridge listening on http://${HOST}:${PORT}`);
  // Never the whole path. `ctl` pipes this stdout into `.state/server.log`, and
  // `ctl logs` prints the tail of that file — a channel that has leaked once
  // already, and one whose output ends up pasted into troubleshooting threads.
  // The operator who needs the real value has `ctl status --show`, which reads
  // it from `.env` and prints it nowhere else.
  console.log("MCP endpoint path: /mcp/<密钥已隐藏>(完整值:npm run ctl -- status --show)");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`Received ${signal}, shutting down.`);
    // Abort in-flight jobs first: each one owns a spawned Claude Code process
    // and possibly a tree of grandchildren under it — and each flash job owns a
    // paid request that nobody will be left to read.
    registry.shutdown();
    flashRegistry.shutdown();
    httpServer.close(() => process.exit(0));
  });
}
