import { TIMEOUT_MS, callDeepSeek, type DeepSeekResult } from "../deepseek.ts";
import type { JobRunner } from "../agent/jobs.ts";

/**
 * The other runner — no harness at all.
 *
 * `claude-code.ts` hands a task to a sub-agent and watches it work. This one is
 * a single chat completion, the same call `deepseek_flash` has always made,
 * wrapped in a job record so a long think cannot outlive the caller's tool-call
 * window. Measured 2026-09-21: one adversarial review took 50 s against a
 * ChatGPT tool window of roughly 60 s. It fitted — barely — and a task that
 * wanted to think for another ten seconds would have been reported to the user
 * as a failure even though the answer arrived moments later.
 *
 * Nothing here is allowed to touch the filesystem, so there is no workspace, no
 * approval queue and no step count that means anything. The registry's `kind`
 * field is what keeps that difference visible in the record.
 */

/**
 * Above any real use, far below anything that could hurt the machine.
 *
 * A synchronous `deepseek_flash` call held no slot at all — calls simply piled
 * up as HTTP requests — so this ceiling is new, and it needs to be high enough
 * never to be the thing that fails. What actually bounds the bridge is the rate
 * limit (60 `tools/call` per minute); this is only here so wedged jobs cannot
 * accumulate without limit. One caller polls one job at a time, so 8 is already
 * generous.
 */
export const FLASH_MAX_CONCURRENT = 8;

/**
 * `callDeepSeek` may make two requests (its comment on retries explains which
 * empties are worth retrying), each carrying its own `TIMEOUT_MS`, so the
 * runner's worst case is twice that.
 *
 * The registry's hard wall has to sit *behind* it. When the wall fires first it
 * becomes the real ceiling, and it reports what it did as a plain cancellation —
 * which says nothing about why the job stopped, only that it did.
 */
export const FLASH_HARD_WALL_MS = 2 * TIMEOUT_MS + 60_000;

/**
 * How often a flash job looks for the cross-process kill sentinel.
 *
 * Cheap enough to be worth it: without it, `npm run ctl -- job kill` on a flash
 * job would appear to do nothing for up to three minutes and then file the
 * completed answer as cancelled — a paid-for result thrown away, and an
 * operator watching `ctl jobs` with no way to tell whether the kill landed.
 */
const CANCEL_POLL_MS = 1000;

/**
 * The answer plus its usage footer.
 *
 * Assembled in one place because two callers need the identical string: the
 * tool's synchronous path (which has to keep returning exactly what it always
 * has) and the job's result, which is rendered later from the record.
 */
export function renderFlashText(result: DeepSeekResult): string {
  const { prompt_tokens, completion_tokens } = result.usage ?? {};
  if (prompt_tokens == null && completion_tokens == null) return result.text;
  return `${result.text}\n\n[deepseek: ${result.model} | ${prompt_tokens ?? "?"} in / ${completion_tokens ?? "?"} out]`;
}

export const flashRunner: JobRunner = async (input, ctx) => {
  const mode = input.mode ?? "analyze";
  ctx.record({
    step: 0,
    type: "note",
    detail: `直连调用 mode=${mode}${input.files ? `,材料 ${input.files.length} 字符` : ""}`,
  });

  // `ctx.signal` covers an in-process cancel; the sentinel covers `job kill`,
  // which arrives as a file written by a different process. Both have to reach
  // the fetch, or cancel means "stop paying attention" rather than "stop".
  const cancelled = new AbortController();
  const watcher = setInterval(() => {
    if (ctx.checkCancelled()) cancelled.abort();
  }, CANCEL_POLL_MS);
  watcher.unref();

  try {
    const result = await callDeepSeek({
      task: input.task,
      mode,
      files: input.files,
      signal: AbortSignal.any([ctx.signal, cancelled.signal]),
    });
    // One model call is the whole job. `steps` counts model calls here, not tool
    // calls — `ctl jobs` labels a flash row differently rather than printing a
    // step count nothing ever incremented.
    ctx.setSteps(1);
    return { text: renderFlashText(result), steps: 1, usage: result.usage };
  } finally {
    clearInterval(watcher);
  }
};
