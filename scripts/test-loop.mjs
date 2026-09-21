#!/usr/bin/env node
/**
 * Offline tests for the agent machinery. No network, no API key, no money —
 * the model is either a fixture string or a scripted stub.
 *
 * This file is the regression guard for behaviour that only shows up once
 * DeepSeek is driving a tool loop. Almost nothing here fails loudly in a
 * single-shot Q&A tool, which is exactly why it went unnoticed until now.
 *
 * Run: npm run test:loop
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseCompletion } from "../src/deepseek.ts";

const wrap = (message, finish_reason = "stop") =>
  JSON.stringify({
    model: "deepseek-flash",
    choices: [{ finish_reason, message }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

test("工具调用回合:content 为 null 时不得抛错", () => {
  // The shape DeepSeek actually returns when it decides to call a tool. The old
  // parser threw on `typeof content !== "string"`, which killed every step of
  // every tool loop.
  const raw = wrap({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a.txt"}' },
      },
    ],
  });

  const turn = parseCompletion(raw);
  assert.equal(turn.message.content, null);
  assert.equal(turn.message.tool_calls.length, 1);
  assert.equal(turn.message.tool_calls[0].function.name, "read_file");
});

test("工具调用回合:content 为空字符串同样合法", () => {
  const raw = wrap({
    role: "assistant",
    content: "",
    tool_calls: [{ id: "c", type: "function", function: { name: "ls", arguments: "{}" } }],
  });
  assert.equal(parseCompletion(raw).message.content, "");
});

test("工具调用回合:reasoning_content 必须随消息回传", () => {
  // Thinking models attach this to the tool-call turn. Dropping it makes the
  // *next* request fail with 400, which looks like a random API error.
  const raw = wrap({
    role: "assistant",
    content: null,
    reasoning_content: "我需要先看看文件里有什么。",
    tool_calls: [{ id: "c", type: "function", function: { name: "read_file", arguments: "{}" } }],
  });

  const turn = parseCompletion(raw);
  assert.equal(turn.message.reasoning_content, "我需要先看看文件里有什么。");
});

test("普通文本回合照常解析", () => {
  const turn = parseCompletion(wrap({ role: "assistant", content: "完成了。" }));
  assert.equal(turn.message.content, "完成了。");
  assert.equal(turn.message.tool_calls, undefined);
  assert.equal(turn.finishReason, "stop");
});

test("既无正文也无工具调用才是畸形响应", () => {
  const raw = wrap({ role: "assistant", content: null });
  assert.throws(() => parseCompletion(raw), /响应结构不符合预期/);
});

test("非 JSON 响应给出可读错误", () => {
  assert.throws(() => parseCompletion("<html>502</html>"), /非 JSON/);
});

test("usage 与 finishReason 不被丢弃", () => {
  const turn = parseCompletion(wrap({ role: "assistant", content: "ok" }, "length"));
  assert.equal(turn.finishReason, "length");
  assert.equal(turn.usage.total_tokens, 15);
});

// --- 请求次数:唯一的证据是数 fetch 调用 ------------------------------------
//
// 这一组防的是「重复计费」和「重复调用工具」。两者都不会报错,只会让账单和
// 副作用翻倍 —— 而工具调用翻倍意味着文件被写两次、命令跑两次。

process.env.DEEPSEEK_API_KEY = "sk-test-not-a-real-key";

function stubFetch(responses) {
  const calls = [];
  const original = globalThis.fetch;
  let queue = [...responses];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const next = queue.shift();
    if (!next) throw new Error("stubFetch: 收到了预期之外的请求");
    return new Response(typeof next === "string" ? next : JSON.stringify(next), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const toolCallTurn = wrap({
  role: "assistant",
  content: null,
  tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
});
const emptyTurn = wrap({ role: "assistant", content: "" });
const textTurn = wrap({ role: "assistant", content: "答案" });

test("工具调用回合只发一次请求 —— 不得因为 content 为空而重发", async () => {
  const { calls, restore } = stubFetch([toolCallTurn]);
  try {
    const { callDeepSeek } = await import("../src/deepseek.ts");
    await callDeepSeek({ task: "看看文件", mode: "analyze" });
    assert.equal(calls.length, 1, `工具回合重发了请求(${calls.length} 次)—— 工具会被执行两遍`);
  } finally {
    restore();
  }
});

test("正文为空且无工具调用时才重试,且只重试一次", async () => {
  const { calls, restore } = stubFetch([emptyTurn, textTurn]);
  try {
    const { callDeepSeek } = await import("../src/deepseek.ts");
    const result = await callDeepSeek({ task: "t", mode: "analyze" });
    assert.equal(calls.length, 2);
    assert.equal(result.text, "答案");
  } finally {
    restore();
  }
});

test("两次都空则报错,且不会无限重试", async () => {
  const { calls, restore } = stubFetch([emptyTurn, emptyTurn]);
  try {
    const { callDeepSeek } = await import("../src/deepseek.ts");
    await assert.rejects(() => callDeepSeek({ task: "t", mode: "analyze" }), /连续两次没有返回正文/);
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

// 推理顶满额度:实测 2026-09-21,同一条请求连续两次都是
// finish_reason "length" / reasoning_tokens = 额度 / content ""。
// 重发不会变好,只会再花一次钱和 20 秒调用窗口。
const truncatedTurn = JSON.stringify({
  model: "deepseek-flash",
  choices: [
    { finish_reason: "length", message: { role: "assistant", content: "", reasoning_content: "想了很久" } },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 16_384,
    total_tokens: 16_394,
    completion_tokens_details: { reasoning_tokens: 12_000 },
  },
});

test("推理顶满额度时不重试 —— 同一条请求必然同样被截断", async () => {
  // 队列里第二个 textTurn 是诱饵:被消费掉就说明它重试了。
  const { calls, restore } = stubFetch([truncatedTurn, textTurn]);
  try {
    const { callDeepSeek } = await import("../src/deepseek.ts");
    await assert.rejects(
      () => callDeepSeek({ task: "t", mode: "analyze" }),
      /推理过程占满了 max_tokens\(\d+\)/,
    );
    assert.equal(calls.length, 1, `额度不够时重试了(${calls.length} 次)`);
  } finally {
    restore();
  }
});

test("截断的报错里带上用掉的推理 token 数", async () => {
  // 这个数字是"该调高额度"和"该拆任务"的分界线,不能被省成一句泛泛的失败。
  const { restore } = stubFetch([truncatedTurn, textTurn]);
  try {
    const { callDeepSeek } = await import("../src/deepseek.ts");
    await assert.rejects(
      () => callDeepSeek({ task: "t", mode: "analyze" }),
      /本次推理用了 12000 个 token/,
    );
  } finally {
    restore();
  }
});

test("工具定义随请求发出", async () => {
  const { calls, restore } = stubFetch([textTurn]);
  try {
    const { chatCompletion } = await import("../src/deepseek.ts");
    await chatCompletion({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "ls", description: "列目录", parameters: {} } }],
    });
    assert.equal(calls[0].tools.length, 1);
    assert.equal(calls[0].tools[0].function.name, "ls");
  } finally {
    restore();
  }
});

test("带 reasoning_content 的助手消息原样发出 —— 删掉它下一次请求会 400", async () => {
  const { calls, restore } = stubFetch([textTurn]);
  try {
    const { chatCompletion } = await import("../src/deepseek.ts");
    await chatCompletion({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "先看看文件",
          tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "a.txt" },
      ],
    });
    const sent = calls[0].messages[1];
    assert.equal(sent.reasoning_content, "先看看文件");
    assert.equal(sent.tool_calls[0].id, "c1");
  } finally {
    restore();
  }
});

test("调用方取消与超时给出不同的错误 —— 取消不是超时", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 5000);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
    return new Response("{}", { status: 200 });
  };
  try {
    const { chatCompletion } = await import("../src/deepseek.ts");
    const ac = new AbortController();
    const p = chatCompletion({ messages: [{ role: "user", content: "hi" }], signal: ac.signal });
    ac.abort();
    await assert.rejects(p, /已被调用方取消/);
  } finally {
    globalThis.fetch = original;
  }
});

// --- 直连调用 runner --------------------------------------------------------
//
// deepseek_flash 现在也是一个任务(慢的那次交出 job_id)。runner 本身只有三件
// 事要对:正文和用量一起交回来、把取消真的传到 fetch、以及不许自己吞掉错误。

function fakeCtx(over = {}) {
  const ac = new AbortController();
  return {
    jobId: "j-test",
    signal: ac.signal,
    events: [],
    steps: 0,
    record(e) {
      this.events.push(e);
    },
    setSteps(n) {
      this.steps = n;
    },
    setWaitingApproval() {},
    checkCancelled: () => false,
    ...over,
  };
}

test("flash 正文的用量页脚只在真有用量时才加", async () => {
  const { renderFlashText } = await import("../src/harness/flash.ts");
  assert.equal(renderFlashText({ text: "答案", model: "deepseek-flash" }), "答案");
  assert.equal(renderFlashText({ text: "答案", model: "deepseek-flash", usage: {} }), "答案");
  assert.equal(
    renderFlashText({
      text: "答案",
      model: "deepseek-flash",
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
    "答案\n\n[deepseek: deepseek-flash | 10 in / 20 out]",
  );
});

test("flash runner:正文连同用量一起交回来,并记下一次模型调用", async () => {
  const { calls, restore } = stubFetch([textTurn]);
  try {
    const { flashRunner } = await import("../src/harness/flash.ts");
    const ctx = fakeCtx();
    const result = await flashRunner({ task: "t", mode: "analyze" }, ctx);

    assert.equal(calls.length, 1);
    assert.match(result.text, /^答案/);
    assert.match(result.text, /\[deepseek: deepseek-flash \| 10 in \/ 5 out\]/, "用量页脚要和同步路径一字不差");
    assert.equal(result.steps, 1);
    assert.equal(ctx.steps, 1);
  } finally {
    restore();
  }
});

test("flash runner:mode 真的进了系统提示词,不只是记在任务记录里", async () => {
  const { calls, restore } = stubFetch([textTurn]);
  try {
    const { flashRunner } = await import("../src/harness/flash.ts");
    await flashRunner({ task: "t", mode: "review" }, fakeCtx());
    assert.match(calls[0].messages[0].content, /独立审查代理/, "record 里写 review 而实际用 analyze 的提示词,就是记录在撒谎");
  } finally {
    restore();
  }
});

test("flash runner:kill 哨兵必须停掉请求,而不是等它自己跑完", async () => {
  // 不等这一下会是三分钟的沉默:请求继续在跑、钱照花,结果回来时才被记成
  // cancelled 扔掉 —— 而 `ctl jobs` 上完全看不出 kill 到底有没有生效。
  const original = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = async (_url, init) => {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 10_000);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        aborted = true;
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
    return new Response("{}", { status: 200 });
  };
  try {
    const { flashRunner } = await import("../src/harness/flash.ts");
    await assert.rejects(
      () => flashRunner({ task: "t", mode: "analyze" }, fakeCtx({ checkCancelled: () => true })),
      /已被调用方取消/,
    );
    assert.equal(aborted, true, "fetch 必须真的被中止,否则取消只是不再看结果");
  } finally {
    globalThis.fetch = original;
  }
});

test("flash runner:失败原文原样抛出,不在这里被吞掉", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad key", { status: 401 });
  try {
    const { flashRunner } = await import("../src/harness/flash.ts");
    await assert.rejects(() => flashRunner({ task: "t", mode: "analyze" }, fakeCtx()), /401/);
  } finally {
    globalThis.fetch = original;
  }
});
