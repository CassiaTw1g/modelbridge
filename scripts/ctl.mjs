#!/usr/bin/env node
/**
 * Lifecycle manager for the modelbridge plugin.
 *
 * setup / start / stop / restart / reload / status / enable / disable / logs /
 * uninstall / secret / rotate / url / tunnel / untunnel / allow / jobs /
 * pending / approve / deny / audit / auto
 *
 * `reload` restarts the server alone; `restart` also restarts the tunnel. With a
 * quick tunnel that changes the public URL; with a named one it does not.
 *
 * The server is spawned detached so it survives this shell exiting.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTO_APPROVE_FLAG, auditEvent, decide, isApprovalOff, listPending } from "../src/agent/approvals.ts";
import { readJobSnapshots } from "../src/agent/jobs.ts";
// The wizard's text, language detection and probe parsing. Deliberately a plain
// `.mjs` with no imports beyond node builtins: `npm run setup` has to work on a
// fresh clone, before `npm install`, and the two modules above are the only
// reason this file itself can. `src/harness/claude-code.ts` cannot be imported
// here for the same reason — it pulls in the MCP SDK.
import {
  CLAUDE_BIN_RELATIVE,
  PROVIDER_PRESETS,
  anthropicBase,
  classifyProbe,
  claudeExeName,
  detectLang,
  keySummary,
  looksLikeHost,
  looksLikeHttpUrl,
  messagesUrl,
  normalizeHost,
  normalizeLang,
  probeUsable,
  shortDetail,
  t,
} from "./setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "src", "server.ts");
const ENV_FILE = join(ROOT, ".env");
// Must resolve to the *same* directory the server will use, or the auto-approve
// flag is written somewhere nothing reads and nothing ever clears — a security
// toggle that silently does nothing is worse than one that is missing.
//
// `jobs.ts` computes `process.env.BRIDGE_STATE_DIR ?? join(ROOT, ".state")`, and
// `cmdStart` hands the child `{...process.env, ...parseEnvFile()}`, so through the
// normal path a `.env` value beats a shell one. This mirrors that spread exactly:
// `.env` first, then the ambient variable, then the default. `parseEnvFile` is a
// hoisted declaration and `ENV_FILE` is initialised on the line above, so calling
// it here is safe.
const STATE_DIR =
  parseEnvFile().BRIDGE_STATE_DIR || process.env.BRIDGE_STATE_DIR || join(ROOT, ".state");
const PID_FILE = join(STATE_DIR, "server.pid");
const LOG_FILE = join(STATE_DIR, "server.log");
const DISABLED_FLAG = join(STATE_DIR, "disabled");
const AUTO_APPROVE_FILE = join(STATE_DIR, AUTO_APPROVE_FLAG);
const TUNNEL_PID_FILE = join(STATE_DIR, "tunnel.pid");
const TUNNEL_LOG_FILE = join(STATE_DIR, "tunnel.log");

const isWindows = process.platform === "win32";

function parseEnvFile() {
  if (!existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true });
}

function readPid(file = PID_FILE) {
  if (!existsSync(file)) return null;
  const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** cloudflared via PATH, else the usual install locations winget/brew use. */
function resolveCloudflared() {
  const candidates = [
    join(process.env["ProgramFiles(x86)"] ?? "", "cloudflared", "cloudflared.exe"),
    join(process.env.ProgramFiles ?? "", "cloudflared", "cloudflared.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", "cloudflared.exe"),
    "/usr/local/bin/cloudflared",
    "/opt/homebrew/bin/cloudflared",
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "cloudflared";
}

/** Only the current run's section — the log is appended across restarts, and an
 *  earlier run's URL would otherwise still match. */
function currentTunnelLog() {
  if (!existsSync(TUNNEL_LOG_FILE)) return "";
  const body = readFileSync(TUNNEL_LOG_FILE, "utf8");
  const marker = body.lastIndexOf("--- tunnel ");
  return marker >= 0 ? body.slice(marker) : body;
}

function findTunnelUrl() {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(currentTunnelLog());
  return m ? m[0] : null;
}

// --- 隧道模式 ---------------------------------------------------------------
//
// Two ways to get a public hostname, and they differ in one way that shapes the
// whole rest of this file:
//
//   quick  a throwaway `*.trycloudflare.com` name, discovered by *scraping it
//          out of cloudflared's log* after the fact. New name on every start.
//   named  a hostname the operator already owns, configured in `.env`. There is
//          nothing to discover — the address is known before the process starts.
//
// So named mode must not run through the "wait for a URL to appear in the log"
// path: a healthy named tunnel never prints a trycloudflare URL, and the timer
// would expire and `exit(1)` on a tunnel that is working perfectly.
//
// Default is quick. Nothing here names anybody's domain — `TUNNEL_HOSTNAME` is
// the operator's own value, read from their own `.env`.

function tunnelMode(env) {
  return (env.TUNNEL_MODE ?? "quick").trim().toLowerCase() === "named" ? "named" : "quick";
}

/** Strip a scheme or trailing slash people paste in by habit — the URL is built here. */
function namedHostname(env) {
  return (env.TUNNEL_HOSTNAME ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

/** The configured address, or null when this isn't a usable named setup. */
function configuredTunnelUrl(env) {
  if (tunnelMode(env) !== "named") return null;
  const host = namedHostname(env);
  return host ? `https://${host}` : null;
}

/**
 * Where the bridge is reachable from outside, whichever mode is in play.
 *
 * Named wins over scraped: once a hostname is configured it is *the* address, and
 * a stale trycloudflare line left in an appended log must not shadow it.
 */
function publicUrl(env) {
  return configuredTunnelUrl(env) ?? findTunnelUrl();
}

/**
 * Whether a named tunnel has everything cloudflared needs. Returns the problems
 * as plain sentences — `tunnel check` prints them verbatim, so "缺少 X" has to be
 * actionable rather than a boolean.
 */
function namedConfigProblems(env) {
  const problems = [];
  if (tunnelMode(env) !== "named") return problems;
  if (!namedHostname(env)) {
    problems.push("TUNNEL_HOSTNAME 没填 —— 应该是你自己的域名,例如 mcp.example.com(不要带 https://)。");
  }
  const token = (env.TUNNEL_TOKEN ?? "").trim();
  const name = (env.TUNNEL_NAME ?? "").trim();
  if (!token && !name) {
    problems.push(
      "TUNNEL_TOKEN 和 TUNNEL_NAME 都没填 —— 二选一。\n" +
        "     用 Cloudflare 控制台建隧道的话,把控制台给的 token 填进 TUNNEL_TOKEN。",
    );
  }
  // Cloudflare's console-issued tokens are long base64-ish blobs. A short value
  // is nearly always a tunnel UUID or name pasted into the wrong key, which
  // would otherwise fail much later with an opaque cloudflared error.
  if (token && token.length < 40) {
    problems.push(
      "TUNNEL_TOKEN 看起来不像 Cloudflare 签发的 token(通常 150 字符以上)。\n" +
        "     如果你手上是隧道 ID 或隧道名,请填到 TUNNEL_NAME。",
    );
  }
  return problems;
}

async function waitForTunnelUrl(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = findTunnelUrl();
    if (url) return url;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/**
 * cloudflared's own view of this run: is any edge connection alive *now*, and how?
 *
 * `Registered tunnel connection` means Cloudflare acknowledged a connection ID —
 * a real handshake, not just "a process exists". But a registration is a moment,
 * not a state: cloudflared runs four connections and the tunnel works only while
 * at least one of them is still up. So the question is what cloudflared logged
 * LAST for each `connIndex`, up events and down events both counted.
 *
 * The two rules that came before were wrong in the same direction:
 *   · "the process is alive" — hid a ~20-hour outage (2026-09-12).
 *   · "a registration appears after the last `Unable to establish connection with
 *     Cloudflare edge`" — that string is what a *blocked* edge produces. A tunnel
 *     that registers and THEN loses its connections logs `Connection terminated`
 *     / `Failed to dial` / `Retrying connection in` instead, none of which matched
 *     that search, so `status` cheerfully reported 已连上边缘 straight through a
 *     two-minute outage in which every request got 502 (2026-09-13, ~16:29Z).
 *   Counting the down events is the whole fix; replaying both real outages
 *   against this rule is what confirmed it.
 */
const EDGE_EVENT =
  /(Registered tunnel connection|Failed to dial|Retrying connection in|Lost connection with the edge|Connection terminated|Unregistered tunnel connection)[^\n]*?connIndex=(\d+)/g;
const EDGE_UP = "Registered tunnel connection";

function tunnelState() {
  const log = currentTunnelLog();
  const last = new Map();
  EDGE_EVENT.lastIndex = 0;
  for (let m; (m = EDGE_EVENT.exec(log)); ) last.set(m[2], m[1]);
  return {
    up: [...last.values()].some((e) => e === EDGE_UP),
    proto: /Initial protocol (\w+)/.exec(log)?.[1] ?? null,
    url: findTunnelUrl(),
  };
}

async function waitForTunnelReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = tunnelState();
    if (st.up) return st;
    await new Promise((r) => setTimeout(r, 500));
  }
  return tunnelState();
}

/**
 * Fetch our own public URL — out to Cloudflare's edge and back through the tunnel.
 *
 * ⚠️ On a machine that reaches the internet through a proxy/VPN, this CAN come
 * back negative while the tunnel is perfectly healthy: the request has to leave
 * through the proxy and then be routed back to us, and a TUN-style setup often
 * breaks exactly that hairpin. Verified on 2026-09-12 — this returned nothing
 * while an external fetcher got `{"ok":true}` off the same URL. So treat a
 * failure as "本机回连不通,需要外部确认", never as proof the tunnel is down.
 * Use tunnelState() for the verdict.
 */
async function probePublicHealth(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "未尝试";
  do {
    try {
      const res = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(6000),
        redirect: "follow",
      });
      if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
      last = `HTTP ${res.status}`;
    } catch (err) {
      const name = err?.name ?? "";
      last = name === "TimeoutError" || name === "AbortError" ? "超时" : (err?.message ?? String(err));
    }
    await new Promise((r) => setTimeout(r, 1500));
  } while (Date.now() < deadline);
  return { ok: false, detail: last };
}

/**
 * Wait until the port is actually answering, on loopback.
 *
 * `isAlive(pid)` is not the same question. `npm start` spawns a shell, and the
 * shell outlives the node process it launched: when `src/server.ts` dies at boot
 * — a missing dependency, a malformed `.env`, a port already taken — the PID in
 * `.state/server.pid` stays alive and `currentStatus()` reports a healthy
 * service. Observed for real on 2026-09-12, in the wizard's own end-to-end test:
 * it printed a public URL and copied it to the clipboard while the server behind
 * it was already dead.
 *
 * That is the worst shape this failure can take, because the tunnel comes up
 * fine and the operator's only symptom is ChatGPT failing to connect — which
 * looks like a ChatGPT problem. A tunnel in front of a dead port can never work,
 * so this is worth refusing on.
 *
 * Loopback only, deliberately: the caveat on `probePublicHealth` about proxy
 * hairpins does not apply to a request that never leaves the machine.
 */
async function waitForLocalHealth(port, timeoutMs = 20_000) {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + timeoutMs;
  let last = "未尝试";
  do {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
      last = `HTTP ${res.status}`;
    } catch (err) {
      const name = err?.name ?? "";
      last = name === "TimeoutError" || name === "AbortError" ? "超时" : (err?.cause?.message ?? err?.message ?? String(err));
    }
    await new Promise((r) => setTimeout(r, 500));
  } while (Date.now() < deadline);
  return { ok: false, detail: last };
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function currentStatus() {
  const pid = readPid();
  const alive = isAlive(pid);
  if (!alive && existsSync(PID_FILE)) rmSync(PID_FILE, { force: true });
  return {
    disabled: existsSync(DISABLED_FLAG),
    running: alive,
    pid: alive ? pid : null,
    env: parseEnvFile(),
  };
}

