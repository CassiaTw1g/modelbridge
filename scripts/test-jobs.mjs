#!/usr/bin/env node
/**
 * 任务注册表 + agent 工具的离线测试。
 *
 * 这里防的都是「看起来能跑、真跑起来会丢任务」的缺陷,其中第一条是本项目
 * 里最高价值的一条测试 —— 详见下面的注释。
 *
 * 跑法:npm run test:jobs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { createRegistry } from "../src/agent/jobs.ts";
import { createPolicy } from "../src/sandbox.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempState() {
  return mkdtempSync(join(tmpdir(), "bridge-jobs-"));
}

// --- 最高价值的一条 ---------------------------------------------------------

test("客户端断线不得杀掉任务 —— 任务必须有自己的 AbortController", async () => {
  // MCP SDK 在客户端断开时会 abort 当前请求处理器的 signal。`agent_start`
  // 有一个 45 秒的同步等待窗口,而 ChatGPT 的工具调用上限约 60 秒 —— 断线是
  // 常态,不是异常。如果那个 signal 被接到任务的控制器上,每一个没耐心的
  // 调用方都会杀掉自己刚派出去的任务,而且是静默的:
  // 调用方已经走了,没人会看到错误。
  const stateDir = tempState();
  let jobSignal = null;
  let finished = false;

  const registry = createRegistry(
    async (_input, ctx) => {
      jobSignal = ctx.signal;
      await sleep(600);
      finished = true;
      return { text: "做完了", steps: 1 };
    },
    { stateDir },
  );

  const server = createMcpServer(registry, createPolicy([ROOT]));
  const client = new Client({ name: "t", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);

  // Not awaited later on purpose: once the client is gone there is nobody to
  // deliver a response to, and the SDK retries for the full sync window. The
  // job's own outcome is what this test is about.
  void client
    .callTool({ name: "deepseek_agent_start", arguments: { task: "测试任务", workspace: ROOT } })
    .catch(() => undefined);

  await sleep(150);
  assert.ok(jobSignal, "任务应当已经启动");
  assert.equal(jobSignal.aborted, false);

  // 模拟 ChatGPT 挂断:关掉客户端,服务端随即收到断开。
  await client.close();
  await sleep(150);

  assert.equal(jobSignal.aborted, false, "断线把任务的 signal 弄成 aborted 了 —— 任务会被静默杀死");

  await sleep(700);
  assert.equal(finished, true, "任务应当继续跑完,而不是随调用方一起消失");

  const jobs = registry.list();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, "done", `任务最终状态应为 done,实际 ${jobs[0].state}`);
  assert.ok(jobs[0].nonce, "结果必须带验证码");

  registry.shutdown();
  await server.close();
  rmSync(stateDir, { recursive: true, force: true });
});

// --- 取消哨兵 ---------------------------------------------------------------

test("cancel 文件能让运行中的任务停下", async () => {
  const stateDir = tempState();
  let observed = false;

  const registry = createRegistry(
    async (_input, ctx) => {
      // 真实的 harness 每 500ms 查一次;这里等一会儿再查。
      await sleep(400);
      observed = ctx.checkCancelled();
      if (observed) throw new Error("任务被取消。");
      return { text: "本不该跑到这里", steps: 1 };
    },
    { stateDir },
  );

  const job = registry.start({ task: "t", mode: "code", workspace: ROOT });
  writeFileSync(join(stateDir, "cancel", `${job.id}.json`), "{}", "utf8");

  await job.settled;
  assert.equal(observed, true, "运行中的任务必须能看见 cancel 哨兵");
  assert.equal(job.state, "cancelled");
  rmSync(stateDir, { recursive: true, force: true });
});

test("取消一个还没开始的任务,不会让它变成 done", async () => {
  const stateDir = tempState();
  const registry = createRegistry(
    async (_input, _ctx) => {
      await sleep(300);
      return { text: "晚了", steps: 1 };
    },
    { stateDir },
  );

  const job = registry.start({ task: "t", mode: "code", workspace: ROOT });
  assert.equal(job.state, "running");
  registry.shutdown();
  await job.settled;
  assert.notEqual(job.state, "done", "被取消的任务绝不能报成完成");
  rmSync(stateDir, { recursive: true, force: true });
});

// --- 上限 -------------------------------------------------------------------

test("并发上限挡住第三个任务,而不是默默排队", () => {
  const stateDir = tempState();
  const registry = createRegistry(async () => {
    await sleep(500);
    return { text: "x", steps: 1 };
  }, { stateDir, maxConcurrent: 2 });

  registry.start({ task: "1", mode: "code", workspace: ROOT });
  registry.start({ task: "2", mode: "code", workspace: ROOT });
  assert.throws(
    () => registry.start({ task: "3", mode: "code", workspace: ROOT }),
    /上限/,
    "超限时必须明确报错 —— 静默排队会让调用方以为任务已经在跑",
  );
  registry.shutdown();
  rmSync(stateDir, { recursive: true, force: true });
});

test("墙钟硬上限会中止一个不肯结束的任务", async () => {
  const stateDir = tempState();
  const registry = createRegistry(
    async (_input, ctx) => {
      // 一个会一直跑下去的 harness。硬上限是最后一个兜底。
      for (let i = 0; i < 200; i++) {
        if (ctx.signal.aborted) throw new Error("被中止");
        await sleep(50);
      }
      return { text: "不该到这里", steps: 1 };
    },
    { stateDir, hardWallMs: 300 },
  );

  const job = registry.start({ task: "t", mode: "code", workspace: ROOT });
  await job.settled;
  assert.equal(job.state, "error");
  assert.match(job.error, /硬上限/);
  rmSync(stateDir, { recursive: true, force: true });
});

// --- 落盘快照 ---------------------------------------------------------------

test("任务快照写到磁盘,ctl 才能看见它", async () => {
  const stateDir = tempState();
  const registry = createRegistry(async () => ({ text: "结果文本", steps: 3 }), { stateDir });
  const job = registry.start({ task: "落盘测试", mode: "code", workspace: ROOT });
  await job.settled;

  const raw = JSON.parse(readFileSync(join(stateDir, "jobs", `${job.id}.json`), "utf8"));
  assert.equal(raw.state, "done");
  assert.equal(raw.nonce, job.nonce);
  assert.equal(raw.workspace, ROOT);
  // AbortController 和 promise 不能进 JSON —— 循环引用会直接抛错,
  // 而这个写入发生在 settle 路径上,抛错就等于任务永远结束不了。
  assert.equal(raw.controller, undefined);
  assert.equal(raw.settled, undefined);
  rmSync(stateDir, { recursive: true, force: true });
});

test("任务失败时,错误原文被保留下来", async () => {
  const stateDir = tempState();
  const registry = createRegistry(async () => {
    throw new Error("DeepSeek 返回 400:reasoning_content 缺失");
  }, { stateDir });
  const job = registry.start({ task: "t", mode: "code", workspace: ROOT });
  await job.settled;
  assert.equal(job.state, "error");
  assert.match(job.error, /reasoning_content/);
  rmSync(stateDir, { recursive: true, force: true });
});

// --- 提前中止后 salvage -----------------------------------------------------

// 真实的触顶发生在 harness 里(它才数得清模型的工具调用),用真 CLI 才测得到,
// 那条路在 npm run accept 之外单独验过。这里锁的是分工的另一半:harness 交回来的
// 半成品,**注册表和 MCP 层不能把它吞掉** —— 吞掉就等于这个修复从未存在:
// 调用方拿到的仍然只有一行错误,而这正是当初「任务超过 40 步上限,没有产出」的样子。

const SALVAGE = {
  text: "任务在完成前被中止:任务超过 2 步上限,已中止。\n\n【它最后说过的内容】\n已经读完 a.ts、b.ts,发现 x 处异常被吞。",
  steps: 41,
  incomplete: "任务超过 2 步上限,已中止。",
};

test("提前中止:状态算失败,但已完成的内容必须一起交回来", async () => {
  const stateDir = tempState();
  const registry = createRegistry(async () => SALVAGE, { stateDir });
  const job = registry.start({ task: "t", mode: "code", workspace: ROOT });
  await job.settled;

  assert.equal(job.state, "error", "半成品不是成品,绝不能报成 done");
  assert.match(job.error, /步上限/);
  assert.equal(job.result, undefined, "没有完整结果,就不该有 result");
  assert.equal(job.partial?.text, SALVAGE.text, "已经查到的内容不能丢");
  assert.equal(job.partial?.steps, 41, "步数要如实保留");
  rmSync(stateDir, { recursive: true, force: true });
});

test("提前中止:半成品必须真的出现在调用方读到的那段文字里", async () => {
  // 这条才是修复的落点。任务记录里存着 partial,payload 却不渲染它,
  // 对 ChatGPT 来说两者完全一样 —— 它只读得到 payload。
  const stateDir = tempState();
  const registry = createRegistry(async () => SALVAGE, { stateDir });
  const job = registry.start({ task: "t", mode: "code", workspace: ROOT });
  await job.settled;

  const server = createMcpServer(registry, createPolicy([ROOT]));
  const client = new Client({ name: "t", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);

  const res = await client.callTool({
    name: "deepseek_agent_poll",
    arguments: { job_id: job.id },
  });
  const text = res.content.map((c) => c.text).join("\n");

  assert.match(text, /步上限/, "错误原文必须在");
  assert.match(text, /已经读完 a\.ts/, "半成品正文必须在,否则调用方看到的就是一片空白");
  assert.match(text, /不是结果/, "必须写明这不是结果 —— 半成品被当成结论是这里唯一真正的风险");
  assert.ok(!/验证码/.test(text), "失败的任务绝不能带 nonce,那等于给它盖章");
  assert.ok(!/✅/.test(text), "不能出现完成标记");

  registry.shutdown();
  await server.close();
  rmSync(stateDir, { recursive: true, force: true });
});

test("正常完成的任务不会被 partial 污染", async () => {
  const stateDir = tempState();
  const registry = createRegistry(async () => ({ text: "完整结果", steps: 5 }), { stateDir });
  const job = registry.start({ task: "t", mode: "code", workspace: ROOT });
  await job.settled;
  assert.equal(job.state, "done");
  assert.equal(job.partial, undefined, "成功路径上不该出现半成品字段");
  assert.equal(job.result?.text, "完整结果");
  rmSync(stateDir, { recursive: true, force: true });
});

test("被人手动 kill 的任务,半成品同样保留", async () => {
  // 走的是线上真正那条路:cancel 哨兵文件(即 `npm run ctl -- job kill`)。
  // harness 每 500ms 查一次,查到就带着 partial 正常返回,注册表再按「被取消」结账。
  // 取消是人的决定,不该顺便把已经查到的东西一起扔掉。
  const stateDir = tempState();
  const registry = createRegistry(async (_input, ctx) => {
    await sleep(300);
    assert.equal(ctx.checkCancelled(), true, "这里应当已经看见 cancel 哨兵");
    return SALVAGE;
  }, { stateDir });

  const job = registry.start({ task: "t", mode: "code", workspace: ROOT });
  writeFileSync(join(stateDir, "cancel", `${job.id}.json`), "{}", "utf8");
  await job.settled;

  assert.equal(job.state, "cancelled");
  assert.equal(job.partial?.text, SALVAGE.text, "取消也要把已经做到的部分留下");
  rmSync(stateDir, { recursive: true, force: true });
});

// --- flash 直连调用:慢的那次不再撞调用方的窗口 ------------------------------
//
// 从前的 deepseek_flash 是纯同步的,一次调用想超过调用方的工具窗口(实测一次
// 对抗性审查要 50 秒,ChatGPT 约 60 秒放弃)就只能被报成失败 —— 哪怕答案再过
// 几秒就到了。现在超窗的那次会交出一个 job_id。
//
// 这一段锁的是**两条路的边界**:快的那条返回形态必须一字不变(调用方可能完全
// 不认 job_id),慢的那条必须在返回里说清「你还没有答案」,因为这里唯一真正的
// 风险是调用方自己把答案编出来。

/** 真实窗口是 45 秒(ChatGPT 约 60 秒放弃)。测试当然不能真等,所以压到毫秒级。 */
async function withSyncWindow(ms, fn) {
  const previous = process.env.BRIDGE_SYNC_WINDOW_MS;
  process.env.BRIDGE_SYNC_WINDOW_MS = String(ms);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.BRIDGE_SYNC_WINDOW_MS;
    else process.env.BRIDGE_SYNC_WINDOW_MS = previous;
  }
}

