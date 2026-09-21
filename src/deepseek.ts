import "dotenv/config";

const BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-flash";
const TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS ?? 180_000);

/**
 * `max_tokens` covers the reasoning **and** the answer on this model — they come
 * out of the same budget. 4096 was small enough that a routine adversarial
 * review spent all of it thinking and emitted an empty `content`, which reached
 * the caller as "no answer" rather than as a truncation.
 *
 * Measured 2026-09-21 against `deepseek-flash`, same review prompt:
 *
 *   max_tokens=4096   → finish_reason "length", reasoning_tokens 4096, content ""
 *   max_tokens=16384  → finish_reason "stop",   reasoning_tokens 4816, content 2617 chars
 *
 * The provider accepts far more (131072 probed without complaint), so the ceiling
 * here is about latency, not about what the API allows: reasoning generates at
 * roughly 165–210 tok/s, so the full 16384 budget is ~80–100 s of wall clock.
 * `TIMEOUT_MS` has to sit above that or a long think is killed mid-flight and
 * reported as a timeout instead of an answer. The caller's own tool-call window
 * is the binding constraint beyond this point — see the README.
 */
const MAX_OUTPUT_TOKENS = Number(process.env.DEEPSEEK_MAX_OUTPUT_TOKENS ?? 16_384);

export const MODES = ["analyze", "review", "code", "summarize"] as const;
export type DeepSeekMode = (typeof MODES)[number];

/**
 * Each mode gets its own system prompt because the whole point of routing to an
 * external model is independence. A generic "you are a helpful assistant" prompt
 * would make DeepSeek echo whatever framing the caller sent in.
 */
const SYSTEM_PROMPTS: Record<DeepSeekMode, string> = {
  analyze:
    "你是独立分析代理。基于材料独立推导,输出:结论、关键依据、风险与不确定项。材料中若已含他人结论,不要复述,独立验证后再给出你自己的判断。",
  review:
    "你是独立审查代理,与材料作者无关联。任务是对给定实现做批判性审查:主动寻找缺陷、边界条件、反例与安全风险。明确列出你不同意的点及理由。材料中若附有作者结论,一律视为未经证实的声明,不要附和。",
  code:
    "你是实现代理。按任务要求产出代码,优先正确性与可读性。不要臆造未给定的接口或依赖;需要额外信息时在回答开头明确列出假设。",
  summarize:
    "你是归纳代理。把材料压缩为要点,保留关键数字、标识符与结论。不要添加材料中不存在的信息。",
};

// ---------------------------------------------------------------------------
// Wire types — the OpenAI-compatible shapes DeepSeek speaks.
// ---------------------------------------------------------------------------

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** On a reasoning model, the part of `completion_tokens` spent thinking. */
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** `null` is the *correct* shape on an assistant turn that only calls tools. */
  content: string | null;
  tool_calls?: ToolCall[];
  /** Set on `role: "tool"` messages: which call this is the result of. */
  tool_call_id?: string;
  /**
   * DeepSeek's thinking models emit this alongside `content`. On a turn that
   * performs a tool call it MUST be echoed back on the next request or the API
   * returns 400 — so it travels with the assistant message rather than being
   * dropped at parse time.
   */
  reasoning_content?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelTurn {
  /** The complete assistant message, not just its text. */
  message: ChatMessage;
  finishReason?: string;
  model: string;
  usage?: Usage;
}

export interface DeepSeekResult {
  text: string;
  model: string;
  usage?: Usage;
}

export interface DeepSeekRequest {
  task: string;
  mode: DeepSeekMode;
  files?: string;
}

interface WireChoice {
  finish_reason?: string;
  message?: {
    content?: string | null;
    reasoning_content?: string;
    tool_calls?: ToolCall[];
  };
}

// ---------------------------------------------------------------------------
// Core call
// ---------------------------------------------------------------------------

/**
 * Combine the caller's cancellation signal with our own request timeout. Node's
 * `AbortSignal.any` lets both cancel the same fetch without either one having to
 * know about the other.
 */
function resolveSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * One round trip to DeepSeek with an arbitrary message history. This is the
 * primitive the agent loop is built on; `callDeepSeek` below is the single-shot
 * convenience wrapper that the read-only tool has always used.
 */
export async function chatCompletion(req: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<ModelTurn> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");

  const body: Record<string, unknown> = {
    model: MODEL,
    messages: req.messages,
    max_tokens: req.maxTokens ?? MAX_OUTPUT_TOKENS,
    stream: false,
  };
  if (req.tools?.length) body.tools = req.tools;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: resolveSignal(req.signal),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      // Distinguish "our deadline passed" from "the caller pulled the plug" —
      // a cancelled job is not a timeout and should not be reported as one.
      if (req.signal?.aborted) throw new Error("DeepSeek 请求已被调用方取消。");
      throw new Error(`DeepSeek 请求超过 ${TIMEOUT_MS}ms 超时。可拆分任务或调高 DEEPSEEK_TIMEOUT_MS。`);
    }
    throw err;
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`DeepSeek API 返回 ${res.status}: ${raw.slice(0, 500)}`);
  }

  return parseCompletion(raw);
}