function describeEndpoint(env) {
  const port = env.PORT ?? "8787";
  const secret = env.MCP_PATH_SECRET ?? "";
  return {
    local: `http://127.0.0.1:${port}/mcp/${secret}`,
    pathOnly: `/mcp/${secret}`,
  };
}

/**
 * Hide the path secret in anything headed for stdout.
 *
 * The secret is the only credential this bridge has, and every printed copy of
 * it outlives the moment: terminal scrollback, a shell transcript, a pasted
 * troubleshooting log, a session with an AI. The one real leak so far came from
 * this script printing it — twice, from `start` alone — and not from anybody
 * finding it. So the default is to mask, and `--show` exists for the operator
 * who genuinely needs to read it.
 *
 * `rotate` still puts the *full* URL on the clipboard. A clipboard is not a log,
 * and it is the reason the printed copy is not needed.
 */
function mask(text) {
  if (flags.has("--show")) return text;
  let out = String(text).replace(/\/mcp\/[0-9a-fA-F]{8,}/g, "/mcp/<密钥已隐藏,加 --show 查看>");

  // The pattern above only catches a secret in URL shape. Log files, audit
  // lines and job results are free text: anything the sub-agent ever printed —
  // `echo $env:MCP_PATH_SECRET`, a prompt-injected file, a stack trace — lands
  // in them verbatim. So the literal value is masked too, wherever it appears.
  // Both credentials, not just the path secret. `TUNNEL_TOKEN` is the newer one
  // and is strictly more dangerous: it is full control of a tunnel into this
  // machine, it is handed to a *third-party binary's* command line, and any
  // diagnostic that dumps argv (`--loglevel debug`, a crash report, a process
  // listing) would otherwise put it straight into whatever file we printed to.
  //
  // `DEEPSEEK_API_KEY` is the third, and it is here for a different reason: it
  // is the one credential the *wizard* handles, and an API error body can quote
  // the request back. `scrubEnv` already keeps it out of the sub-agent's
  // environment, so this is defence in depth rather than the only wall — but a
  // wizard that prints its own verification response is exactly where a key
  // would otherwise end up in a scrollback a stranger is reading.
  const env = parseEnvFile();
  for (const key of ["MCP_PATH_SECRET", "TUNNEL_TOKEN", "DEEPSEEK_API_KEY"]) {
    const value = process.env[key] || env[key] || "";
    // The length floor is about false positives, not safety: a one-character
    // value would turn every occurrence of that character into noise.
    if (value.length >= 8) out = out.split(value).join(`<${key} 已隐藏>`);
  }
  return out;
}

function preflight() {
  const env = parseEnvFile();
  const problems = [];
  if (!existsSync(ENV_FILE)) {
    problems.push(".env 不存在。复制 .env.example 为 .env 并填写。");
  }
  if (!env.DEEPSEEK_API_KEY || !env.DEEPSEEK_API_KEY.startsWith("sk-")) {
    problems.push("DEEPSEEK_API_KEY 未设置或格式不对(应以 sk- 开头)。");
  }
  if (!env.MCP_PATH_SECRET || env.MCP_PATH_SECRET.length < 16) {
    problems.push("MCP_PATH_SECRET 未设置或过短。运行 `npm run ctl -- secret` 生成一个。");
  }
  return problems;
}

function cmdStart({ foreground = false } = {}) {
  const state = currentStatus();

  if (state.disabled) {
    console.error("插件处于停用状态。先运行 `npm run enable`。");
    process.exit(1);
  }
  if (state.running) {
    console.log(`已在运行,PID ${state.pid}。`);
    return;
  }

  const problems = preflight();
  if (problems.length > 0) {
    console.error("启动前检查未通过:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  ensureStateDir();
  const env = { ...process.env, ...parseEnvFile() };

  if (foreground) {
    const child = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  const logFd = openSync(LOG_FILE, "a");
  appendFileSync(LOG_FILE, `\n--- start ${new Date().toISOString()} ---\n`);

  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });

  child.unref();
  writeFileSync(PID_FILE, String(child.pid));

  const { local, pathOnly } = describeEndpoint(env);
  console.log(`已启动,PID ${child.pid}`);
  console.log(`  本地端点 : ${mask(local)}`);
  console.log(`  MCP 路径 : ${mask(pathOnly)}`);
  console.log(`  日志     : ${LOG_FILE}`);
  if (!flags.has("--show")) console.log("  (端点里的密钥默认隐藏;要打印完整的加 --show)");
}

function cmdStop() {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    if (existsSync(PID_FILE)) rmSync(PID_FILE, { force: true });
    console.log("未在运行。");
    return;
  }

  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }

  rmSync(PID_FILE, { force: true });
  console.log(`已停止,PID ${pid}。`);
  cmdUntunnel();
}

function readTunnelPid() {
  const pid = readPid(TUNNEL_PID_FILE);
  if (!pid) {
    if (existsSync(TUNNEL_PID_FILE)) rmSync(TUNNEL_PID_FILE, { force: true });
    return null;
  }
  if (!isAlive(pid)) {
    rmSync(TUNNEL_PID_FILE, { force: true });
    return null;
  }
  return pid;
}

/**
 * Remove the on-disk copy of the tunnel token.
 *
 * `namedTunnelArgs` writes it so the credential never has to appear in a command
 * line. Nothing else would ever clean it up, and a credential copy that outlives
 * the thing it was for is pure liability — `.env` is the one place it is meant to
 * live, and the next `tunnel` rewrites this file from there anyway.
 */
function removeTunnelToken() {
  rmSync(join(STATE_DIR, "tunnel.token"), { force: true });
}

function cmdUntunnel() {
  removeTunnelToken();
  const pid = readTunnelPid();
  if (!pid) {
    console.log("隧道未在运行。");
    return;
  }
  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  rmSync(TUNNEL_PID_FILE, { force: true });
  console.log(`隧道已停止,PID ${pid}。`);
}

