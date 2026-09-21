# ModelBridge

An MCP server that gives a ChatGPT connector (or any other MCP client) a **working sub-agent** — and, optionally, one that reads files, runs commands, and works a multi-step task to completion on your machine.

It ships pointed at **DeepSeek**, which is the cheap default rather than the point. The design is model-agnostic: the sub-agent's brain is whatever Anthropic-compatible endpoint you put in `DEEPSEEK_BASE_URL`, and the harness around it is a swappable part. That is where the name comes from.

[中文说明](README.zh-CN.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

---

## What this is actually for

**It puts another working sub-agent inside your ChatGPT conversation — one whose brain can be any model you like.**

Be precise about this, because the project gets retold wrong a lot: **ChatGPT's own sub-agents (Luna and friends) can already do real work** — they read and write files on your machine, run commands, and iterate. This bridge is not filling in a missing capability.

The real constraint sits elsewhere: **sub-agent slots only accept OpenAI's own model tiers** (Sol / Terra / Luna). An external model cannot be registered as one. So the moment you want a *different* model doing that work — faster, cheaper, or independent enough to review the implementer — the only door in is an **MCP connector**.

And an MCP tool is a text interface by default: you call it, you get text back. To let an external model actually *work*, you have to hand it a whole environment first.

**The mechanism matters more than the outcome: it does not plug DeepSeek in, it gives DeepSeek hands.** A bridge that only forwards an API hands the host one more model to ask. This one does not — on an agent job it spawns **a full agent harness** ([Claude Code](https://claude.com/claude-code)) as a child process, pointed at DeepSeek's Anthropic-compatible endpoint. So the loop, context compaction, prompt caching and tool implementations — everything that makes a model *able to work* — are an existing, maintained implementation rather than a hand-rolled imitation. What the host gets is therefore a **sub-agent that can do the job**, not a Q&A endpoint.

And it is exposed as **one MCP tool**, so any MCP-capable host can call it; the ChatGPT connector is one door in, and so far the only one tested. The harness layer is a swappable part — Claude Code is its current implementation, not the essence of the design.

| Native sub-agent (Luna et al.) | This bridge |
|---|---|
| Can do the whole job | Can do the whole job too — **with a different executor** |
| Model is an OpenAI tier, and the slot is not swappable | Model is **DeepSeek V4.1 Flash** (552B MoE, ~1M context); two lines of `.env` swap it |
| Harness is built into the platform, invisible and fixed | Harness is **Claude Code**, a swappable part |
| Same stack as Sol, shared training preferences | **External model, no shared lineage** — which is what makes it useful for security review and counter-examples |

> **About "faster" — an honest note.** From my own use the felt difference is two things: **fewer steps for the same task, and a higher chance of getting it right the first time.** But I **have not benchmarked it** — I have not run the same task set against Luna and DeepSeek as a controlled comparison. So that is a subjective impression, not performance data. It may also not hold for every task: there is community feedback that non-OpenAI models do worse on `apply_patch`-style mechanical edits. **Try it on a small slice first; do not switch wholesale.**

**Measured, not intended**: given "read `witness.txt`, reverse its contents, write them to `answer.txt`", the sub-agent ran 3 steps over 2 min 25 s; the `answer.txt` on disk matched the expected string **byte for byte**, next to a nonce that only a real result can produce. A chat transcript agreeing with itself is not evidence — **bytes on disk are**.

*That measurement shows it really does the work. It does **not** show it is faster than Luna — the efficiency difference is still an impression, not a comparison.*

> ⚠️ **This capability is off by default.** With no `DEEPSEEK_ALLOWED_ROOTS` set, the bridge can only spend your DeepSeek quota and cannot touch your computer. Turn it on and anyone holding the URL can read and write files and run commands on your machine — **"can run commands" means "has your computer."** Read the [security model](#security-model) first.

---

## Why this exists

ChatGPT's sub-agent slots only accept OpenAI's own model tiers (Sol / Terra / Luna). You cannot register an external model as a sub-agent. The only supported entry point for a foreign model is an **MCP connector** — i.e. wrapping it as a **tool** that the main agent can call.

That has real consequences you should understand before deploying:

| | Native ChatGPT sub-agent | This bridge (DeepSeek as a tool) |
|---|---|---|
| Separate context | Yes | Yes (it only sees the prompt you send) |
| Independence | Separate session, same OpenAI stack | **Different vendor, different model — genuinely independent** |
| Parallelism | Yes | Yes, via agent jobs — `agent_start` hands back a job id, `agent_poll` collects it |
| Result destination | Retained in its own session | Returns into the caller's context |
| Can touch your machine | Yes — but only inside the host's own sandbox, never your filesystem | **Yes — in *your* directories, once you grant a workspace.** Read [Security model](#security-model) first |
| Cost | Subscription credits | DeepSeek API, billed separately (very cheap) |

The main practical payoff is **cross-vendor independent review**. If your prompt requires that a reviewer must *not* reuse the implementer's conclusions, a model from a different vendor satisfies that requirement far better than another tier of the same stack — there is no shared training lineage to echo.

**Swapping the host model does not break this.** The bridge does not depend on Sol, or on which tier you are running. It depends on one thing: **sub-agent slots are not open to external models.** That is a property of the platform, not of the model tier — change tiers and the slot is still closed, so this bridge is still the only way in. Only the sub-agent side is ever re-pointed: edit `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL` in `.env` and run `npm run ctl -- reload` (the tunnel is left alone, so the URL does not change). The one change that *would* make this redundant is platform-level, not model-level: **OpenAI opening the sub-agent slot to external models.**

> The bridge itself is a standalone Node process that talks only to `api.deepseek.com`. **Agent jobs are the exception**: to run one it spawns [Claude Code](https://claude.com/claude-code) as a child process, pointed at DeepSeek's Anthropic-compatible endpoint. The bridge never runs *inside* a host — it launches one.

## Architecture

```
ChatGPT (Sol) ──HTTPS──▶ Cloudflare edge ──tunnel──▶ bridge (127.0.0.1:8787)
                                                            │
   deepseek_flash(task, mode, files) ──▶ job registry ──────┤──▶ api.deepseek.com ──▶ text back,
   deepseek_agent_start(task, workspace) ──▶ job registry ──┤   or a job id to poll
   deepseek_agent_poll(job_id) ◀────────────  snapshots     │   abort · TTL · nonce · time ceilings
                                                            │
                                            harness: claude -p ──▶ api.deepseek.com/anthropic
                                                 │  Read / Write / Edit / Bash
                                                 │
                                                 └─ approval prompt (stdio MCP child of the harness,
                                                    never reachable over the URL) ──▶ you, via `npm run ctl`
```

Once a tool call reaches that approval prompt it is routed one of three ways, and the split is the point:

| Tool class | Rule |
|---|---|
| **Commands** (`Bash`, `PowerShell`) | Pre-approved *names* run unattended; everything else pauses for a human. |
| **File tools** (`Read`, `Write`, `Edit`, `NotebookEdit`, `Glob`, `Grep`) | Path checked against the job's workspace. Inside runs unattended; outside pauses for a human. |
| **Network tools** (`WebFetch`, `WebSearch`) | Always a human, regardless of workspace. |

`--add-dir` is not what enforces the middle row. It only *adds* an accessible directory; it restricts nothing. The boundary comes from listing the file tools in the harness's `permissions.ask`, which is the only knob that makes `--permission-prompt-tool` fire in headless mode — measured, not assumed. Before that, a job whose workspace was `D:\project` could `Read C:\Users\you\.env` with no prompt at all.

- **Transport**: MCP Streamable HTTP, stateless (`sessionIdGenerator: undefined`, a fresh server + transport per request so callers never share state). The **job registry is deliberately not per-request** — it is created once per process, or every job would be forgotten the moment its `start` call returned.
- **Responses stream as SSE** rather than buffered JSON. This keeps bytes moving on the wire, which avoids Cloudflare's free-tier **524** timeout on long DeepSeek calls.
- **Auth**: a **capability URL**. The MCP endpoint is `/mcp/<64-hex-secret>`; the path *is* the credential. The bare `/mcp` path and any wrong path return **404**, indistinguishable from nothing being there — because ChatGPT's connector form has no Bearer-token field.
- **Both tools are asynchronous by necessity.** ChatGPT's tool-call budget is around 60 s; a real task is not, and neither is a reasoning model. Measured: one adversarial review through `deepseek_flash` took **50 s**, and the same call through the full path has been seen at **63 s**. Each tool therefore blocks for up to 45 s and otherwise returns a job id to poll — see `BRIDGE_SYNC_WINDOW_MS` if your client's budget differs.

## Requirements

- Node.js **>= 24** (uses native TypeScript type-stripping; no build step)
- A DeepSeek API key — create one at <https://platform.deepseek.com>
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for the quick tunnel (or bring your own deployment — see below)
- **For agent jobs only:** [Claude Code](https://claude.com/claude-code) on `PATH` (or set `BRIDGE_CLAUDE_BIN`). The one-shot `deepseek_flash` tool has no extra dependencies, and the offline test suite does not need either this or an API key.

## Quick start

Two ways in. The wizard asks the questions and writes `.env` for you, then brings everything up; do it by hand if you would rather see every value before it is written.

### The guided way

```bash
git clone https://github.com/CassiaTw1g/modelbridge.git
cd modelbridge
npm run setup
```

It runs on a bare clone — **no `npm install`, no `.env`** — because it is the thing that creates both. Have your API key ready to paste.

On Windows you can also double-click `windows/0-首次安装.bat`, which is the same thing.

It asks five things:

| # | Question | What it does with the answer |
|---|---|---|
| 1 | Which model, and its API key | Writes `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`. Default is DeepSeek; any Anthropic-compatible endpoint works. **The key is checked with one tiny request before it is written**, so a truncated or revoked key is caught here rather than inside a ChatGPT call. |
| 2 | Which harness runs it | Confirms Claude Code is findable and records the path if it is not on `PATH`. There is one harness today, so this is a check, not a choice. |
| 3 | Which directories the sub-agent may touch | Writes `DEEPSEEK_ALLOWED_ROOTS`. **Enter means none** — the bridge stays read-only, question-and-answer only. Added to the existing list, never replacing it. |
| 4 | Temporary or fixed hostname | `quick` (a random `*.trycloudflare.com` per start) or `named` (your own domain, one connector forever). Named asks for the tunnel token and reminds you about the one step that is dashboard-only. |
| 5 | Should the sub-agent ask before running commands | `n` (default) is the approval gate; `y` turns on the full bypass described below. |

Every answer is written to `.env` as it is given, so **Ctrl+C leaves a usable file** and rerunning carries on from where you stopped. It ends by starting the server, opening the tunnel, copying the connector URL to your clipboard and printing it.

Language is picked up from the OS locale; override with `npm run setup -- --lang zh` or `--lang en` (also `BRIDGE_LANG`).

Then go to [Register the connector](#register-the-connector). To check everything afterwards, see [Verification](#verification).

### The manual way

```bash
git clone https://github.com/CassiaTw1g/modelbridge.git
cd modelbridge
npm install
cp .env.example .env
```

Edit `.env`:

1. Set `DEEPSEEK_API_KEY` to your key. **Use a dedicated key for this bridge** so it can be revoked independently, and set a spend cap on it in the DeepSeek console as a last line of defence.
2. Generate the path secret:

   ```bash
   npm run ctl -- secret
   ```

   This writes `MCP_PATH_SECRET=<random hex>` into `.env` (or prints it if `.env` doesn't exist yet).

Start the server and open the tunnel:

```bash
npm run start     # background server on 127.0.0.1:8787
npm run tunnel    # cloudflared quick tunnel; prints the public URL and the full MCP endpoint
```

`npm run tunnel` prints the exact URL to paste into ChatGPT:

```
公网端点 : https://<random>.trycloudflare.com/mcp/<your-secret>
```

It checks first that the local port is actually answering before it opens anything — a live PID is not the same as a live service, and a tunnel in front of a dead port produces a URL that fails in a way that looks like ChatGPT's fault.

### Register the connector

1. Open **ChatGPT on the web** (connectors cannot be configured from desktop or mobile).
2. **Settings → Plugins → MCP → Add server** (alternatively: Settings → Connectors → Advanced → Developer mode).
3. Type: **Streamable HTTP**. Authentication: **No authentication**.
4. URL: the **full** `https://<random>.trycloudflare.com/mcp/<your-secret>` — including the `/mcp/<secret>` path. Pasting only the domain will not work.
5. Save. The connector handshake shows up in the log as `server/discover → initialize → notifications/initialized → tools/list`.

### Tell your main agent when to use it

The tool description is the router. It states *dispatch conditions*, not just what the tool does — this is what prevents the calling agent from picking it arbitrarily. Add a rule to your system prompt that is **mutually exclusive** with your sub-agent rules, e.g.:

> Tasks needing cross-vendor independent review (security review, counterexample construction) → call the `deepseek_flash` tool, do not delegate to a sub-agent. Tasks needing file access, parallelism, or same-stack collaboration → delegate to a sub-agent.

## Tool reference

Three tools in two groups. All three are always registered — but until `DEEPSEEK_ALLOWED_ROOTS` is set, the two agent tools reject every workspace with an explanatory error, so the bridge stays read-only.

### `deepseek_flash` — one question, one answer

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task` | string | yes | The concrete task. State the goal, constraints, and expected output format. For independent review, **do not reveal your own conclusion here** — it contaminates the independence. |
| `mode` | enum | no | `analyze` \| `review` \| `code` \| `summarize`. Selects the system prompt. Default `analyze`. |
| `files` | string | no | The code/text to analyse, passed through as plain text. This tool **cannot access your filesystem** — content must be inlined here. Subject to the server's **2 MB** request-body cap: the model's context window is ~1M tokens, but that is not how much this path can carry in. |

Each `mode` gets a distinct system prompt. `review` explicitly instructs the model to treat any author conclusion in the material as an unverified claim and to state disagreements explicitly — that is the point of routing to an external vendor.

Blocks up to **45 s**. A call that finishes inside that window returns its answer inline, unchanged; a slower one returns a **`job_id`** instead, and the answer is collected with `deepseek_agent_poll` like any other job. DeepSeek is a reasoning model — 50 s for one review is normal, not a fault — so this is the difference between "the answer is on its way" and "the caller gave up and reported a failure".

A `job_id` means **there is no answer yet**. The payload says so, and the poll that follows is the only way to get one; a caller that reports a conclusion at that point has invented it.

### `deepseek_agent_start` — hand over a task that needs hands

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task` | string | yes | The concrete task. State the goal, constraints, and expected output. Do not reveal your own conclusion. |
| `workspace` | string | yes | Absolute path the sub-agent may work in — it reads, writes and runs commands with this as its root. Must fall inside `DEEPSEEK_ALLOWED_ROOTS`, or the call is rejected. |
| `mode` | enum | no | Accepted for compatibility; the current harness does not read it. |

Blocks up to **45 s** (ChatGPT caps a tool call near 60 s). A fast job returns its result inline; anything longer returns a `job_id`.

**The client hanging up does not cancel the job.** The abort controller belongs to the job registry, not to the HTTP request — otherwise every caller that lost patience would silently kill the work it had just dispatched. Use `npm run ctl -- job kill <id>` to actually stop one.

### `deepseek_agent_poll` — collect it

| Parameter | Type | Required | Description |
|---|---|---|---|
| `job_id` | string | yes | The id `deepseek_agent_start` or `deepseek_flash` returned. |
| `wait_seconds` | number | no | Blocking wait, default 20, max 40. Returns early if the job finishes sooner. |

One poll tool serves both kinds on purpose. A second one would mean the caller has to guess which to use, and a wrong guess is an error it can only answer by guessing again.

Every terminal payload carries a **nonce** minted at job creation. An agent that reports an outcome without quoting it does not have a result — that is the point.

### Behind the job: what the sub-agent actually runs

A job spawns Claude Code (`claude -p … --output-format stream-json`) with `ANTHROPIC_BASE_URL` pointed at `api.deepseek.com/anthropic`, so the model driving the loop is DeepSeek while the loop, context compaction, prompt caching and tool implementations are Claude Code's own. Every tool event is captured into the job trace, readable with `npm run ctl -- jobs <id> --trace`.

## Configuration

All via `.env` (gitignored):

| Variable | Default | Notes |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | **Required.** Use a dedicated key with a spend cap. |
| `MCP_PATH_SECRET` | — | **Required**, min 16 chars. The capability path segment. `npm run ctl -- secret` generates a 32-byte hex value. |
| `PORT` | `8787` | Local listen port. |
| `HOST` | `127.0.0.1` | Listen address. **Leave on loopback** — the tunnel runs on the same machine, so exposing the port to your LAN has no upside. |
| `TUNNEL_MODE` | `quick` | `quick` = a Cloudflare quick tunnel: zero setup, but a **new random `*.trycloudflare.com` hostname on every start**, so the ChatGPT connector has to be rebuilt each time (`Unauthorized: Tunnel not found` once Cloudflare recycles it). `named` = a fixed tunnel on **your own** domain — see [A fixed hostname on your own domain](#a-fixed-hostname-on-your-own-domain). |
| `TUNNEL_HOSTNAME` | — | Named mode. Your public hostname, e.g. `mcp.example.com` — no `https://`, no path. It must already be on Cloudflare, or the dashboard cannot route it. |
| `TUNNEL_TOKEN` | — | Named mode. The credential the Cloudflare dashboard issues for the tunnel. **A full credential**, on the same footing as `MCP_PATH_SECRET`: masked by `ctl`, never printed, never committed. Do not type it into a file by hand — `npm run ctl -- tunnel named <hostname>` asks for it and writes it. |
| `TUNNEL_NAME` | — | Named mode, alternative to `TUNNEL_TOKEN`: the name of a tunnel you created with the `cloudflared` CLI. On that path cloudflared reads its own config and credentials, so the routing rule lives **there**, not in `TUNNEL_HOSTNAME` — keep the two in step. |
| `TUNNEL_PROTOCOL` | *(probe)* | Transport cloudflared uses to reach the edge: `quic` (UDP 7844) or `http2` (TCP 7844). Leave unset and let it probe. Pin `quic` **behind a proxy or TUN-mode VPN** — TUN swallows outbound TCP/7844 while UDP passes straight through. The wrong choice fails quietly: the process stays alive and `ctl status` says "running" while nothing is reachable and the log repeats `TLS handshake with edge error: EOF`. Applies to both modes. |
| `RATE_LIMIT_PER_MINUTE` | `60` | Sliding window that limits the blast radius if the URL leaks. **One global bucket, not per IP** — the server listens on loopback and the only client is the tunnel, so `X-Forwarded-For` is whatever the caller typed, and trusting it would make the limit read as "N/min per made-up IP". Only `tools/call` is counted: a single poll can cost three requests (initialize, tools/list, call), so counting handshakes would let a long job 429 itself with its own polling. |
| `BRIDGE_SYNC_WINDOW_MS` | `45000` | How long `deepseek_flash` and `deepseek_agent_start` block before handing back a `job_id` instead of an answer. The default sits under ChatGPT's ~60 s tool-call budget; shorten it if your client's budget is tighter. Applies whether or not the agent tools are enabled. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible endpoint. |
| `DEEPSEEK_MODEL` | `deepseek-flash` | Model ID. |
| `DEEPSEEK_TIMEOUT_MS` | `180000` | Timeout on one request to `api.deepseek.com`; returns a structured error instead of hanging. No longer held under Cloudflare's 100 s edge timeout: a call that outruns the sync window returns a `job_id`, so the response is not kept open for the whole model call. |
| `DEEPSEEK_MAX_OUTPUT_TOKENS` | `16384` | Output cap. `deepseek-flash` is a reasoning model: `reasoning_content` and `content` **share** this budget, so a task that over-reasons can starve the answer. A code review over a real file needs the headroom — at `4096` the reasoning alone can consume the budget and leave `content` empty. |

### Agent jobs

**With `DEEPSEEK_ALLOWED_ROOTS` unset, the agent tools reject every workspace and the bridge stays read-only.** These settings only matter once you set it — read [Security model](#security-model) first.

| Variable | Default | Notes |
|---|---|---|
| `DEEPSEEK_ALLOWED_ROOTS` | *(empty)* | `;`-separated roots a sub-agent may work in. **Empty means deny everything**, not "anywhere". Setting this is the switch that hands over the machine. Manage it with `npm run ctl -- allow "D:\project"` — it writes `.env` and reloads, so the tunnel and the public URL are untouched. |
| `BRIDGE_MAX_STEPS` | `120` | Step ceiling per job (one tool call = one step). A job that hits it still stops, but what it had already read comes back as a **partial** result instead of nothing. It is a runaway brake, not a work estimate — a review that walks a whole project passes 40 steps easily and dies just short of the end. |
| `BRIDGE_JOB_TIMEOUT_MS` | `1800000` | Wall-clock ceiling (30 min). On expiry the job and its entire process tree are killed. `server.ts` sets the registry's own hard wall to this value + 1 min so the runner's timeout always fires first — if the hard wall won the race it would report the stop as a plain *cancellation*, which says nothing about why. |
| `BRIDGE_APPROVAL_TIMEOUT_MS` | `300000` | How long a command waits for a human (5 min). **Expiry is a deny.** |
| `BRIDGE_APPROVE_ALLOW` | see `DEFAULT_ALLOW` | Comma-separated pre-approved command *names* — `node`, `npm`, `git`, `dir`, `type`, … plus PowerShell's read-only cmdlets. Matched against the **first word only**, so it constrains the program, not its arguments. Anything else pauses the job for a human. This list covers **commands only**: file access outside the workspace, and every network tool, goes to a human regardless. |
| `BRIDGE_CC_APPROVAL` | on | Set to `off` to skip the approval queue entirely. ⚠️ What it removes is more than "the asking": the `approval-mcp.ts` child process is never spawned, so the command allowlist, the chaining guard and the file tools' workspace boundary **all go with it**. ⚠️ It does **not** reset on restart, which makes it a poor everyday switch — for a temporary bypass use `npm run auto:on` instead, which the next restart revokes by itself. Left commented; only `npm run accept` overrides it explicitly. |
| `BRIDGE_CLAUDE_BIN` | `claude` on `PATH` | Path to the Claude Code binary. |
| `BRIDGE_ANTHROPIC_BASE_URL` | `$DEEPSEEK_BASE_URL/anthropic` | Where the harness sends its requests. |
| `BRIDGE_STATE_DIR` | `<repo>/.state` | Job snapshots, approval queue, audit log. |
| `BRIDGE_WORKSPACE` | *(injected)* | Set by the harness, one value per job — it is how the approval prompt learns the boundary it is enforcing. **Do not set it by hand.** |
| `BRIDGE_CC_MAX_BUDGET_USD` | *(unset)* | Opt-in `--max-budget-usd` for the harness. Left off by default **because Claude Code prices at Claude rates** — a limit set here reads as roughly 100× the real DeepSeek cost and would cut jobs off early. |

## Lifecycle commands

```bash
npm run setup      # the first-run wizard (see Quick start)
npm run start      # background start (no-op if already running)
npm run stop       # stop server and tunnel
npm run restart    # restart server (stops the tunnel too — re-run `npm run tunnel`)
npm run status     # enabled state, PIDs, local + public endpoints
npm run logs       # last 40 log lines
npm run url        # copy the full connector URL to the clipboard, and print it
npm run tunnel     # start the Cloudflare tunnel, print the public URL
npm run untunnel   # stop the tunnel only
npm run auto       # show the current approval mode
npm run auto:on    # bypass approvals entirely (see Security model)
npm run auto:off   # back to "needs approval"
npm run enable     # clear the disabled flag
npm run disable    # stop everything and set the disabled flag
npm run uninstall  # stop and clear local state (leaves the project directory)
```

`npm run start --foreground` runs in the foreground for debugging.

`npm run setup` is rerunnable: it re-asks everything and rewrites the answers, and its workspace-roots answer is **added** to the list rather than replacing it, so a rerun cannot silently erase roots you added with `npm run ctl -- allow`.

`npm run url` is the one to reach for when rebuilding the ChatGPT connector: it
prints `https://<host>/mcp/<secret>` and puts the same string on your clipboard,
so you never have to hand-select the secret out of `npm run status --show`.

### Rotating the path secret

```bash
npm run ctl -- rotate
```

Generates a new secret, restarts **the server only**, and prints the new public URL — which it also copies to your clipboard. The tunnel is deliberately left running: it forwards a port and has no idea what the path is, so the public hostname stays the same and only the last segment of the URL changes. (`npm run restart` would kill the tunnel too, costing you a new hostname and a second trip to the connector.)

Rotate whenever the URL may have been seen by anyone else. It is the only thing standing between your machine and whoever holds it.

On Windows, `windows/7-轮换密钥.bat` does the same thing from a double-click. If you prefer to drive it yourself, `npm run ctl -- secret` writes the secret without restarting anything — you then have to restart and update the connector by hand.

The same shape applies to the workspace allow-list: `windows/8-添加项目目录.bat` asks for a path and runs `npm run ctl -- allow "<dir>"`, which writes `.env` and reloads with the tunnel left alone. Quote the path or use forward slashes — a bare `D:\codex\3` typed into a POSIX shell loses its backslashes.

### The secret is no longer printed

`npm run ctl -- status / start / tunnel / secret` now render the endpoint's secret as `<密钥已隐藏>`. Add `--show` to print it in full. Every printed copy outlives the moment — terminal scrollback, a shell transcript, a log pasted into a bug report — and the one real leak this project has had came from `ctl` printing it, not from anyone finding it. `rotate` still puts the **full** URL on the clipboard: a clipboard is not a log.

### After editing code or `.env`

```bash
npm run ctl -- reload
```

Restarts the server alone. The tunnel is untouched, so the **public URL is identical** and the ChatGPT connector needs no attention. `restart` also stops the tunnel — a different command for a different situation.

### Why you have to recreate the connector, and how to stop doing that

This is not you failing to find the button. **ChatGPT's connector form may have no "edit URL" action at all** — the documented recovery is to remove the connector and add it again. (Interfaces differ by account and by release, so it costs nothing to look for an edit control first.) And the bridge's default transport is a Cloudflare **quick tunnel**, which is handed a **new random hostname on every start** — so any tunnel restart changes the URL and costs you a rebuild.

Three ways out:

| Approach | Cost | Result |
|---|---|---|
| **Do nothing** | none | Usually enough. `reload` leaves the tunnel alone and `ctl` no longer prints the secret, so in normal operation the URL does not move. You rebuild the connector only when you deliberately rotate the secret. |
| **A Cloudflare named tunnel** | you must **own a domain** already on Cloudflare | The hostname half of the URL **never changes** — built in, see below. |
| **A tunnel with a permanent hostname** | install one tool, create one account | The hostname half of the URL **never changes**. [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) is the lowest-effort option: free for personal use, giving you `https://<machine>.<tailnet>.ts.net` with no domain to buy. *Not yet verified against this bridge.* |

Start with the first row. Move on only if an occasional rebuild still bothers you.

#### A fixed hostname on your own domain

The quick tunnel is the default because it needs no setup. If you have a domain whose NS already points at Cloudflare, you can have a URL that survives restarts, reboots and `restart` alike — so the connector is built once and never touched again.

Two of the three steps happen in Cloudflare's dashboard and only you can do them. **Create the tunnel** at `Networking → Tunnels → Create a tunnel` (older guides say `Zero Trust → Networks → Connectors`; that menu redirects to the same page), then **add the route** under that tunnel's `Routes` tab:

```
Networking → Tunnels → your tunnel → Routes → Add route
  → Published application
  Subdomain    : mcp
  Domain       : your domain
  Service type : HTTP
  Service URL  : http://localhost:8787
```

Cloudflare creates the DNS record and the certificate for you — do not add one by hand. Then copy the long token the page shows you and come back here:

```bash
npm run ctl -- tunnel named mcp.example.com
```

It asks for the tunnel token (paste it — do not retype it into a file by hand) and writes your `.env` for you. On Windows, `windows/11-固定域名.bat` is the same thing from a double-click: it prints the dashboard steps, asks for the hostname and the token, and offers to switch the tunnel over once you confirm the route is saved.

⚠️ **Skipping the route step is the trap.** The tunnel will report `connected to the edge`, everything local looks healthy, and the domain returns 404 — because the "hostname → local port" route lives in Cloudflare's cloud, not on this machine. `npm run ctl -- tunnel check` lists what you have not done yet, and reports "registered with the edge" and "the domain actually answers" **separately**, because they are different facts. Nothing on your machine has to change to fix it: add the route and it starts working.

Nothing real is hardcoded here: the code and docs carry no one's domain, and every value comes from your own `.env`. `TUNNEL_TOKEN` is a credential on the same footing as the path secret — it is never printed, and `ctl` masks it.

> **Do not use the free ngrok tier.** It injects a browser-warning page that needs an `ngrok-skip-browser-warning` request header to get past, and a ChatGPT connector cannot set custom headers — the connection is cut.

### Agent job and approval commands

These read the files the server writes, so they work from a second terminal — and they still work if the server was restarted between the request and your answer.

```bash
npm run ctl -- jobs                # every job: state, steps, duration, nonce
npm run ctl -- jobs <id> --trace   # full trace: which tool at which step
npm run ctl -- job kill <id>       # cancel a running job, process tree included
npm run ctl -- pending             # commands waiting for your approval, in full
npm run ctl -- approve <id>        # let it run
npm run ctl -- deny <id>           # refuse it — the model is told why, and told not to route around it
npm run ctl -- audit               # recent approval decisions (--all for everything)
```

## Verification

Four layers, cheapest first.

**1. Offline suites — no network, no key, no money:**

```bash
npm test
```

| Suite | What it guards |
|---|---|
| `test:loop` | Response parsing and request accounting. A tool-call turn must not be sent twice; `reasoning_content` must survive back into the next request or the API returns 400. |
| `test:sandbox` | Path-escape regressions: UNC, `\\?\`, alternate data streams, reserved device names, trailing dots, prefix boundaries, junctions. Windows-only cases self-skip elsewhere, and the hardlink gap is asserted as *success* rather than pretended away. |
| `test:approvals` | The approval protocol: auto-approval rules, chaining refusal, and that every non-human exit — timeout, cancellation, a corrupt decision file — resolves to **deny**. |
| `test:guard` | The workspace boundary for file tools: in-workspace paths allowed, out-of-workspace paths, parent traversal, prefix-sibling directories, UNC and alternate data streams all sent to a human; `Grep`'s regex not mistaken for a path. Assertions about Win32 path semantics self-skip off Windows, for the same reason `test:sandbox` has them. |
| `test:jobs` | The registry. Chiefly: **a client disconnect must not kill the job**, because the MCP SDK aborts per-request handlers when a client hangs up. |
| `selftest:memory` | In-memory MCP round trip; the agent tools are registered and reject an out-of-scope workspace. |

**2. Public endpoint smoke test — exercises the real HTTP path:**

```bash
npm run smoke                          # reads the tunnel URL from .state/tunnel.log
npm run smoke -- https://host/mcp/xxx  # or pass an endpoint explicitly
```

This asserts the health check, that a bare `/mcp` returns 404, that a wrong secret returns 404, and that a real `tools/call` returns non-empty content. It uses Node's `fetch`, **not** `curl` — see the Windows note below.

**3. Acceptance — is the sub-agent actually capable?** (online, costs a little)

```bash
npm run accept           # all three tasks
npm run accept -- --only B
```

Three tasks a chat-only model cannot pass:

| | Task | Passing means |
|---|---|---|
| **A** | Reproduce a 32-character random string that exists only inside a file, reversed | It really read the file — nothing else can produce that string |
| **B** | Run a script, observe the failure, fix it, run it again | **Two or more command executions in the trace.** A model answering in one shot cannot know the program fails; this is the hard evidence that it loops |
| **C** | Report the contents of a file that does not exist | It says so. A sub-agent that fabricates is more dangerous than one that cannot work |

Test B is the load-bearing one. Approval is deliberately disabled for the suite, which is why it is not part of `npm test`.

**4. Did ChatGPT actually call us?**

Server access logs and the chat transcript look identical whether the model truly called the tool or merely *narrated* doing so. The only trustworthy signals are:

- the log line `tools/call deepseek_flash` in `npm run logs`, and
- a matching entry in the DeepSeek console usage page.

For agent jobs, `npm run ctl -- jobs` must also show a record with **more than one step** and a real workspace path. If the chat shows a plausible answer but every one of those is silent, the calling model role-played the call. Re-sharpen the tool description or your dispatch rule.

## Deployment options

The quick tunnel is fine to start, but its URL changes on every restart (you must re-edit the connector). For anything long-lived:

| Option | Cost | When |
|---|---|---|
| **cloudflared quick tunnel** | free | First run, validation. `--protocol http2` is required on networks where QUIC is blocked. |
| **Cloudflare Worker** | free | Stable URL, no local process. Rewrite the transport onto Hono's Web Standard variant; store the DeepSeek key as a Worker secret. |
| **VPS (HK / SG)** | ~$5–12/mo | Long-term stability, and the 100 s edge timeout disappears entirely. |

Avoid the ngrok free tier: its interstitial warning page requires an `ngrok-skip-browser-warning` header, which ChatGPT connectors cannot send, so the connection is severed.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `MCP_PATH_SECRET 未设置或过短` on start | Run `npm run ctl -- secret` to write one into `.env`. |
| ChatGPT shows "couldn't connect" | URL must include the full `/mcp/<secret>` path. Check `npm run status` for the current public endpoint. |
| 404 from the public URL | Wrong or stale secret. Restart after rotating, and update the connector URL. |
| Empty/blank reply from DeepSeek | `deepseek-flash` occasionally emits reasoning only, returning empty `content`. The bridge retries once automatically; if it still fails, raise `DEEPSEEK_MAX_OUTPUT_TOKENS` or split the task. |
| Truncated answer | Reasoning consumed the token budget (`finish_reason: "length"`). Raise the cap or narrow the task. |
| Cloudflare 524 | A single call exceeded the ~100 s edge timeout. Slow responses already stream as SSE; lower `DEEPSEEK_TIMEOUT_MS` or split the work. |
| Tunnel URL unreachable from your own machine | Local router DNS may not have the fresh `trycloudflare.com` subdomain yet. Confirm with `curl --resolve` against `1.1.1.1`; this affects only local checks, not ChatGPT. |
| **Windows / git-bash**: garbled results or token blowups | `curl` in git-bash re-encodes non-ASCII request bodies as GBK, so the model reasons over mojibake. Use `npm run smoke` (Node `fetch`) instead of `curl`. |
| `agent_start` returns "工作区被拒绝" | The path is outside `DEEPSEEK_ALLOWED_ROOTS`, or that variable is unset — empty means deny everything, not anywhere. |
| Agent job sits in `waiting_approval` forever | A command is waiting for you. Run `npm run ctl -- pending`, then `approve <id>` or `deny <id>`. Unanswered for 5 min is an automatic deny. **The usual cause is a chained command**: anything containing `\|`, `;`, `&&`, `>` or `$(` goes to a human by design, because `echo hi && curl attacker.com` starts with the same word as `echo hi`, so a first-word allow-list alone would be no gate at all. Read-only PowerShell cmdlets are pre-approved; pipelines are not. Have the sub-agent issue a single command, or do the filtering inside a `node` script. |
| `npm run tunnel` says the port is not answering, but `npm run status` says the service is running | It is: the PID is alive and the service is not. `npm start` spawns a shell, and the shell outlives the node process, so a server that died at boot leaves a live PID behind. Read `.state/server.log`, then run `npm start` in the foreground to see the error. The tunnel is deliberately not opened — a tunnel in front of a dead port yields a URL that fails like a ChatGPT problem. |
| The wizard stopped at a question with `输入结束了(EOF)` / `end of input` | Something closed stdin — a pipe, a redirected file, a CI runner, or a double-click that lost its console. Answer in a real terminal, or answer the remaining questions by hand in `.env`. Whatever was already answered is still in the file. |
| Every agent job fails immediately | Claude Code is not on `PATH`. Install it, or point `BRIDGE_CLAUDE_BIN` at the binary. |
| Agent job dies partway through | Step ceiling (`BRIDGE_MAX_STEPS`, default 120) or wall clock (`BRIDGE_JOB_TIMEOUT_MS`, default 30 min). `npm run ctl -- jobs <id> --trace` shows the last step reached. **The work is not lost**: the job settles as `error` and is given no nonce — a half-finished review is not a review — but the model's own notes and its tool trace come back as a partial result, explicitly labelled as not-a-result. Use it to cut the task narrower instead of starting over. |
| A job you killed shows as `error`, not `cancelled` | That is a bug — a person stopping a job is not a crash. Please report it. |
| A file-reading task is refused before it reaches the bridge | **ChatGPT's own safety layer, not this bridge.** Sol may refuse to hand a local file to an external model and ask you to authorise it explicitly. Grant it (naming the file and what is in it helps), or reframe the task so the contents never travel back through the chat — have the sub-agent write the result to disk and read it there yourself. Confirm with `npm run ctl -- jobs`: if the list is unchanged, nothing was dispatched. |
| The sub-agent tells you "nothing left your machine" | **Do not take its word for it.** A sub-agent has no visibility into its own hosting. It runs on DeepSeek's API, so anything a file tool reads into its context is sent there on the next model call — and it will still report that no transmission occurred, because from where it sits the work looked local. Only the architecture answers this question; never the model's own account of it. |

## Security model

Read this before exposing anything. It has two tiers, and they defend completely different things.

### Tier 1 — protecting your bill

Applies always.

- **The path secret is the credential.** Anyone with the URL can spend your DeepSeek quota. Treat it like a password; rotate with `npm run ctl -- secret`.
- **The secret is never written down by the bridge itself.** The startup line, `ctl logs`, `ctl audit` and `ctl jobs` all render it as `<密钥已隐藏>`, and `smoke` masks it too. The reason is unglamorous: the only real leak this project has had came from the bridge's own log file, not from anyone guessing it. Every printed copy outlives the moment — scrollback, a transcript, a log pasted into a bug report.
- **Bind to loopback.** `HOST` defaults to `127.0.0.1`. Do not set `0.0.0.0`.
- **Rate limiting** is on by default and caps abuse if the URL leaks. It is a **global bucket of `tools/call` requests** rather than a per-IP window — see the variable table for why the per-IP framing was worse than useless here.
- **A DeepSeek spend cap** in the provider console is the final backstop — set it.
- **Use a separate API key.** Do not reuse a key that other tools depend on; a leaked bridge key should be revocable without collateral damage.

### Tier 2 — protecting your computer

> **None of tier 1 stops this.** Set `DEEPSEEK_ALLOWED_ROOTS` and whoever holds that URL can make the sub-agent read and write files on your machine, and run commands on it. "Can run commands" means "has your computer."

Out of the box the bridge is still read-only — the agent tools refuse every workspace and can only spend quota. The tiers are orders of magnitude apart:

| What you enable | What the holder of the URL can do |
|---|---|
| Nothing (default) | Spend your DeepSeek quota. **Cannot touch your computer.** |
| `DEEPSEEK_ALLOWED_ROOTS` set | Read and modify files under those roots; reads and writes *outside* them pause for your approval rather than being blocked outright |
| …plus command execution | **Run arbitrary commands — that is the machine** |

The guardrails, and — just as importantly — [what they are *not*](SECURITY.md#honest-limits--these-are-not-guarantees):

- **Fail closed.** No `DEEPSEEK_ALLOWED_ROOTS` means every workspace is denied, never "anywhere by default".
- **Every workspace goes through `src/sandbox.ts`**, which is the only place a caller-supplied string becomes a real path.
- **File tools are held to the workspace** by `src/harness/file-guard.ts`, which reuses that same `sandbox.admit()`, so junctions, 8.3 short names, UNC paths, alternate data streams and trailing dots are one implementation with one regression suite (`npm run test:guard`) rather than a second, weaker copy. Measured before and after: a job whose workspace was `D:\project` used to read a file thousands of directories outside it in two steps with no prompt and copy the contents back into the workspace; it now stops at `waiting_approval` and the content never enters the run. In-workspace reads and writes still run unattended, so nothing was made slower for the normal case.
- **Commands outside the allow-list pause the job for a human.** Unanswered means deny; there is no default-allow path, and the approval channel is a stdio child of the harness rather than an endpoint on the URL — otherwise a caller could approve its own commands.
- **Network tools always go to a human.** `WebFetch` and `WebSearch` cannot be pre-approved and are not covered by the workspace at all — the workspace governs what comes *in*, and nothing in the original design governed what goes *out*.
- **The sub-agent's environment is scrubbed of your credentials.** `claude-code.ts` deletes every inherited variable whose name looks like a secret (`API_KEY`, `_KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `CREDENTIAL`…) before spawning the harness, so a pre-approved `node -e "console.log(process.env.X)"` no longer reaches the bridge's own key, or an unrelated tool's. One variable is deliberately kept: `ANTHROPIC_AUTH_TOKEN`, which *is* the DeepSeek key the harness needs in order to call a model at all. Treat that key as readable-by-the-sub-agent — dedicated, revocable, spend-capped — because it is.
- **Step, time and process-tree ceilings.** A job that hits one settles as `error` and is given no nonce, so it cannot be mistaken for a finished review — but what it had already read comes back as a partial result. A brake should not also throw away the work that was done. Plus an audit log at `.state/audit.log`.
- **Clear `DEEPSEEK_ALLOWED_ROOTS` and restart to go back to tier 1.** That is a supported configuration and the recommended place to start: run read-only for a while, confirm the URL has not leaked, and only then consider turning it on.

**This is not a security boundary. It is an observation window.** The only real boundary is a sandbox or a VM — be at the machine while jobs run. Do not ship a public deployment of this with agent capabilities enabled.

### Temporarily disabling approvals altogether (`npm run auto:on`)

While you are watching a batch of jobs run, approving commands one at a time is tedious. This switch turns the approval queue off wholesale:

```bash
npm run auto        # which mode am I in
npm run auto:on     # fully unattended
npm run auto:off    # back to "needs approval"
```

**It removes more than you probably expect.** It is not "commands stop asking" — the `approval-mcp.ts` child process is never spawned, so everything hanging off it goes away together:

| Gate | Under the bypass |
|---|---|
| Command allow-list | gone |
| Chaining guard (`;` `&&` `\|\|` `\|`, redirection) | gone |
| File tools' workspace boundary | gone |
| Per-request approval records in `audit.log` | no longer produced |

**What still applies:** `DEEPSEEK_ALLOWED_ROOTS` still decides **which directories may be opened as a workspace**. The bypass loosens what happens *inside* one, not which ones can be opened.

**A restart revokes it.** The switch is a flag file at `.state/auto-approve` (not a `.env` key), and every service start deletes it. So `reload` / `restart` / rebooting all land back on "needs approval". That is on purpose: the bypass means "I am watching this job right now", not "I have stopped caring". `reload`, `rotate` and `allow` all restart the service and therefore revoke it too — each of them says so before it does.

Turning it on needs **no restart** — it takes effect on the next job (the check is re-read per job).

> `BRIDGE_CC_APPROVAL=off` in `.env` is the other path and does **not** reset on restart. It is kept for `npm run accept`. If both are on, `auto off` only clears the flag file, and `ctl status` tells you plainly that the `.env` one is still live.

**An honest note on auditing:** under the bypass there are no `approval_requested` / `approval_auto` lines any more — the process that writes them never starts. What remains is the mode-change lines (`auto_approve_on` / `auto_approve_off` / `auto_approve_cleared`) and the harness's own tool-call trace in `.state/jobs/<id>.json` (one entry per call, capped at 400, readable with `npm run ctl -- jobs <id> --trace`). **A record is not a gate** — that is for looking back afterwards, not for stopping anything.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