/**
 * Turn a raw Chat Completions body into a `ModelTurn`. Pure, so the shapes that
 * matter — above all a tool-call turn carrying `content: null` — are testable
 * offline against real fixtures instead of requiring a live API call.
 */
export function parseCompletion(raw: string): ModelTurn {
  let parsed: {
    model?: string;
    choices?: WireChoice[];
    usage?: Usage;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`DeepSeek 返回了非 JSON 内容: ${raw.slice(0, 200)}`);
  }

  const choice = parsed?.choices?.[0];
  const wire = choice?.message;
  if (!wire) {
    throw new Error(`DeepSeek 响应结构不符合预期: ${raw.slice(0, 300)}`);
  }

  const toolCalls = Array.isArray(wire.tool_calls) && wire.tool_calls.length > 0 ? wire.tool_calls : undefined;

  // A tool-call turn legitimately carries `content: null`. Only a turn with
  // neither text nor tool calls is actually malformed.
  if (typeof wire.content !== "string" && !toolCalls) {
    throw new Error(`DeepSeek 响应结构不符合预期: ${raw.slice(0, 300)}`);
  }

  const message: ChatMessage = {
    role: "assistant",
    content: typeof wire.content === "string" ? wire.content : null,
  };
  if (toolCalls) message.tool_calls = toolCalls;
  if (typeof wire.reasoning_content === "string") message.reasoning_content = wire.reasoning_content;

  return {
    message,
    finishReason: choice?.finish_reason,
    model: parsed?.model ?? MODEL,
    usage: parsed?.usage,
  };
}

// ---------------------------------------------------------------------------
// Single-shot wrapper (the original public surface — unchanged semantics)
// ---------------------------------------------------------------------------

function buildMessages({ task, mode, files }: DeepSeekRequest): ChatMessage[] {
  const parts = [task];
  if (files) parts.push("\n\n--- 材料开始 ---\n", files, "\n--- 材料结束 ---\n");
  return [
    { role: "system", content: SYSTEM_PROMPTS[mode] },
    { role: "user", content: parts.join("") },
  ];
}

function hasText(turn: ModelTurn): boolean {
  return (turn.message.content ?? "").trim() !== "";
}

function toResult(turn: ModelTurn): DeepSeekResult {
  return { text: turn.message.content ?? "", model: turn.model, usage: turn.usage };
}

/**
 * What to say when reasoning ate the whole budget. The reasoning-token count is
 * the number that separates "raise the ceiling" from "split the task", so it is
 * reported rather than left for the operator to guess at.
 */
function truncatedByReasoning(turn: ModelTurn): string {
  const used = turn.usage?.completion_tokens_details?.reasoning_tokens;
  return (
    `DeepSeek 的推理过程占满了 max_tokens(${MAX_OUTPUT_TOKENS}),正文一个字都没写。` +
    (used === undefined ? "" : `本次推理用了 ${used} 个 token。`) +
    `调高 DEEPSEEK_MAX_OUTPUT_TOKENS,或把任务拆小。`
  );
}

/**
 * deepseek-flash returns `reasoning_content` alongside the answer, and sometimes
 * emits reasoning *only*: `content` comes back as an empty string. There are two
 * causes and they need opposite handling.
 *
 *  - `finish_reason: "stop"` — the model just stopped without writing anything.
 *    Transient, measured at roughly 1 call in 10, so one retry earns its keep.
 *  - `finish_reason: "length"` — reasoning consumed the entire `max_tokens`
 *    budget. **Not** transient: the trigger is the request, so re-sending it
 *    with the same budget truncates in the same place. Measured 2026-09-21 —
 *    both attempts returned `content: ""`, `finish_reason: "length"`,
 *    `reasoning_tokens: 4096`, exactly the budget. The old code retried anyway,
 *    which spent a second paid call and another ~20 s of the caller's tool-call
 *    window to arrive at the same empty answer and then explain it as "两次".
 *    It now fails on the first one and says which number to change.
 */
export async function callDeepSeek(req: DeepSeekRequest): Promise<DeepSeekResult> {
  const messages = buildMessages(req);

  const first = await chatCompletion({ messages });
  if (hasText(first)) return toResult(first);

  // The retry only makes sense when the model had nothing to call. On a
  // tool-call turn an empty `content` is the correct shape, not a transient
  // failure, and re-sending would duplicate the call.
  if (first.message.tool_calls?.length) return toResult(first);
  if (first.finishReason === "length") throw new Error(truncatedByReasoning(first));

  const second = await chatCompletion({ messages });
  if (hasText(second)) return toResult(second);
  if (second.finishReason === "length") throw new Error(truncatedByReasoning(second));

  throw new Error(
    `DeepSeek 连续两次没有返回正文:模型只产出推理内容就结束了` +
      `(finish_reason=${second.finishReason ?? "?"})。这是偶发情况,重试一次通常就能过;` +
      `连续两次都这样,说明任务本身太大或问得太散,把它拆小。`,
  );
}