async function cmdTunnel() {
  const state = currentStatus();
  if (state.disabled) {
    console.error("插件处于停用状态。先运行 `npm run enable`。");
    process.exit(1);
  }
  if (!state.running) {
    console.error("服务未运行。先运行 `npm start`。");
    process.exit(1);
  }

  const existing = readTunnelPid();
  if (existing) {
    const url = publicUrl(state.env);
    console.log(`隧道已在运行,PID ${existing}`);
    if (url) console.log(`公网端点 : ${mask(`${url}/mcp/${state.env.MCP_PATH_SECRET ?? ""}`)}`);
    return;
  }

  const env = { ...process.env, ...state.env };
  const port = env.PORT ?? "8787";
  const named = tunnelMode(env) === "named";

  // Before publishing anything: is there a server on that port? See
  // `waitForLocalHealth` — a live PID is not the same thing, and a tunnel in
  // front of a dead port produces a URL that fails in a way that looks like
  // ChatGPT's fault. Generous timeout because `start` returns as soon as the
  // process is spawned, not when it is listening.
  process.stdout.write("服务检查 : 本机端口是否应答");
  const local = await waitForLocalHealth(port);
  console.log(local.ok ? ` … 通 (${local.detail})` : ` … 不通 (${local.detail})`);
  if (!local.ok) {
    console.error("");
    console.error(`⚠️  没有开隧道:\`127.0.0.1:${port}\` 上没有服务在应答,隧道接上去也是白接。`);
    console.error("    （`.state/server.pid` 里的进程活着,不代表服务活着 —— `npm start` 包了一层 shell。）");
    console.error("");
    console.error(`    先看它为什么没起来:${LOG_FILE}`);
    console.error("    再试:npm start(前台跑一次,报错会直接打在屏幕上)");
    process.exit(1);
  }

  if (named) {
    const problems = namedConfigProblems(env);
    if (problems.length > 0) {
      console.error("TUNNEL_MODE=named,但配置不全:");
      for (const p of problems) console.error(`  - ${p}`);
      console.error("");
      console.error("配置说明:.env.example 里 TUNNEL_MODE 那一段;也可以 `npm run ctl -- tunnel check`。");
      process.exit(1);
    }
  }

  ensureStateDir();
  appendFileSync(TUNNEL_LOG_FILE, `\n--- tunnel ${new Date().toISOString()} ---\n`);

  const logFd = openSync(TUNNEL_LOG_FILE, "a");
  let args;

  if (named) {
    // No `--url`: the route from hostname to local port lives in Cloudflare's
    // remote config (the route you published in the dashboard), not here.
    // Passing `--url` as well would fight that rather than help it.
    //
    // `--protocol` is honoured here (it is a hidden flag — see namedTunnelArgs),
    // but only when the operator set it. Left alone, `tunnel run` runs its own
    // connectivity pre-check and prefers QUIC/UDP, which is what survives a
    // TUN-style VPN — so the default is already the right answer for most people.
    args = namedTunnelArgs(env);
  } else {
    // Transport protocol. Default `auto` = don't pass --protocol at all, which makes
    // cloudflared run its own connectivity pre-check and use whichever of QUIC
    // (UDP/7844) or HTTP/2 (TCP/7844) actually works on this machine right now.
    //
    // ⚠️ Do NOT hardcode http2 again. With a Clash-style VPN in TUN mode (which
    // ChatGPT itself needs), outbound TCP/7844 gets swallowed by the proxy and dies
    // with `TLS handshake with edge error: EOF`, while UDP/7844 sails straight
    // through — cloudflared's own pre-check reports exactly that:
    //   UDP Connectivity  PASS   QUIC connection successful
    //   TCP Connectivity  FAIL   HTTP/2 connection is blocked or unreachable
    // Forcing http2 there means the tunnel can never connect at all. That is what
    // silently broke this tunnel for ~20 hours on 2026-09-12.
    //
    // Override in .env when auto picks wrong: TUNNEL_PROTOCOL=http2 | quic
    const protocol = (env.TUNNEL_PROTOCOL ?? "auto").trim().toLowerCase();
    args = ["tunnel", "--url", `http://localhost:${port}`];
    if (protocol === "http2" || protocol === "quic") args.push("--protocol", protocol);
  }

  const child = spawn(resolveCloudflared(), args, {
    cwd: ROOT,
    env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  writeFileSync(TUNNEL_PID_FILE, String(child.pid));

  // The one structural difference between the two modes, and the reason named
  // mode cannot reuse the quick path: a quick tunnel's address does not exist
  // until cloudflared invents one and prints it, so it has to be waited for and
  // scraped. A named tunnel's address was decided by the operator before this
  // process started. Waiting for a `*.trycloudflare.com` line that will never
  // come would time out and `exit(1)` on a tunnel that is working perfectly.
  let url;
  if (named) {
    url = configuredTunnelUrl(env);
    console.log(`隧道启动中(PID ${child.pid}),固定地址 ${url}(不用等分配)`);
  } else {
    console.log(`隧道启动中(PID ${child.pid}),等待分配公网地址…`);
    url = await waitForTunnelUrl(30_000);
    if (!url) {
      console.error(`30 秒内没拿到公网地址。看日志:${TUNNEL_LOG_FILE}`);
      process.exit(1);
    }
  }

  const full = `${url}/mcp/${env.MCP_PATH_SECRET ?? ""}`;
  console.log("");
  console.log(`公网端点 : ${mask(full)}`);
  console.log(`健康检查 : ${url}/health`);

  // 拿到 URL 不等于能用 —— 等 cloudflared 真的注册到边缘。
  process.stdout.write("隧道状态 : 等待 cloudflared 注册到 Cloudflare 边缘");
  const st = await waitForTunnelReady(30_000);
  console.log(st.up ? ` … 已注册 (传输 ${st.proto ?? "?"})` : " … 失败");
  console.log("");

  if (!st.up) {
    console.error("⚠️  隧道进程起来了,但**一次都没能连上 Cloudflare 边缘**。");
    console.error("    ChatGPT 现在连上去只会失败,别把上面这个 URL 填进去。");
    console.error("");
    if (named) {
      console.error("    固定隧道连不上,通常是这几件事:");
      console.error("      1. token 复制不完整(少一个字符就整个不通),重新从控制台复制一次");
      console.error("      2. 这条隧道已经在别处跑着 —— 同一个 token 只能有一份在跑");
      console.error("      3. VPN/TUN 抢走出站流量,试 TUNNEL_MODE=quick 对照一下");
    } else {
      console.error("    最常见的原因是 VPN/TUN 抢走了出站流量。在 .env 里指定协议再试:");
      console.error("      TUNNEL_PROTOCOL=auto    让 cloudflared 自己探测(默认)");
      console.error("      TUNNEL_PROTOCOL=quic    开着 TUN 时通常选这个(UDP 7844)");
      console.error("      TUNNEL_PROTOCOL=http2   直连、没开 TUN 时(TCP 7844)");
    }
    console.error("    改完执行 `npm run ctl -- untunnel && npm run ctl -- tunnel`。");
    console.error(`    也可以直接看日志里 cloudflared 自己的自检:${TUNNEL_LOG_FILE}`);
    process.exit(1);
  }

  // 注册成功 = 隧道这头通了。下面这条只是参考,本机走梯子时常常是假警报。
  process.stdout.write("本机回连 : ");
  const probe = await probePublicHealth(url, 10_000);
  if (probe.ok) {
    console.log(`通 (${probe.detail})`);
  } else {
    console.log(`不通 (${probe.detail}) —— 多半是本机经梯子绕不回来,不代表外面连不上`);
  }
  console.log("");
  console.log("填进 ChatGPT 网页版 → Settings → Plugins → MCP → Add server:");
  console.log("  类型选 Streamable HTTP,鉴权选「无鉴权 / No authentication」");
  console.log(`  URL  ${mask(full)}`);
  if (!flags.has("--show")) console.log("  (密钥默认隐藏;要打印完整 URL 加 --show)");

  if (named) {
    // The failure this mode invites: the tunnel is genuinely up, but nobody ever
    // added the hostname on Cloudflare's side, so the domain 404s. "Registered
    // to the edge" cannot distinguish that, so say the requirement out loud
    // rather than let them discover it in ChatGPT.
    console.log("");
    console.log("⚠️  固定隧道还差一步**在 Cloudflare 那边**的配置 —— 本机看不出来它做没做:");
    console.log(`     Networking → Tunnels → 这条隧道 → Routes(路由)`);
    console.log(`     → Add route → Published application(已发布的应用)`);
    console.log(`     加一条:域名 ${namedHostname(env)},Service 选 HTTP、URL 填 http://localhost:${port}`);
    console.log("     少了它,隧道一切正常但打开那个域名会 404。");
    console.log("     验证:`npm run ctl -- tunnel check`");
  }
}

/**
 * argv for a named tunnel, and where the credential lives.
 *
 * `--token-file` rather than `--token`: an argument is readable by any process on
 * this machine (Task Manager's command-line column, `wmic process get
 * commandline`) with no file permissions in the way, while a file has ACLs. The
 * token is full control of a tunnel into this machine, so it does not belong in
 * a command line. `.state/` is gitignored in both repositories.
 *
 * `TUNNEL_NAME` is the alternative for people who set the tunnel up with the
 * cloudflared CLI instead of the dashboard: that path reads credentials and
 * ingress rules from cloudflared's own config, so we pass nothing but the name.
 *
 * ⚠️ `--protocol` HERE TOO — do not drop it from this branch.
 *
 * It is a *hidden* flag: it appears in no help text, in any of the three
 * positions (`cloudflared --help`, `tunnel --help`, `tunnel run --help`). Reading
 * the help and concluding "it does not exist on `tunnel run`" is wrong, and was
 * wrong here once. The check that actually settles it is a control: an
 * undefined flag makes cloudflared refuse to parse —
 *   `--this-flag-does-not-exist` → "Incorrect Usage: flag provided but not defined"
 * — while `tunnel run --protocol quic` parses fine and gets as far as complaining
 * about a missing tunnel ID. Both flag orders work; this one puts it before the
 * subcommand, which is the safer position against a future reorganisation.
 *
 * Why it matters: an operator who had to force `quic` for a quick tunnel (i.e.
 * anyone behind a TUN-mode VPN — see the long note in `cmdTunnel`) has exactly
 * the same problem on a named one, and would otherwise have no way to say so.
 * Passing it only when explicitly configured keeps the default as cloudflared's
 * own pre-check, which is what picks correctly for everyone else.
 */
const TUNNEL_PROTOCOLS = new Set(["quic", "http2"]);

function explicitProtocol(env) {
  const value = (env.TUNNEL_PROTOCOL ?? "auto").trim().toLowerCase();
  return TUNNEL_PROTOCOLS.has(value) ? value : null;
}

function namedTunnelArgs(env) {
  const protocol = explicitProtocol(env);
  const prefix = protocol ? ["--protocol", protocol] : [];
  const token = (env.TUNNEL_TOKEN ?? "").trim();
  if (token) {
    const tokenFile = join(STATE_DIR, "tunnel.token");
    writeFileSync(tokenFile, token, { encoding: "utf8", mode: 0o600 });
    return ["tunnel", ...prefix, "run", "--token-file", tokenFile];
  }
  return ["tunnel", ...prefix, "run", (env.TUNNEL_NAME ?? "").trim()];
}

/**
 * `tunnel check` — is a named tunnel configured well enough to try?
 *
 * Exists because the interesting failures here are silent. A wrong token or a
 * a missing published route both produce a tunnel that looks alive on this end, and
 * the operator finds out from ChatGPT. Catching the config-level half here is the
 * part that can actually be caught locally.
 */
async function cmdTunnelCheck() {
  const env = parseEnvFile();
  const mode = tunnelMode(env);

  console.log(`隧道模式 : ${mode === "named" ? "named(固定域名,你自己提供)" : "quick(临时隧道,默认)"}`);
  if (mode !== "named") {
    console.log("");
    console.log("临时隧道不需要配置 —— 每次启动由 Cloudflare 随机分配一个域名,重启就换。");
    console.log("想要固定域名:TUNNEL_MODE=named + TUNNEL_HOSTNAME + TUNNEL_TOKEN,见 .env.example。");
    return;
  }

  console.log(`主机名   : ${namedHostname(env) || "(未填)"}`);
  console.log(`凭据     : ${(env.TUNNEL_TOKEN ?? "").trim() ? "TUNNEL_TOKEN 已设置(值不打印)" : (env.TUNNEL_NAME ?? "").trim() ? `TUNNEL_NAME=${(env.TUNNEL_NAME ?? "").trim()}` : "(未设置)"}`);
  console.log(`本地端口 : ${env.PORT ?? "8787"}`);
  console.log("");

  const problems = namedConfigProblems(env);
  if (problems.length > 0) {
    console.error("配置有问题:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("配置齐全,可以 `npm run tunnel`。");
  console.log("");
  console.log("⚠️  下面这条本机验证不了,得你自己在 Cloudflare 控制台确认:");
  console.log(`     Networking → Tunnels → 这条隧道 → Routes(路由) → Add route`);
  console.log(`     → Published application(已发布的应用)`);
  console.log(`     有一条:域名 ${namedHostname(env)} → Service HTTP → http://localhost:${env.PORT ?? "8787"}`);
  console.log("     少了它,隧道显示已连上,但打开域名是 404。");

  const url = configuredTunnelUrl(env);
  const st = tunnelState();
  if (readTunnelPid()) {
    console.log("");
    console.log(`当前隧道 : ${st.up ? `已连上边缘${st.proto ? `,传输 ${st.proto}` : ""}` : "⚠️ 未连上边缘"}`);
  }
  if (url) {
    const probe = await probePublicHealth(url, 10_000);
    console.log(`本机回连 : ${probe.ok ? `通 (${probe.detail})` : `不通 (${probe.detail})`}`);
    if (!probe.ok) {
      console.log("           ↑ 本机经梯子回连本来就常常不通,这一条**不能**当作隧道坏了。");
      console.log("             真要看通不通,用手机流量打开:", `${url}/health`);
    }
  }
}

async function cmdStatus() {
  const state = currentStatus();
  const { local } = describeEndpoint(state.env);
  const tunnelPid = readTunnelPid();
  const tunnelUrl = publicUrl(state.env);
  console.log(`状态     : ${state.disabled ? "已停用 (disabled)" : "已启用 (enabled)"}`);
  console.log(`进程     : ${state.running ? `运行中,PID ${state.pid}` : "未运行"}`);
  console.log(`本地端点 : ${mask(local)}`);

  // Printed on every `status`, deliberately. The whole risk of an unattended
  // mode is that it is invisible — set once, forgotten, and nothing on screen
  // ever mentions it again. This is the one line that makes it visible.
  const mode = autoMode();
  console.log(`审批模式 : ${autoModeLabel()}`);
  if (mode.on) {
    console.log("           ↑ 命令允许名单与链式命令护栏失效,文件工具不再受工作区边界约束。");
    console.log("             恢复:npm run auto:off");
    if (!mode.fileOn && mode.envOff) {
      console.log("             (.env 里的 BRIDGE_CC_APPROVAL=off 不随重启复位 —— 重启也不会恢复。)");
    }
  }

  if (tunnelPid) {
    // 判据是 cloudflared 有没有注册到边缘,不是进程在不在。
    const st = tunnelState();
    console.log(
      `隧道     : ${st.up ? "已连上边缘" : "⚠️ 未连上边缘"}` +
        `${st.proto ? `,传输 ${st.proto}` : ""},PID ${tunnelPid}`,
    );
    console.log(`隧道模式 : ${tunnelMode(state.env) === "named" ? `固定域名 ${namedHostname(state.env)}` : "临时隧道(重启会换域名)"}`);
    console.log(
      `公网端点 : ${
        tunnelUrl ? mask(`${tunnelUrl}/mcp/${state.env.MCP_PATH_SECRET ?? ""}`) : "(地址未知,看 tunnel.log)"
      }`,
    );
    if (!st.up) {
      console.log("           ↑ 进程活着但连不上 Cloudflare —— ChatGPT 用不了。");
      console.log("             试试换传输协议:.env 里加 TUNNEL_PROTOCOL=quic(开 TUN)或 http2(直连),");
      console.log("             然后 `npm run ctl -- untunnel && npm run ctl -- tunnel`。");
    } else if (tunnelMode(state.env) === "named") {
      console.log("           ↑ 固定域名还需要 Cloudflare 那边加一条路由才会通");
      console.log("             (本机查不到它做没做)。核对:`npm run ctl -- tunnel check`");
    }
  } else {
    console.log(`隧道     : 未运行(要接 ChatGPT 就运行 \`npm run tunnel\`)`);
  }
  console.log(`日志     : ${LOG_FILE}`);
  if (!existsSync(ENV_FILE)) console.log("注意     : .env 不存在,尚未配置。");
}

function cmdEnable() {
  ensureStateDir();
  rmSync(DISABLED_FLAG, { force: true });
  console.log("已启用。");
}

function cmdDisable() {
  ensureStateDir();
  cmdStop();
  writeFileSync(DISABLED_FLAG, new Date().toISOString());
  console.log("已停用。运行 `npm run enable` 可恢复。");
}

// --- 审批模式 ---------------------------------------------------------------

/**
 * Which of the two sources is holding approvals open.
 *
 * There are two, and they behave differently, so reporting a single boolean
 * would be a lie the operator only discovers at the worst moment:
 *
 *   file  `.state/auto-approve` — what `auto on` writes. Cleared by every boot.
 *   env   `BRIDGE_CC_APPROVAL=off` in `.env` — survives restarts. This is the
 *         escape hatch `scripts/accept.mjs` uses.
 *
 * Only the first is auto-reverted, so `auto off` cannot make the second one
 * stop. Saying so plainly is the difference between a setting and a trap.
 */
function autoMode() {
  const envOff = isApprovalOff(parseEnvFile().BRIDGE_CC_APPROVAL);
  const fileOn = existsSync(AUTO_APPROVE_FILE);
  return { envOff, fileOn, on: envOff || fileOn };
}

function autoModeLabel() {
  const m = autoMode();
  if (!m.on) return "需要批准";
  const via = [m.fileOn ? "临时开关已开" : null, m.envOff ? ".env 里 BRIDGE_CC_APPROVAL=off" : null]
    .filter(Boolean)
    .join(" + ");
  return `⚠️ 完全放行 (${via})`;
}

/**
 * What the warning may and may not claim.
 *
 * Two of these losses are certain from the code path: with the flag on,
 * `claude-code.ts` takes the `else` branch and never passes `--mcp-config` /
 * `--permission-prompt-tool`, so `approval-mcp.ts` is never spawned. The command
 * allowlist and its chaining guard live in that file, and `checkToolPaths`'s only
 * production call site is inside it — so both really are gone.
 *
 * The old wording also claimed "联网工具,也不再问你". That is *not* verified.
 * `DEFAULT_ALLOWED` does not list WebFetch/WebSearch, which reads as "denied",
 * while a measurement recorded in `claude-code.ts` says `--allowedTools` does not
 * restrict anything at all, which reads as "allowed". The two contradict, and a
 * security warning is the last place to resolve a contradiction by guessing — so
 * the claim is out until someone measures it. See 交接.md for the open item.
 */
const AUTO_APPROVE_WARNING = [
  "⚠️  完全放行已开启 —— 不只是「少问几次命令」:",
  "",
  "    · 子代理执行任何命令,都不再经过允许名单,链式命令护栏(&&、|、;)也一起失效",
  "    · 文件工具的工作区边界没了 —— 读写不再限于任务的工作区",
  "",
  "    但 DEEPSEEK_ALLOWED_ROOTS 仍然管用:它决定**哪些目录能作为工作区被打开**,",
  "    放行模式放开的是「打开之后能在里面做什么」。",
  "",
  "    只在你正盯着任务跑、且清楚它在做什么的时候开。",
];

function cmdAuto(args) {
  const mode = String(args.positional[0] ?? "").toLowerCase();

  if (!mode) {
    const m = autoMode();
    console.log(`审批模式 : ${autoModeLabel()}`);
    console.log("");
    if (m.envOff) {
      console.log("注意:.env 里有 BRIDGE_CC_APPROVAL=off,它不随重启复位 ——");
      console.log("      下面那个「恢复审批」对它无效,要改请编辑 .env 删掉这一行。");
      console.log("");
    }
    console.log("切换:");
    console.log("  完全放行 : npm run auto:on     (或 npm run ctl -- auto on)");
    console.log("  恢复审批 : npm run auto:off    (或 npm run ctl -- auto off)");
    console.log("");
    console.log("完全放行只是**临时**的:服务一重启就自动恢复成「需要批准」。");
    return;
  }

  if (mode !== "on" && mode !== "off") {
    console.error(`用法:npm run ctl -- auto [on|off]    (给了 "${mode}")`);
    process.exit(1);
  }

  if (mode === "off") {
    ensureStateDir();
    if (!existsSync(AUTO_APPROVE_FILE)) {
      console.log("本来就是「需要批准」,没有改动。");
    } else {
      rmSync(AUTO_APPROVE_FILE, { force: true });
      auditEvent(STATE_DIR, { type: "auto_approve_off", by: "ctl" });
      console.log("已恢复「需要批准」。");
    }
    if (autoMode().envOff) {
      console.log("");
      console.log("⚠️  但 .env 里还有 BRIDGE_CC_APPROVAL=off —— 完全放行**仍然生效**。");
      console.log("    要从 .env 里删掉那一行,再 `npm run ctl -- reload`。");
    }
    return;
  }

  // Turn on. Refused while the server is down, because boot clears this file —
  // writing it now would look like it worked and then silently do nothing the
  // moment the service starts. A setting that lies about being set is worse than
  // one that says "not yet".
  const state = currentStatus();
  if (state.disabled) {
    console.error("插件处于停用状态。先运行 `npm run enable`。");
    process.exit(1);
  }
  if (!state.running) {
    console.error("服务没在运行,现在开没有意义 —— 服务一启动就会把这个标志清掉。");
    console.error("先 `npm start`(或 `npm run tunnel`),再运行 `npm run auto:on`。");
    process.exit(1);
  }

  ensureStateDir();
  writeFileSync(AUTO_APPROVE_FILE, new Date().toISOString());
  auditEvent(STATE_DIR, { type: "auto_approve_on", by: "ctl" });

  for (const line of AUTO_APPROVE_WARNING) console.log(line);
  console.log("");
  console.log("已生效 —— 从**下一个**任务开始,不用重启服务。");
  console.log("恢复审批:npm run auto:off;或直接重启服务(`npm run ctl -- reload`),也会自动恢复。");
}

/**
 * Put the exact connector URL on the clipboard.
 *
 * The full URL is one long unbroken string with a 64-hex-character tail, which
 * is precisely the shape that is miserable to select by hand out of a terminal
 * and easy to truncate by one character when you do. `rotate` already hands its
 * result to the clipboard for that reason; this is the same courtesy for the
 * everyday case — including after a quick tunnel is handed a new hostname.
 */
function cmdUrl() {
  const env = parseEnvFile();
  const base = publicUrl(env);
  if (!base) {
    console.error("现在没有公网地址。");
    console.error(
      tunnelMode(env) === "named"
        ? "  TUNNEL_MODE=named 但 TUNNEL_HOSTNAME 没填。看:npm run ctl -- tunnel check"
        : "  隧道没在跑。先 `npm run tunnel`(临时隧道每次重启都会换地址)。",
    );
    process.exit(1);
  }
  const full = `${base}/mcp/${env.MCP_PATH_SECRET ?? ""}`;
  console.log(`公网端点 : ${mask(full)}`);
  if (!flags.has("--show")) console.log("(密钥默认隐藏;要打印完整 URL 加 --show)");
  if (flags.has("--show")) {
    console.log(
      copyToClipboard(full)
        ? "已复制到剪贴板 —— 直接粘进 ChatGPT → Settings → Plugins → MCP 就行。"
        : "复制到剪贴板失败。手动复制上面那一行。",
    );
  } else {
    // Still copy the real value: a clipboard is not a log, and needing --show
    // just to get a working clipboard would defeat the masking above.
    console.log(
      copyToClipboard(full)
        ? "已复制到剪贴板(剪贴板里是完整的,屏幕上是隐藏的)。"
        : "复制到剪贴板失败。加 --show 打印完整 URL 再手动复制。",
    );
  }
}

function cmdLogs() {
  if (!existsSync(LOG_FILE)) {
    console.log("还没有日志。");
    return;
  }
  const lines = readFileSync(LOG_FILE, "utf8").split(/\r?\n/);
  // Masked line by line, not just when printing our own text: this output is
  // the one people paste into a bug report, and it is a file we do not fully
  // control (old lines predate the fix in `server.ts`).
  console.log(lines.slice(-40).map(mask).join("\n"));
}

function cmdSecret() {
  const secret = randomBytes(32).toString("hex");
  ensureStateDir();
  if (existsSync(ENV_FILE)) {
    const body = readFileSync(ENV_FILE, "utf8");
    const next = /^MCP_PATH_SECRET=.*$/m.test(body)
      ? body.replace(/^MCP_PATH_SECRET=.*$/m, `MCP_PATH_SECRET=${secret}`)
      : `${body.trimEnd()}\nMCP_PATH_SECRET=${secret}\n`;
    writeFileSync(ENV_FILE, next);
    console.log(
      flags.has("--show") ? `已写入 .env:MCP_PATH_SECRET=${secret}` : "已写入 .env(密钥已隐藏;要打印加 --show)。",
    );
  } else {
    console.log(flags.has("--show") ? secret : "(密钥已隐藏;要打印加 --show)");
  }
  console.log("注意:改动后需要重新启动服务,并同步更新 ChatGPT connector 里的 URL。");
}

/** Best effort. Returns whether it worked, so the caller can say so plainly
 *  rather than claiming a copy that did not happen. */
function copyToClipboard(text) {
  try {
    if (isWindows) return spawnSync("clip.exe", [], { input: text }).status === 0;
    const [cmd, args] =
      process.platform === "darwin" ? ["pbcopy", []] : ["xclip", ["-selection", "clipboard"]];
    return spawnSync(cmd, args, { input: text }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Rotate the capability secret: new secret, restart the *server only*, hand the
 * new URL back on the clipboard.
 *
 * `cmdStop()` deliberately kills the tunnel as well — correct for `stop`,
 * wrong here. The tunnel just forwards a port; it has no idea what the path
 * is, so rotating the secret has no reason to cost you a new public hostname
 * and a second trip to the ChatGPT connector. Leaving it up means only the
 * last segment of the URL changes.
 */
/**
 * Stop the server process, and only the server process.
 *
 * `cmdStop` also calls `cmdUntunnel`, which is right when the bridge is being
 * shut down and wrong for everything else. A quick tunnel is handed a fresh
 * random hostname on every start, so killing it costs the operator another trip
 * to the ChatGPT connector to paste a new URL — and nothing about re-reading
 * `.env`, or picking up edited source, needs that to happen.
 *
 * Returns the PID that was stopped, or null if nothing was running.
 */
function killServerOnly() {
  // Every caller of this restarts the server, and every server boot clears the
  // auto-approve flag — that is the guarantee the operator asked for. But it
  // turns `reload` and `rotate` (and `allow`, which reloads) into silent
  // revocations: you flip unattended mode on, later add a workspace root, and
  // the mode is gone with nothing on screen saying so. Warn here, in the one
  // function all of those paths go through, rather than at each call site.
  //
  // Deliberately *not* preserving the flag across a restart. That would trade
  // away the exact property the feature was built around — "重启就回到需要批准"
  // — to save one command.
  if (existsSync(AUTO_APPROVE_FILE)) {
    console.log("");
    console.log("注意:这次重启会收回「完全放行」(这是设计如此 —— 重启即恢复需要批准)。");
    console.log("      还要放行的话,起来之后重新运行:npm run auto:on");
    console.log("");
  }
  const pid = readPid();
  if (!pid || !isAlive(pid)) return null;
  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  rmSync(PID_FILE, { force: true });
  return pid;
}

/**
 * Pick up edited source, or a changed `.env`, without disturbing the tunnel.
 *
 * The public URL is identical afterwards, so this never needs a matching edit in
 * the ChatGPT connector. Reach for `npm run restart` only when the tunnel itself
 * is what needs a new life.
 */
function cmdReload() {
  if (currentStatus().disabled) {
    console.error("插件处于停用状态。先运行 `npm run enable`。");
    process.exit(1);
  }
  const pid = killServerOnly();
  console.log(pid ? `已停止旧服务(PID ${pid})。` : "服务本来就没在跑,直接启动…");
  cmdStart();
  console.log("");
  console.log("隧道没动,公网 URL 不变 —— ChatGPT 那边不需要重新粘贴。");
  console.log("看状态:npm run ctl -- status");
}

function cmdRotate() {
  const state = currentStatus();
  if (state.disabled) {
    console.error("插件处于停用状态。先运行 `npm run enable`。");
    process.exit(1);
  }
  if (!existsSync(ENV_FILE)) {
    console.error(".env 不存在。先复制 .env.example 为 .env 并填写。");
    process.exit(1);
  }

  const secret = randomBytes(32).toString("hex");
  const body = readFileSync(ENV_FILE, "utf8");
  const next = /^MCP_PATH_SECRET=.*$/m.test(body)
    ? body.replace(/^MCP_PATH_SECRET=.*$/m, `MCP_PATH_SECRET=${secret}`)
    : `${body.trimEnd()}\nMCP_PATH_SECRET=${secret}\n`;
  writeFileSync(ENV_FILE, next);
  console.log("[1/3] 已生成新密钥并写入 .env。");

  // Restart only the server. `cmdStart` re-reads .env, so it picks up the new
  // secret on its own — nothing here needs to pass it along.
  const pid = killServerOnly();
  console.log(pid ? `[2/3] 已停止旧服务(PID ${pid}),用新密钥重启…` : "[2/3] 服务本来就没在跑,直接启动…");
  cmdStart();

  // `publicUrl`, not `findTunnelUrl`: a named tunnel never prints a
  // trycloudflare URL, so scraping the log would report "没有公网地址" and skip
  // the clipboard on a tunnel that is up and has a perfectly good address.
  const url = publicUrl(parseEnvFile());
  if (!readTunnelPid() || !url) {
    console.log("");
    console.log("[3/3] 隧道没在运行,所以还没有公网地址。");
    console.log("      先运行 `npm run tunnel`,再运行 `npm run ctl -- status`。");
    console.log("      本地端点(只能在这台电脑上用):");
    console.log(`        ${mask(describeEndpoint(parseEnvFile()).local)}`);
    return;
  }

  const full = `${url}/mcp/${secret}`;
  console.log("");
  console.log("============================================================");
  console.log("  [3/3] 新的公网端点:");
  console.log("");
  console.log(`  ${mask(full)}`);
  console.log("============================================================");
  console.log(
    copyToClipboard(full)
      ? "已复制到剪贴板 —— 直接粘进 ChatGPT 的 connector 就行。"
      : "复制失败。加 --show 打印完整 URL,或手动拼:域名 + /mcp/ + .env 里的 MCP_PATH_SECRET。",
  );
  console.log("ChatGPT → Settings → Plugins → MCP → 编辑这个 connector → 换掉 URL。");
}

// --- 任务与审批 -------------------------------------------------------------
//
// The server writes these to disk precisely so this script can read them. When
// you approve a command here you are talking to a *different process* — there is
// no RPC, only the queue directory, which is why approving works even if the
// server was restarted between the request and your answer.

function shortTask(task) {
  return task.length > 60 ? `${task.slice(0, 60)}…` : task;
}

function cmdPending() {
  const items = listPending(STATE_DIR);
  if (items.length === 0) {
    console.log("没有待批准的命令。");
    return;
  }
  console.log(`有 ${items.length} 条命令在等你的批准:\n`);
  for (const item of items) {
    const waited = Math.round((Date.now() - item.createdAt) / 1000);
    console.log(`  ${item.id}   (任务 ${item.jobId},已等 ${waited} 秒)`);
    console.log(`    ${mask(`要执行的命令 : ${item.command}`)}`);
    console.log(`    工作目录     : ${item.cwd}`);
    console.log(`    批准 : npm run ctl -- approve ${item.id}`);
    console.log(`    拒绝 : npm run ctl -- deny ${item.id}`);
    console.log("");
  }
  console.log("看不懂这条命令会做什么,就拒绝。批准的单位是这一整条命令。");
}

function cmdDecide(id, decision) {
  if (!id) {
    console.error(`用法:npm run ctl -- ${decision} <id>`);
    process.exit(1);
  }
  const result = decide(STATE_DIR, id, decision);
  console.log(result.message);
  if (!result.ok) process.exit(1);
}

function formatDuration(job) {
  const end = job.finishedAt ?? Date.now();
  const seconds = Math.round((end - job.startedAt) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
}

function cmdJobs(id, { trace = false } = {}) {
  const jobs = readJobSnapshots(STATE_DIR);
  if (jobs.length === 0) {
    console.log("还没有任务记录。");
    return;
  }

  if (id) {
    const job = jobs.find((j) => j.id === id);
    if (!job) {
      console.error(`找不到任务 ${id}。`);
      process.exit(1);
    }
    console.log(`任务     : ${job.id}`);
    console.log(`状态     : ${job.state}`);
    console.log(`工作区   : ${job.workspace}`);
    console.log(`步数     : ${job.steps}`);
    console.log(`耗时     : ${formatDuration(job)}`);
    console.log(`验证码   : ${job.nonce}`);
    console.log(`任务内容 : ${mask(job.task)}`);
    if (job.error) console.log(`错误     : ${mask(job.error)}`);
    if (job.result?.text) {
      console.log("");
      console.log("结果:");
      console.log(mask(job.result.text));
    }
    if (trace) {
      console.log("");
      console.log("轨迹:");
      for (const e of job.events) {
        const time = new Date(e.at).toISOString().slice(11, 19);
        const name = e.name ? ` ${e.name}` : "";
        console.log(mask(`  [${time}] #${e.step} ${e.type}${name} ${e.detail ?? ""}`));
      }
      if (job.events.length === 0) console.log("  (无事件)");
    }
    return;
  }

  console.log(`${jobs.length} 个任务(最近的在前):\n`);
  for (const job of jobs) {
    console.log(`  ${job.id}  ${job.state.padEnd(17)} ${String(job.steps).padStart(3)} 步  ${formatDuration(job).padStart(8)}  ${job.nonce}`);
    console.log(mask(`      ${shortTask(job.task)}`));
  }
  console.log("\n看某一个任务的完整轨迹:npm run ctl -- jobs <id> --trace");
}

function cmdJobKill(id) {
  if (!id) {
    console.error("用法:npm run ctl -- job kill <id>");
    process.exit(1);
  }
  ensureStateDir();
  const dir = join(STATE_DIR, "cancel");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ at: Date.now() }));
  console.log(`已请求取消任务 ${id}。`);
  console.log("任务进程会在 1 秒内被结束(连同它启动的所有子进程)。");
}

function cmdAudit(lines) {
  const file = join(STATE_DIR, "audit.log");
  if (!existsSync(file)) {
    console.log("还没有审计记录。");
    return;
  }
  const rows = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const tail = rows.slice(-(lines || 30));
  for (const row of tail) {
    try {
      const e = JSON.parse(row);
      const time = new Date(e.at).toISOString().slice(11, 19);
      if (e.type === "approval_auto") {
        console.log(mask(`[${time}] 自动放行  ${e.command}`));
      } else if (e.type === "approval_requested") {
        console.log(mask(`[${time}] 请求批准  ${e.id}  ${e.command}`));
      } else if (e.type === "approval_decided") {
        console.log(mask(`[${time}] ${e.decision === "allow" ? "已批准  " : "已拒绝  "} ${e.id}  ${e.reason ?? ""}`));
      } else if (e.type === "approval_timeout") {
        console.log(`[${time}] 超时拒绝  ${e.id}`);
      } else if (e.type === "auto_approve_on") {
        // These three are the only audit lines unattended mode produces, and
        // they are exactly the ones that must be legible: in that mode the
        // approval MCP is never spawned, so no `approval_*` line can be written
        // at all. A raw JSON blob here would bury the mode change in the one
        // place a human ever reads this file.
        console.log(`[${time}] ⚠️ 完全放行 已开启 —— 从此命令/文件/联网不再询问(${e.by ?? "?"})`);
      } else if (e.type === "auto_approve_off") {
        console.log(`[${time}] 已恢复审批 —— 完全放行关闭(${e.by ?? "?"})`);
      } else if (e.type === "auto_approve_cleared") {
        console.log(`[${time}] 服务启动,自动收回完全放行  ${e.reason ?? ""}`);
      } else {
        console.log(mask(`[${time}] ${e.type}  ${JSON.stringify(e).slice(0, 160)}`));
      }
    } catch {
      console.log(row);
    }
  }
}

function cmdUninstall({ purge = false } = {}) {
  cmdStop();
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  console.log("本地状态已清除。");
  console.log("");
  console.log("还需要手动做一步(这个脚本碰不到 ChatGPT):");
  console.log("  打开 ChatGPT 网页版 → Settings → Plugins → MCP → 删除 modelbridge 这个 server。");
  if (purge) {
    console.log("");
    console.log("--purge 已指定,但为安全起见不自动删除项目目录。");
    console.log(`请手动删除:${ROOT}`);
  }
}

function readRoots() {
  return (parseEnvFile().DEEPSEEK_ALLOWED_ROOTS || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Set one key in `.env`, line by line, keeping everything else.
 *
 * Not a whole-file regex replace (which is what `cmdSecret`/`cmdRotate` do, and
 * is fine there because they rewrite the one line they own). Two things make
 * that shape wrong for general use: it anchors at column 0, so an indented line
 * silently escapes it, and it matches only the first occurrence. This maps over
 * the lines instead — whitespace-tolerant, replaces every occurrence, appends
 * when absent, and preserves comments and blank lines exactly as the operator
 * left them. `writeRoots` has worked this way for a while; this is that, named.
 */
function writeEnvKey(key, value) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  let hit = false;
  const out = lines.map((line) => {
    if (pattern.test(line)) {
      hit = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!hit) {
    while (out.length && out[out.length - 1] === "") out.pop();
    out.push(`${key}=${value}`, "");
  }
  writeFileSync(ENV_FILE, out.join("\n"), "utf8");
}

function writeRoots(roots) {
  writeEnvKey("DEEPSEEK_ALLOWED_ROOTS", roots.join(";"));
}

/**
 * Read one line from the terminal.
 *
 * Used for the tunnel token because a command-line argument is the wrong place
 * for a credential: argv is readable by any process on this machine for the life
 * of the command, and `npm run` prints the whole invocation back. This is not a
 * hidden prompt — the terminal echoes what you paste, same as pasting it into an
 * editor would — but it stays out of the process list and out of npm's output.
 *
 * Resolves `null` when stdin ends without a line. readline's question callback
 * simply never fires at EOF, so without this a wizard in a pipeline
 * (`npm run setup < /dev/null`, a redirected file, CI) would sit there forever
 * with nothing on screen — and a hang reads as "slow", so the operator waits.
 */
function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.question(question, (answer) => done(answer.trim()));
    rl.on("close", () => done(null));
  });
}


/**
 * The wizard's line reader.
 *
 * Deliberately *not* readline, and deliberately one instance for the whole run.
 * `readline.createInterface` reads ahead into its own buffer, so a second
 * interface opened after the first is closed starts with whatever was left on
 * the pipe already gone — which is invisible interactively (a person types one
 * line at a time) and fatal to a piped run, where every remaining answer
 * vanishes after the first question. Owning the buffer here means the second
 * question gets the second line.
 *
 * It also has to own the terminal, because one question in this wizard is a
 * credential: raw mode plus a per-question echo flag is how "show me what I type
 * for the hostname, show me asterisks for the API key" is done without reaching
 * for readline's private `_writeToOutput`.
 *
 * Raw mode is a property of the *console*, not of this process, so `close()` on
 * `process.on("exit")` is not tidiness — without it a Ctrl+C or a normal exit
 * leaves the operator's shell with no line editing and no echo.
 */
class Terminal {
  constructor(input = process.stdin, output = process.stderr) {
    this.input = input;
    this.output = output;
    // A pipe cannot be put in raw mode and echoes nothing anyway, so the same
    // code path serves an interactive terminal and a scripted one.
    this.tty = Boolean(input.isTTY) && typeof input.setRawMode === "function";
    this.queue = [];
    this.waiter = null;
    this.buffer = "";
    this.echo = true;
    this.inEscape = false;
    this.lastWasCr = false;
    this.ended = false;

    this.onData = (chunk) => this.#feed(String(chunk));
    this.onEnd = () => this.#end();

    if (this.tty) input.setRawMode(true);
    input.setEncoding?.("utf8");
    input.resume();
    input.on("data", this.onData);
    input.on("end", this.onEnd);
    input.on("close", this.onEnd);
  }

  #feed(chunk) {
    for (const ch of chunk) {
      if (this.inEscape) {
        // An escape run ends on a final byte in @–~ — `[200~`, `[A`, `OA`.
        if (ch >= "@" && ch <= "~") this.inEscape = false;
        continue;
      }
      if (ch === "\u001b") {
        this.inEscape = true;
        continue;
      }
      // CRLF: one line, not two. Only matters for piped input; a terminal in
      // raw mode sends CR alone.
      if (ch === "\n" && this.lastWasCr) {
        this.lastWasCr = false;
        continue;
      }
      this.lastWasCr = ch === "\r";
      if (ch === "\r" || ch === "\n") {
        this.#complete();
        continue;
      }
      if (ch === "\u0003") {
        // Ctrl+C. Raw mode took it away from the terminal, so honour it here.
        this.output.write("\n");
        process.exit(130);
      }
      if (ch === "\u007f" || ch === "\b") {
        if (this.buffer) {
          this.buffer = this.buffer.slice(0, -1);
          if (this.tty) this.output.write("\b \b");
        }
        continue;
      }
      if (ch < " ") continue; // any other control character
      this.buffer += ch;
      if (this.tty) this.output.write(this.echo ? ch : "*");
    }
  }

  #complete() {
    const line = this.buffer.trim();
    this.buffer = "";
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(line);
    } else {
      this.queue.push(line);
    }
  }

  #end() {
    this.ended = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(null);
    }
  }

  /** One line, or null once stdin has ended. `echo: false` masks what is typed. */
  read(prompt, { echo = true } = {}) {
    if (prompt) this.output.write(prompt);
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.ended) return Promise.resolve(null);
    this.echo = echo;
    return new Promise((resolve) => {
      this.waiter = resolve;
    }).then((line) => {
      this.echo = true;
      return line;
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.input.removeListener("data", this.onData);
    this.input.removeListener("end", this.onEnd);
    this.input.removeListener("close", this.onEnd);
    if (this.tty) {
      try {
        this.input.setRawMode(false);
      } catch {
        /* the console may already be gone */
      }
    }
    this.input.pause();
  }
}

/**
 * `tunnel named` — the whole Cloudflare setup, minus the dashboard.
 *
 * Hand-editing `.env` is the documented path, but the token is a ~150-character
 * opaque blob: pasting it into a text file next to two other keys is where a
 * truncation happens, and a truncated token fails later with an error that says
 * nothing about truncation. This writes all three keys through `writeEnvKey`,
 * takes the token off stdin rather than argv, and then tells the operator the one
 * step that is left — which is on Cloudflare's side and not on this machine.
 */
async function cmdTunnelNamed(args) {
  if (!existsSync(ENV_FILE)) {
    console.error(".env 不存在。先复制 .env.example 为 .env 并填写。");
    process.exit(1);
  }

  const host = String(args.positional[1] ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (!host) {
    console.error("用法: npm run ctl -- tunnel named <你的域名>");
    console.error("例如: npm run ctl -- tunnel named mcp.example.com");
    process.exit(1);
  }
  if (!host.includes(".")) {
    console.error(`"${host}" 看着不像一个域名。要形如 mcp.example.com。`);
    process.exit(1);
  }

  console.log("这个域名必须已经托管在 Cloudflare 上(NS 指向 Cloudflare),否则后面那步加不了。");
  console.log("");
  console.log("接下来需要一个隧道 token,在 Cloudflare 控制台拿:");
  console.log("  Networking → Tunnels → Create a tunnel");
  console.log("  (老的 Zero Trust → Networks → Connectors 菜单现在跳到这儿,是同一个页面)");
  console.log("  起个名字 → 下一步 → 页面上会给一串很长的 token,复制它。");
  console.log("  (如果这条隧道已经建好了:点进去 → Configure → 也能看到 token)");
  console.log("");

  const token = await ask("把 token 粘进来,然后回车:");
  if (!token) {
    console.error("没读到 token,取消。");
    process.exit(1);
  }
  if (token.length < 40) {
    console.error(`这串只有 ${token.length} 个字符,不像完整的 token(通常 150 以上)。`);
    console.error("多半是复制少了。重新运行一次,把整串复制全。");
    process.exit(1);
  }

  writeEnvKey("TUNNEL_MODE", "named");
  writeEnvKey("TUNNEL_HOSTNAME", host);
  writeEnvKey("TUNNEL_TOKEN", token);
  console.log("");
  console.log(`已写入 .env:TUNNEL_MODE=named / TUNNEL_HOSTNAME=${host} / TUNNEL_TOKEN=<已隐藏>`);
  console.log("");
  console.log("═".repeat(62));
  console.log("还剩一步,这一步只能在 Cloudflare 网页上做 —— 本机做不了:");
  console.log("");
  console.log(`  Networking → Tunnels → 点进这条隧道 → Routes(路由) → Add route`);
  console.log(`    → Published application(已发布的应用)`);
  console.log(`    域名(Subdomain) : ${host.split(".")[0]}`);
  console.log(`    域(Domain)       : ${host.split(".").slice(1).join(".")}`);
  console.log(`    Service 类型     : HTTP`);
  console.log(`    Service URL      : http://localhost:${parseEnvFile().PORT ?? "8787"}`);
  console.log("");
  console.log("  漏了这一步:隧道会显示「已连上边缘」,但打开域名是 404。");
  console.log("═".repeat(62));
  console.log("");
  console.log("做完之后:");
  console.log("  npm run ctl -- tunnel check     # 检查配置");
  console.log("  npm run ctl -- untunnel && npm run tunnel");
  console.log("");
  console.log(`之后公网地址就固定是 https://${host}/… —— 重启、重开电脑都不变,`);
  console.log("ChatGPT 那个 connector 只需要建这一次。");
}

/** 盘根、用户目录、`C:\Users` —— 这些不是"一个项目",是整台机器。 */
function dangerousRoot(resolved) {
  const norm = resolved.replace(/[\\/]+$/, "").toLowerCase();
  if (/^[a-z]:$/.test(norm)) return "一个盘符根目录";
  const home = (process.env.USERPROFILE || process.env.HOME || "").replace(/[\\/]+$/, "").toLowerCase();
  if (home && norm === home) return "你的用户目录";
  if (norm === "c:\\users" || norm === "/c/users") return "整个用户目录树";
  return null;
}

/**
 * 增删工作区白名单,不必手改 `.env`。
 *
 * 白名单是唯一一道"子代理能不能碰某个项目"的闸,同时也是"拿到 URL 的人能写这台机器上
 * 多少东西"的闸。手改 `.env` 是上一轮任务悄悄降级的原因:子代理看得见那道门,却没有
 * 任何办法通过它,于是调用方只好换成一个同厂商的复核者 —— 独立性就这么没了。
 * 这条命令把开门变成一行,并且每开一次都再说一遍开的是什么。
 */
function cmdAllow(args) {
  const target = args.positional[0];
  const roots = readRoots();

  if (!target) {
    console.log("子代理当前可以在这些根目录下工作:");
    if (!roots.length) console.log("  (空 —— 所有工作区都会被拒绝,只能花额度)");
    for (const r of roots) console.log(`  ${r}`);
    console.log("");
    console.log('添加: npm run ctl -- allow "D:\\某个项目"');
    console.log('移除: npm run ctl -- allow --remove "D:\\某个项目"');
    console.log("");
    console.log("路径用正斜杠也行(D:/某个项目)—— 在 Git Bash 里反斜杠会被 shell 吃掉。");
    return;
  }

  const resolved = resolve(target);
  const key = resolved.toLowerCase();
  const present = roots.some((r) => resolve(r).toLowerCase() === key);

  if (args.flags.has("--remove")) {
    if (!present) {
      console.error(`白名单里没有 ${resolved}`);
      process.exit(1);
    }
    writeRoots(roots.filter((r) => resolve(r).toLowerCase() !== key));
    console.log(`已移除:${resolved}`);
    console.log("");
    console.log("当前白名单:");
    for (const r of readRoots()) console.log(`  ${r}`);
    cmdReload();
    return;
  }

  if (present) {
    console.log(`${resolved} 已经在白名单里,没有改动。`);
    return;
  }
  if (!existsSync(resolved)) {
    console.error(`这个路径不存在:${resolved}`);
    process.exit(1);
  }
  const danger = dangerousRoot(resolved);
  if (danger && !args.flags.has("--force")) {
    console.error(`拒绝:${resolved} 是${danger},等于把整台机器交出去。`);
    console.error("确实要这样,加 --force。");
    process.exit(1);
  }

  writeRoots([...roots, resolved]);
  console.log(`已添加:${resolved}`);
  console.log("");
  console.log("当前白名单:");
  for (const r of readRoots()) console.log(`  ${r}`);
  console.log("");
  console.log("⚠️  拿到公网 URL 的人,现在可以在上面这些目录里读写文件、执行命令。");
  console.log("    「能执行命令」等于「拿到了这台电脑」。");
  cmdReload();
}

// --- 首次安装向导 -----------------------------------------------------------

/**
 * Where the Claude Code CLI is, or null.
 *
 * Mirrors `resolveBin` in `src/harness/claude-code.ts` — same two homes, same
 * `claude.exe` on Windows — and then looks on PATH, which the harness does not
 * have to because it can shell out to a bare name. The list itself lives in
 * `setup.mjs` so `test-setup.mjs` can check it against that file; this function
 * is the part that touches the disk.
 */
function findClaudeBin() {
  const explicit = process.env.BRIDGE_CLAUDE_BIN || parseEnvFile().BRIDGE_CLAUDE_BIN || "";
  if (explicit && existsSync(explicit)) return explicit;

  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const exe = claudeExeName();
  if (home) {
    for (const relative of CLAUDE_BIN_RELATIVE) {
      const candidate = join(home, ...relative.split("/"), exe);
      if (existsSync(candidate)) return candidate;
    }
  }

  try {
    const probe = spawnSync(isWindows ? "where" : "which", [exe], { encoding: "utf8" });
    if (probe.status === 0) {
      const first = String(probe.stdout ?? "").split(/\r?\n/).find((line) => line.trim());
      if (first) return first.trim();
    }
  } catch {
    /* PATH lookup is a convenience, not a requirement */
  }
  return null;
}

/**
 * The wizard's terminal.
 *
 * One `Terminal` for the whole run — that is the entire point of the class — and
 * the wizard's interactive helpers below are its only callers. Installing it
 * here rather than threading it through forty call sites keeps `cmdSetup`
 * readable; `term()` failing loudly is what stops a later caller from quietly
 * opening a second reader and re-introducing the piped-input bug.
 */
let ACTIVE_TERM = null;

function term() {
  if (!ACTIVE_TERM) {
    throw new Error("内部错误:向导终端未安装(这些提问函数只能在 cmdSetup 里调用)");
  }
  return ACTIVE_TERM;
}

/** Print a message, block or single line, in `lang`. */
function sayLines(lang, key, vars) {
  const value = t(lang, key, vars);
  for (const line of Array.isArray(value) ? value : [value]) console.log(line);
}

/**
 * Print a block and return its last line — the question.
 *
 * Prompts and explanations are the same message in different shapes: the table
 * stores a block, and the question is whatever comes last. That keeps "what you
 * are being asked" adjacent to "why" in one place, in both languages.
 */
function askLine(lang, key, vars) {
  const value = t(lang, key, vars);
  const lines = Array.isArray(value) ? value : [value];
  for (const line of lines.slice(0, -1)) console.log(line);
  return `${lines[lines.length - 1]} `;
}

/** Print a block and ask with its last line. Returns null at EOF. */
async function askPrompt(lang, key, vars, { echo = true } = {}) {
  return term().read(askLine(lang, key, vars), { echo });
}

/**
 * One question, kept in a loop until the answer passes.
 *
 * `check` returns null when the answer is good, or `{key, vars}` naming the
 * message that explains what is wrong — so every rejection re-asks instead of
 * exiting, which matters because the wizard writes to `.env` as it goes and
 * quitting on a typo would leave the operator re-answering everything.
 *
 * `hidden` masks what is typed, for the one answer that is a credential. It is
 * a screen-level courtesy, not a security boundary: the value is still in this
 * process's memory, and in whatever the operator pasted it from.
 *
 * Returns null at EOF, which every caller turns into an abort.
 */
async function askUntil({ hidden = false, promptKey, check, lang, vars }) {
  for (;;) {
    const raw = await askPrompt(lang, promptKey, vars, { echo: !hidden });
    if (raw === null) return null;
    const problem = check(raw);
    if (!problem) return raw.trim();
    sayLines(lang, problem.key, problem.vars);
  }
}

/**
 * A numbered menu. Returns the chosen value, or null at EOF.
 *
 * Enter takes the default; the option's own key (`quick`, `named`) is accepted
 * too, for anyone who reads the source instead of the screen.
 */
async function askChoice(lang, items, defaultIndex = 0) {
  for (;;) {
    console.log("");
    items.forEach(([, label], i) => console.log(`  ${i + 1}) ${label}`));
    const raw = await askPrompt(lang, "q.choose", { options: `1-${items.length}` });
    if (raw === null) return null;
    const answer = raw.trim().toLowerCase();
    if (!answer) return items[defaultIndex][0];
    const byKey = items.find(([key]) => key === answer);
    if (byKey) return byKey[0];
    const index = Number.parseInt(answer, 10);
    if (Number.isInteger(index) && index >= 1 && index <= items.length) return items[index - 1][0];
    sayLines(lang, "invalid.choose", { options: `1-${items.length}` });
  }
}

/**
 * Ask the configured endpoint whether it will actually answer.
 *
 * The wizard exists because the failure this catches is invisible: a truncated
 * key, a base URL missing a path segment, or a model name the endpoint does not
 * know all produce a `.env` that looks complete, a service that starts cleanly,
 * and a connector in ChatGPT that only fails once somebody asks it something.
 * One request here costs a few tokens and moves that discovery to the person
 * who can still fix it.
 *
 * Provisional by construction: the service is not running yet, so this cannot
 * go through the bridge. It speaks to the endpoint directly, with the same URL
 * the harness will derive and the same credential header.
 */
async function probeModel({ base, override, model, key }) {
  const url = messagesUrl(anthropicBase(base, override));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text().catch(() => "");
    return { code: classifyProbe(res.status), status: res.status, detail: shortDetail(text) };
  } catch (err) {
    const name = err?.name ?? "";
    const detail =
      name === "TimeoutError" || name === "AbortError"
        ? "30 秒没有响应 / no response in 30s"
        : (err?.cause?.message ?? err?.message ?? String(err));
    return { code: "network", status: 0, detail: shortDetail(detail) };
  }
}

/**
 * `npm run setup` — the first-run wizard.
 *
 * Everything it writes goes through `writeEnvKey`, so it edits `.env` line by
 * line and never reflows somebody's comments; everything it prints goes through
 * `mask`, so a key or a path secret cannot reach the screen even by accident;
 * and the two steps that touch the running system — `cmdStart` and `cmdTunnel`
 * — are the same functions `npm start` and `npm run tunnel` call. A wizard that
 * reimplemented any of those would be a second copy of a security rule.
 *
 * It is resumable by construction: each answer is written as it is given, so
 * Ctrl+C halfway leaves a usable `.env` and a rerun skips nothing it should not.
 */
async function cmdSetup(args) {
  const explicitLang = args.lang;
  if (explicitLang && !normalizeLang(explicitLang)) {
    console.error(`--lang 只认 zh 和 en(收到 "${explicitLang}")。/ --lang accepts zh or en.`);
    process.exit(1);
  }
  const lang = detectLang({
    explicit: explicitLang,
    env: process.env.BRIDGE_LANG,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  });

  // One reader for the whole run, closed on every exit path — including Ctrl+C
  // and `process.exit`. Raw mode belongs to the console rather than to this
  // process, so without this the operator's shell is left with no echo and no
  // line editing after the wizard ends, which looks like a broken terminal.
  const terminal = new Terminal();
  ACTIVE_TERM = terminal;
  process.on("exit", () => terminal.close());

  /** EOF anywhere means "stop", not "keep asking". */
  const abort = (key) => {
    console.log("");
    sayLines(lang, key);
    process.exit(1);
  };

  console.log("");
  sayLines(lang, "banner.title");
  console.log("=".repeat(62));
  sayLines(lang, "banner.intro");
  console.log("");

  // --- prerequisite: dependencies -------------------------------------------
  //
  // First, because the wizard itself does not need them (it imports node
  // builtins and two dependency-free modules) but nothing downstream works
  // without them. Being runnable on a bare clone is the whole reason that is
  // true, and it is worth keeping that way.
  if (!existsSync(join(ROOT, "node_modules"))) {
    sayLines(lang, "dep.missing");
    const answer = await askPrompt(lang, "dep.ask");
    if (answer === null) abort("abort.eof");
    if (!/^n/i.test(answer.trim())) {
      console.log("");
      sayLines(lang, "dep.running");
      const npm = isWindows ? "npm.cmd" : "npm";
      const installed = spawnSync(npm, ["install"], { cwd: ROOT, stdio: "inherit", shell: isWindows });
      if (installed.status !== 0) {
        console.log("");
        sayLines(lang, "dep.failed");
        process.exit(1);
      }
    } else {
      sayLines(lang, "dep.skipped");
    }
  }

  // --- .env must exist before anything is written to it ---------------------
  //
  // Copied from the template so the operator keeps every explanatory comment,
  // then the two placeholder values are blanked at once. That second step is
  // the point: `.env.example` ships `sk-your-new-key-here`, which `preflight`
  // accepts as a well-formed key, so an abandoned first run would otherwise
  // leave a configuration that starts cleanly and fails at the first question.
  if (!existsSync(ENV_FILE)) {
    const template = join(ROOT, ".env.example");
    writeFileSync(ENV_FILE, existsSync(template) ? readFileSync(template, "utf8") : "", "utf8");
    writeEnvKey("DEEPSEEK_API_KEY", "");
    writeEnvKey("MCP_PATH_SECRET", "");
  }

  // --- [1/5] model and key --------------------------------------------------
  let providerBase;
  let providerModel;
  let apiKey;

  for (;;) {
    console.log("");
    sayLines(lang, "q.model.title");
    sayLines(lang, "q.model.explain");

    const provider = await askChoice(lang, [
      ["deepseek", t(lang, "q.model.option1")],
      ["custom", t(lang, "q.model.option2")],
    ]);
    if (provider === null) abort("abort.eof");

    providerBase = PROVIDER_PRESETS.deepseek.base;
    providerModel = PROVIDER_PRESETS.deepseek.model;

    if (provider === "custom") {
      const rawBase = await askUntil({
        lang,
        promptKey: "q.model.base",
        check: (value) => (looksLikeHttpUrl(value) ? null : { key: "q.model.baseBad" }),
      });
      if (rawBase === null) abort("abort.eof");
      // DeepSeek's own docs print the endpoint as `…/anthropic`, so people type
      // it. That layer is added by the harness (see `anthropicBase`), and
      // leaving it in would send every request to `…/anthropic/anthropic`.
      providerBase = rawBase.replace(/\/+$/, "");
      if (/\/anthropic$/i.test(providerBase)) {
        providerBase = providerBase.replace(/\/anthropic$/i, "");
        sayLines(lang, "q.model.baseStripped");
      }
      if (!providerBase) {
        sayLines(lang, "q.model.baseBad");
        continue;
      }

      const rawModel = await askUntil({
        lang,
        promptKey: "q.model.model",
        check: (value) => (value.trim() ? null : { key: "q.model.modelBad" }),
      });
      if (rawModel === null) abort("abort.eof");
      providerModel = rawModel;
    }

    // --- the key, and the one request that proves it ------------------------
    let retry = true;
    while (retry) {
      retry = false;
      const raw = await askUntil({
        hidden: true,
        lang,
        promptKey: "q.model.apikey",
        check: (value) => (value.trim() ? null : { key: "q.model.apikeyEmpty" }),
      });
      if (raw === null) abort("abort.eof");
      apiKey = raw;
      if (!keySummary(apiKey).looksDeepSeek) sayLines(lang, "q.model.apikeyShape");

      console.log("");
      sayLines(lang, "q.model.probing");
      const result = await probeModel({
        base: providerBase,
        override: parseEnvFile().BRIDGE_ANTHROPIC_BASE_URL,
        model: providerModel,
        key: apiKey,
      });

      if (probeUsable(result.code)) {
        sayLines(lang, "q.model.ok", { model: providerModel });
        break;
      }

      sayLines(lang, `q.model.${result.code}`, {
        status: result.status,
        detail: mask(result.detail),
        model: providerModel,
      });
      // The body is the only thing that distinguishes "bad model name" from
      // "bad request shape", and both arrive as 400. Through `mask` because it
      // is a string this process did not write: endpoints do quote the request
      // back, including its headers.
      if (result.detail && result.code !== "network") {
        sayLines(lang, "q.model.detail", { detail: mask(result.detail) });
      }

      console.log("");
      const choice = await askChoice(lang, [
        ["retry", t(lang, "q.model.retry1")],
        ["keep", t(lang, "q.model.retry2")],
        ["quit", t(lang, "q.model.retry3")],
      ]);
      if (choice === null || choice === "quit") abort("abort.cancel");
      if (choice === "keep") {
        sayLines(lang, "q.model.savedAnyway");
        break;
      }
      retry = true;
      // A retry re-asks the base URL and the model too, because a 404 is almost
      // always the address — offering only the key would trap someone in a loop
      // re-pasting a key that was never the problem.
      break;
    }
    if (retry) continue; // back to the top of [1/5]
    break;
  }

  writeEnvKey("DEEPSEEK_API_KEY", apiKey);
  writeEnvKey("DEEPSEEK_BASE_URL", providerBase);
  writeEnvKey("DEEPSEEK_MODEL", providerModel);
  sayLines(lang, "q.model.saved", { length: keySummary(apiKey).length });

  // --- [2/5] harness --------------------------------------------------------
  console.log("");
  sayLines(lang, "q.harness.title");
  sayLines(lang, "q.harness.explain");
  const claudeBin = findClaudeBin();
  if (claudeBin) {
    sayLines(lang, "q.harness.found", { path: claudeBin });
  } else {
    console.log("");
    sayLines(lang, "q.harness.missing");
    const answer = await askPrompt(lang, "q.harness.askPath");
    if (answer === null) abort("abort.eof");
    const typed = answer.trim().replace(/^["']|["']$/g, "");
    if (!typed) {
      sayLines(lang, "q.harness.skip");
    } else if (existsSync(resolve(typed))) {
      const path = resolve(typed);
      writeEnvKey("BRIDGE_CLAUDE_BIN", path);
      sayLines(lang, "q.harness.pathSaved", { path });
    } else {
      sayLines(lang, "q.harness.pathBad", { path: resolve(typed) });
    }
  }

  // --- [3/5] workspace roots -----------------------------------------------
  //
  // Asked before the tunnel, because it decides what is being published: with
  // an empty list the URL is a question-and-answer endpoint, and with a root in
  // it the URL is a shell on this machine. The two are not variations of the
  // same thing, and the operator should choose the first one deliberately.
  console.log("");
  sayLines(lang, "q.roots.title");
  sayLines(lang, "q.roots.explain");
  const rootsBefore = readRoots();
  const rootAnswer = await askPrompt(lang, "q.roots.ask");
  if (rootAnswer === null) abort("abort.eof");
  const typedRoot = rootAnswer.trim().replace(/^["']|["']$/g, "");
  if (!typedRoot) {
    // Enter means "I am not adding one", not "make it read-only". Saying
    // "staying read-only" over a `.env` that still lists three directories
    // would be a lie the operator has no way to catch — the roots list is not
    // shown anywhere else in this run, and append-never-replace is deliberate.
    if (rootsBefore.length > 0) sayLines(lang, "q.roots.keep", { roots: rootsBefore.join(" ; ") });
    else sayLines(lang, "q.roots.skip");
  } else {
    const root = resolve(typedRoot);
    const danger = dangerousRoot(root);
    if (danger) {
      sayLines(lang, "q.roots.danger", { path: root, what: danger });
    } else if (!existsSync(root)) {
      sayLines(lang, "q.roots.notfound", { path: root });
    } else {
      // Appended, never replacing: `.env` may already carry roots the operator
      // added with `ctl allow`, and a wizard run must not be how those vanish.
      const roots = readRoots();
      const already = roots.some((r) => resolve(r).toLowerCase() === root.toLowerCase());
      if (!already) writeRoots([...roots, root]);
      sayLines(lang, "q.roots.added", { roots: readRoots().join(" ; ") });
      sayLines(lang, "q.roots.warn");
    }
  }

  // --- [4/5] tunnel ---------------------------------------------------------
  console.log("");
  sayLines(lang, "q.tunnel.title");
  sayLines(lang, "q.tunnel.explain");
  const mode = await askChoice(lang, [
    ["quick", t(lang, "q.tunnel.option1")],
    ["named", t(lang, "q.tunnel.option2")],
  ]);
  if (mode === null) abort("abort.eof");

  if (mode === "quick") {
    writeEnvKey("TUNNEL_MODE", "quick");
    console.log("");
    sayLines(lang, "q.tunnel.quick");
  } else {
    console.log("");
    const host = await askUntil({
      lang,
      promptKey: "q.tunnel.host",
      check: (value) => (looksLikeHost(value) ? null : { key: "q.tunnel.hostBad", vars: { host: value.trim() } }),
    });
    if (host === null) abort("abort.eof");

    console.log("");
    sayLines(lang, "q.tunnel.tokenExplain");
    const token = await askUntil({
      hidden: true,
      lang,
      promptKey: "q.tunnel.tokenAsk",
      check: (value) =>
        value.trim().length >= 40 ? null : { key: "q.tunnel.tokenShort", vars: { n: value.trim().length } },
    });
    if (token === null) abort("abort.eof");

    const cleanHost = normalizeHost(host);
    writeEnvKey("TUNNEL_MODE", "named");
    writeEnvKey("TUNNEL_HOSTNAME", cleanHost);
    writeEnvKey("TUNNEL_TOKEN", token);
    console.log("");
    sayLines(lang, "q.tunnel.saved", { host: cleanHost });

    // The step that is not on this machine, and the reason a healthy named
    // tunnel can still 404. Said here, where the operator is still reading,
    // rather than left to be discovered in ChatGPT.
    const [sub, ...domainParts] = cleanHost.split(".");
    console.log("");
    sayLines(lang, "q.tunnel.dnsNote", {
      sub,
      domain: domainParts.join("."),
      port: parseEnvFile().PORT ?? "8787",
    });
  }

  // --- [5/5] approval mode --------------------------------------------------
  console.log("");
  sayLines(lang, "q.approval.title");
  sayLines(lang, "q.approval.explain");
  const approvalAnswer = await askPrompt(lang, "q.approval.ask");
  if (approvalAnswer === null) abort("abort.eof");
  const wantAuto = /^y(es)?$/i.test(approvalAnswer.trim());
  sayLines(lang, wantAuto ? "q.approval.on" : "q.approval.off");

  // Every question is asked; the rest of the run is starting things and printing
  // addresses. Hand the console back now rather than at exit, so the operator's
  // shell has its echo and line editing back during the long part — and clear
  // the reference, so a step that grew a question later would fail loudly
  // instead of waiting forever on a terminal nobody is reading.
  terminal.close();
  ACTIVE_TERM = null;

  // --- start ----------------------------------------------------------------
  console.log("");
  sayLines(lang, "start.title");

  const envNow = parseEnvFile();
  if (!envNow.MCP_PATH_SECRET || envNow.MCP_PATH_SECRET.length < 16) {
    writeEnvKey("MCP_PATH_SECRET", randomBytes(32).toString("hex"));
    sayLines(lang, "start.secret");
  }

  const problems = preflight();
  if (problems.length > 0) {
    sayLines(lang, "start.preflight");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.log("");
    sayLines(lang, "start.failed");
    process.exit(1);
  }

  const state = currentStatus();
  if (state.disabled) {
    sayLines(lang, "start.enable");
    cmdEnable();
  }
  if (state.running) {
    // `.env` is read once, at boot. Everything above just changed it.
    sayLines(lang, "start.reload");
    cmdReload();
  } else {
    sayLines(lang, "start.local");
    cmdStart();
  }

  console.log("");
  sayLines(lang, "start.tunnel");
  await cmdTunnel();

  console.log("");
  cmdUrl();

  if (wantAuto) {
    console.log("");
    sayLines(lang, "start.autoOn");
    // Deliberately after the server is up: `cmdAuto` refuses to write the flag
    // while nothing is running, because boot clears it — so doing this earlier
    // would report success and then silently do nothing.
    cmdAuto({ positional: ["on"], flags });
  }

  console.log("");
  console.log("=".repeat(62));
  sayLines(lang, "done.title");
  sayLines(lang, "done.steps");
  console.log("");
  sayLines(lang, "done.tools");
  console.log("");
  sayLines(lang, "done.later");
  console.log("");
  sayLines(lang, "done.safety");
  console.log("=".repeat(62));
}

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest);
const positional = rest.filter((a) => !a.startsWith("-"));

/**
 * The value of `--name value` or `--name=value`, or null.
 *
 * `positional` drops every dashed argument, which is right everywhere else and
 * wrong for the one flag that takes a value: `setup --lang en` would otherwise
 * leave a stray "en" in the positional list and lose the language.
 */
function flagValue(name) {
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === name) return rest[i + 1] ?? "";
    if (rest[i].startsWith(`${name}=`)) return rest[i].slice(name.length + 1);
  }
  return null;
}

switch (command) {
  case "setup":
    await cmdSetup({ lang: flagValue("--lang") });
    break;
  case "start":
    cmdStart({ foreground: flags.has("--foreground") || flags.has("-f") });
    break;
  case "stop":
    cmdStop();
    break;
  case "restart":
    cmdStop();
    cmdStart();
    break;
  case "reload":
    cmdReload();
    break;
  case "status":
    await cmdStatus();
    break;
  case "enable":
    cmdEnable();
    break;
  case "disable":
    cmdDisable();
    break;
  case "logs":
    cmdLogs();
    break;
  case "secret":
    cmdSecret();
    break;
  case "rotate":
    cmdRotate();
    break;
  case "tunnel":
    if (positional[0] === "check") await cmdTunnelCheck();
    else if (positional[0] === "named") await cmdTunnelNamed({ positional, flags });
    else await cmdTunnel();
    break;
  case "untunnel":
    cmdUntunnel();
    break;
  case "auto":
    cmdAuto({ positional, flags });
    break;
  case "url":
    cmdUrl();
    break;
  case "uninstall":
    cmdUninstall({ purge: flags.has("--purge") });
    break;
  case "allow":
    cmdAllow({ positional, flags });
    break;
  case "jobs":
    cmdJobs(positional[0], { trace: flags.has("--trace") });
    break;
  case "job":
    if (positional[0] === "kill") cmdJobKill(positional[1]);
    else {
      console.error("用法:npm run ctl -- job kill <id>");
      process.exit(1);
    }
    break;
  case "pending":
    cmdPending();
    break;
  case "approve":
    cmdDecide(positional[0], "allow");
    break;
  case "deny":
    cmdDecide(positional[0], "deny");
    break;
  case "audit":
    cmdAudit(flags.has("--all") ? 500 : 30);
    break;
  default:
    console.log(`modelbridge 生命周期管理

用法: npm run <命令>

  setup        首次安装向导:问模型 / API key / harness / 工作区 / 隧道 / 审批,
               然后写 .env、启动服务、开隧道、把 connector 地址给你
  setup --lang en|zh   向导用哪种语言(默认跟系统语言,认不出就用英文)

  start        后台启动服务(已运行时无操作)
  start --foreground   前台启动,便于调试
  stop         停止服务和隧道
  restart      重启服务(隧道若在跑会一起停掉,需重新 tunnel)
  reload       只重启服务,不动隧道 —— 公网 URL 不变,改了代码或 .env 后用这个
  status       查看启用状态、进程、审批模式、本地与公网端点
  logs         查看最近 40 行日志
  url          把完整的公网 URL 复制到剪贴板(省得手抄一长串)
  auto         查看当前审批模式
  auto on      完全放行:命令允许名单与工作区边界失效(重启自动恢复)
  auto off     恢复「需要批准」
  tunnel       启动 Cloudflare 隧道,打印可填进 ChatGPT 的公网 URL
  tunnel check 检查固定隧道的配置,并说清 Cloudflare 那边还差什么
  tunnel named <域名>   改用固定域名(引导你走完 Cloudflare 的步骤)
  untunnel     只停隧道,服务继续跑
  enable       解除停用
  disable      停用并停止服务
  secret       生成并写入 MCP_PATH_SECRET(会同步更新 .env)
  rotate       换一个 MCP_PATH_SECRET,只重启服务,并把新的完整 URL 放进剪贴板
  allow        看子代理能在哪些根目录下工作
  allow "D:\项目"            把一个项目加进白名单(写 .env 并 reload,URL 不变)
  allow --remove "D:\项目"   从白名单移除
  uninstall    停止服务并清除本地状态(并提示如何移除 ChatGPT connector)

端点里的密钥默认隐藏成 <密钥已隐藏> —— 每打印一份就多一处留存(终端历史、
shell 转录、粘到别处的排障记录)。确实要打印时,在命令后加 --show。

子代理任务:

  jobs                     列出所有任务:状态 / 步数 / 耗时 / 验证码
  jobs <id> --trace        看某个任务的完整轨迹(第几步调了什么工具)
  job kill <id>            取消一个正在跑的任务(连同它的子进程)
  pending                  列出正在等你批准的命令
  approve <id>             批准一条命令,任务继续
  deny <id>                拒绝一条命令,任务会收到拒绝原因
  audit                    看最近的审批记录(--all 看全部)
`);
    process.exit(command ? 1 : 0);
}
