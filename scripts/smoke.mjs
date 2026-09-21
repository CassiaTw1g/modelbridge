#!/usr/bin/env node
/**
 * Verifies the *public* endpoint — the exact URL the ChatGPT connector points
 * at — end to end, including a real DeepSeek call.
 *
 * Uses Node's fetch rather than curl on purpose: on Windows, curl run through
 * git-bash mangles non-ASCII request bodies into GBK, which makes DeepSeek
 * reason about mojibake instead of doing the task.
 *
 * Run: npm run smoke            (picks the URL up from the running tunnel)
 *      npm run smoke -- https://xxxx.trycloudflare.com
 *      npm run smoke -- https://mcp.example.com     (named tunnel)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readEnv() {
  const out = {};
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Where the connector should be pointing.
 *
 * A named tunnel's hostname is configured, not discovered — cloudflared never
 * prints a `*.trycloudflare.com` line for one, so scraping the log (which is the
 * only way to learn a quick tunnel's address) would return null forever and this
 * script would report "no address" against a perfectly good named tunnel.
 * `TUNNEL_HOSTNAME` wins when set, for the same reason it wins in `ctl`.
 */
function tunnelUrl() {
  if ((env.TUNNEL_MODE ?? "").trim().toLowerCase() === "named") {
    const host = (env.TUNNEL_HOSTNAME ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    if (host) return `https://${host}`;
  }
  const file = join(ROOT, ".state", "tunnel.log");
  if (!existsSync(file)) return null;
  const body = readFileSync(file, "utf8");
  const section = body.slice(body.lastIndexOf("--- tunnel "));
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(section);
  return m ? m[0] : null;
}

const env = { ...readEnv(), ...process.env };
const SECRET = env.MCP_PATH_SECRET ?? "";
const BASE = (process.argv[2] ?? tunnelUrl())?.replace(/\/+$/, "");

if (!BASE) {
  console.error(
    "没有可用地址。先运行 `npm run tunnel`,或显式传入:\n" +
      "  npm run smoke -- https://xxxx.trycloudflare.com",
  );
  process.exit(1);
}

const ENDPOINT = `${BASE}/mcp/${SECRET}`;
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** The transport replies as SSE, so unwrap the `data:` line. */
function parseBody(text) {
  const line = text.split(/\r?\n/).find((l) => l.startsWith("data:"));
  const json = line ? line.slice(5).trim() : text.trim();
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function rpc(payload) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(payload),
  });
  return parseBody(await res.text());
}

// Masked by default, same rule as `ctl`: this output gets pasted into chat and
// issue threads, and the secret in it is the whole credential. `--show` when
// you actually need to read it.
const mask = (text) =>
  process.argv.includes("--show")
    ? String(text)
    : String(text).replace(/\/mcp\/[0-9a-fA-F]{8,}/g, "/mcp/<密钥已隐藏,加 --show 查看>");

console.log(`目标: ${mask(ENDPOINT)}\n`);

/**
 * The first request through a tunnel that has just come up, or that has been
 * idle for a while, can fail while Cloudflare re-establishes the edge path —
 * every request after it succeeds. Measured 2026-09-21: this check came back
 * empty against a healthy tunnel, and six immediate requests to the same URL
 * all returned `{"ok":true}`. One retry, so the self-check does not show a red
 * FAIL that means nothing.
 *
 * This check runs first, so it is the request that absorbs the cold start; the
 * five checks below it are unaffected either way.
 */
async function healthOnce() {
  try {
    const res = await fetch(`${BASE}/health`);
    return await res.json();
  } catch {
    return null;
  }
}

let health = await healthOnce();
if (health?.ok !== true) {
  await new Promise((r) => setTimeout(r, 1500));
  health = await healthOnce();
}
// `JSON.stringify(null)` is the string "null", which is truthy — testing the
// value rather than the string is what makes the 无响应 branch reachable.
check("健康检查 /health 可达", health?.ok === true, health ? JSON.stringify(health) : "无响应");

const bare = await fetch(`${BASE}/mcp`, { method: "POST", headers: HEADERS, body: "{}" });
check("裸 /mcp 返回 404(端点未暴露)", bare.status === 404, `实际 ${bare.status}`);

const wrong = await fetch(`${BASE}/mcp/${"x".repeat(64)}`, {
  method: "POST",
  headers: HEADERS,
  body: "{}",
});
check("错误 secret 返回 404", wrong.status === 404, `实际 ${wrong.status}`);

const init = await rpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  },
});
check(
  "initialize 成功",
  init?.result?.serverInfo?.name === "modelbridge",
  JSON.stringify(init?.result?.serverInfo ?? init),
);

const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const names = (tools?.result?.tools ?? []).map((t) => t.name);
check("tools/list 包含 deepseek_flash", names.includes("deepseek_flash"), names.join(",") || "无");

const called = await rpc({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "deepseek_flash",
    arguments: { task: "只回复两个字:通了", mode: "analyze" },
  },
});
const text = called?.result?.content?.[0]?.text ?? "";
if (called?.result?.isError === true) {
  check("tools/call 打到真实 DeepSeek", false, text.slice(0, 200));
} else {
  // Checking for the literal answer catches the empty-content failure mode,
  // which would otherwise come back looking like a successful call.
  check(
    "tools/call 打到真实 DeepSeek",
    text.includes("通了"),
    text.slice(0, 120).replace(/\s+/g, " "),
  );
}

console.log(
  `\n${failures === 0 ? "全部通过 —— 这个地址可以填进 ChatGPT 了" : `${failures} 项失败`}`,
);
process.exitCode = failures === 0 ? 0 : 1;