async function connect(server) {
  const client = new Client({ name: "t", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}

const textOf = (res) => res.content.map((c) => c.text).join("\n");
const jobIdOf = (text) => /job_id[:：]\s*([A-Za-z0-9-]+)/.exec(text)?.[1];
const flashWith = (stateDir, run) => createRegistry(run, { stateDir, harnessName: "flash" });

test("flash:窗口内跑完照旧只返回正文 —— 快路径的形态一个字都不能变", async () => {
  const stateDir = tempState();
  const flashRegistry = flashWith(stateDir, async () => ({ text: "答案正文", steps: 1 }));
  const server = createMcpServer(undefined, undefined, flashRegistry);
  const client = await connect(server);

  const res = await client.callTool({ name: "deepseek_flash", arguments: { task: "t" } });
  assert.ok(!res.isError);
  assert.equal(textOf(res), "答案正文", "快的那次必须和以前完全一样 —— 调用方可能根本不认识 job_id");
  await server.close();
  rmSync(stateDir, { recursive: true, force: true });
});

test("flash:超过窗口就交 job_id,且必须写明还没有答案、不带验证码", async () => {
  const stateDir = tempState();
  const flashRegistry = flashWith(stateDir, async () => {
    await sleep(400);
    return { text: "答案正文", steps: 1 };
  });
  // 同时挂一个 agent 注册表:poll 要能在两个注册表里找到 flash 的那个任务。
  const agentRegistry = createRegistry(async () => ({ text: "agent", steps: 1 }), { stateDir });
  const server = createMcpServer(agentRegistry, createPolicy([ROOT]), flashRegistry);
  const client = await connect(server);

  await withSyncWindow(100, async () => {
    const res = await client.callTool({ name: "deepseek_flash", arguments: { task: "t" } });
    const text = textOf(res);

    assert.match(text, /job_id/, "超窗的那次必须交出 job_id,否则这次调用就成了纯损失");
    assert.ok(!/答案正文/.test(text), "还没跑完就绝不能把答案写进返回 —— 那是编造结果的入口");
    assert.ok(!/验证码/.test(text), "没结束就没有 nonce:它是「我真的拿到了结果」唯一的凭证");
    assert.match(text, /还没有答案/);

    const jobId = jobIdOf(text);
    assert.ok(jobId, `job_id 必须能被取出来,实际返回:\n${text}`);
    const polled = await client.callTool({
      name: "deepseek_agent_poll",
      arguments: { job_id: jobId, wait_seconds: 5 },
    });
    const polledText = textOf(polled);
    assert.match(polledText, /答案正文/, "轮询必须真的能把答案取回来,否则 job_id 就是个死胡同");
    assert.match(polledText, /验证码/, "结束之后才该有 nonce");
  });

  await server.close();
  rmSync(stateDir, { recursive: true, force: true });
});

test("flash:窗口内就失败 → 仍然是 isError 的「DeepSeek 调用失败」原文", async () => {
  // 同步路径的失败契约不能变:调用方在同一个回合里,直接就能把这个错误转述给用户。
  const stateDir = tempState();
  const flashRegistry = flashWith(stateDir, async () => {
    throw new Error("DeepSeek API 返回 401: invalid key");
  });
  const server = createMcpServer(undefined, undefined, flashRegistry);
  const client = await connect(server);

  const res = await client.callTool({ name: "deepseek_flash", arguments: { task: "t" } });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /DeepSeek 调用失败:DeepSeek API 返回 401/);
  await server.close();
  rmSync(stateDir, { recursive: true, force: true });
});

test("flash:窗口之后才失败 → 轮询到 ❌,不带验证码也不带完成标记", async () => {
  const stateDir = tempState();
  const flashRegistry = flashWith(stateDir, async () => {
    await sleep(300);
    throw new Error("DeepSeek 请求超过 180000ms 超时。");
  });
  const server = createMcpServer(undefined, undefined, flashRegistry);
  const client = await connect(server);

  await withSyncWindow(100, async () => {
    const first = textOf(await client.callTool({ name: "deepseek_flash", arguments: { task: "t" } }));
    const jobId = jobIdOf(first);
    assert.ok(jobId, `第一次返回里应当有 job_id,实际:\n${first}`);

    const polled = textOf(
      await client.callTool({ name: "deepseek_agent_poll", arguments: { job_id: jobId, wait_seconds: 5 } }),
    );
    assert.match(polled, /超时/, "错误原文必须原样带到调用方那里");
    assert.ok(!/验证码/.test(polled), "失败的任务绝不能带 nonce,那等于给它盖章");
    assert.ok(!/✅/.test(polled), "不能出现完成标记");
  });

  await server.close();
  rmSync(stateDir, { recursive: true, force: true });
});

test("flash:并发满时当场拒绝,不排队也不假装在跑", async () => {
  const stateDir = tempState();
  const flashRegistry = createRegistry(
    async () => {
      await sleep(500);
      return { text: "慢答案", steps: 1 };
    },
    { stateDir, harnessName: "flash", maxConcurrent: 1 },
  );
  const server = createMcpServer(undefined, undefined, flashRegistry);
  const client = await connect(server);

  await withSyncWindow(100, async () => {
    await client.callTool({ name: "deepseek_flash", arguments: { task: "第一个" } });
    const second = await client.callTool({ name: "deepseek_flash", arguments: { task: "第二个" } });
    assert.equal(second.isError, true, "超限必须报错 —— 静默排队会让调用方以为任务已经在跑");
    assert.match(textOf(second), /上限/);
  });

  await server.close();
  rmSync(stateDir, { recursive: true, force: true });
});

test("flash:任务记录里写明它是直连调用,没有 workspace 也没有步数", async () => {
  // `ctl jobs` 读的就是这份快照。flash 任务没有工作区 —— 但记录里必须看得出
  // 这一点,而不是留一个空字段让人猜它是「没记」还是「没有」。
  const stateDir = tempState();
  const flashRegistry = flashWith(stateDir, async () => ({ text: "答案", steps: 1 }));
  const job = flashRegistry.start({ kind: "flash", task: "看看这段逻辑", mode: "review" });
  await job.settled;

  const raw = JSON.parse(readFileSync(join(stateDir, "jobs", `${job.id}.json`), "utf8"));
  assert.equal(raw.kind, "flash");
  assert.equal(raw.workspace, undefined, "flash 任务不碰文件系统,就不该有工作区");
  assert.equal(raw.mode, "review", "mode 在 flash 上是被真正使用的(选系统提示词),记录不能和实际不符");
  assert.equal(raw.harness, "flash");
  rmSync(stateDir, { recursive: true, force: true });
});

test("agent 任务的记录仍然是 agent,工作区照旧落盘", async () => {
  const stateDir = tempState();
  const registry = createRegistry(async () => ({ text: "x", steps: 1 }), { stateDir });
  const job = registry.start({ task: "t", workspace: ROOT });
  await job.settled;

  const raw = JSON.parse(readFileSync(join(stateDir, "jobs", `${job.id}.json`), "utf8"));
  assert.equal(raw.kind, "agent", "没写 kind 的调用方必须仍然得到 agent —— 这是老调用方的默认");
  assert.equal(raw.workspace, ROOT);
  // 老默认是 code;换成 flash 默认的 analyze 会让每一条历史记录的语义都变掉。
  assert.equal(raw.mode, "code");
  rmSync(stateDir, { recursive: true, force: true });
});
