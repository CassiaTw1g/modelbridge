import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callDeepSeek, MODES } from "./deepseek.ts";
import type { Job, Registry } from "./agent/jobs.ts";
import { renderFlashText } from "./harness/flash.ts";
import { admit, type SandboxPolicy } from "./sandbox.ts";

/**
 * This description is the router. It is the only thing Sol reads when deciding
 * whether to spend a tool call on DeepSeek, so it states the *dispatch
 * conditions* rather than what the tool technically does.
 */
export const TOOL_DESCRIPTION = [
  "调用外部模型 DeepSeek V4.1 Flash 执行任务。DeepSeek 与 OpenAI 模型无关,独立推理,因此它的判断不共享本会话模型的同源偏置。",
  "",
  "适用场景:",
  "(1) 需要跨厂商独立复核的任务——安全审查、逻辑反例构造、对某个结论的对抗性验证。把实现或原始材料传进去,但不要传你自己的结论,否则独立性会被污染。",
  "(2) 大批量、低风险的机械性工作:摘要、分类、格式转换、批量文本处理。",
  "(3) 中等规模材料的检索与归纳:几万字的文本没问题,再大就要先拆分。",
  "",
  "不适用:需要读取真实文件、需要执行命令、或需要「运行→看报错→修改」多步迭代才能完成的任务——那些用 deepseek_agent_start。",
  "",
  "本工具无法访问文件系统,所有材料必须以文本形式通过 files 参数传入,**单次请求体上限 2MB**",
  "(材料必须由你原文粘贴进参数,所以要按这个上限裁剪)。DeepSeek 模型本身能读约 1M token,",
  "**但那是模型的能力,不是这条链路能传进去的量** —— 派发超长材料前请先拆分。",
  "",
  "## 返回有两种形态,注意区分",
  "",
  "DeepSeek 是推理模型,实测一次对抗性审查要 50 秒左右,而调用方的工具调用窗口通常只有 60 秒。",
  "所以本工具的返回可能是:",
  "",
  "- **直接是答案** —— 正常情况,照常用。",
  "- **一段带 job_id 的说明** —— 说明这次调用超过了同步等待窗口,**你还没有拿到答案**。",
  "  此时立即调用 deepseek_agent_poll(传入那个 job_id)并重复,直到它返回 done 或 error。",
  "  在拿到 done 之前,不要向用户报告任何结论,也不要自己代答这个问题。",
].join("\n");

/**
 * The description is a state machine, not a feature list. The failure it is
 * written against is specific: a calling model that receives `status:"running"`,
 * invents a conclusion, and reports it to the user as if the job had finished.
 * Nothing in the protocol can stop that — the only defence is making the
 * instruction unmissable and making "I have a result" checkable.
 */
const AGENT_START_DESCRIPTION = [
  "把一个需要真正动手的任务交给 DeepSeek 子代理执行。它运行在本机,可以读取工作区里的文件、修改文件、执行命令,并多步迭代直到任务完成。",
  "",
  "适用场景:",
  "(1) 需要读取真实文件内容才能回答的问题——子代理能自己打开文件,你不需要把内容贴进来。",
  "(2) 需要修改代码、运行程序、生成文件、批量处理文件的任务。",
  "(3) 需要「运行→看到报错→再修改」这种多步迭代才能完成的任务。",
  "",
  "不适用(请改用 deepseek_flash):纯分析、独立复核、评审——那些只需要文本进出,不需要动手。",
  "",
  "## 收到本工具的返回后,你必须遵守:",
  "",
  "返回里有一个 status 字段,只有两种可能:",
  "",
  '- status = "done":任务已完成。result 是最终答案,nonce 是验证码。',
  '- status = "running":任务还在后台跑,你拿到一个 job_id。此时你**还没有任何结果**。',
  "",
  '当且仅当 status = "running" 时,你必须立即调用 deepseek_agent_poll(传入那个 job_id),并重复调用直到它返回 done 或 error。',
  "",
  "在拿到 done 之前:",
  "- 不要向用户报告任何结论。",
  "- 不要描述任务进度——你没有收到过任何进度。",
  "- 不要猜测或补全结果。",
  "",
  "向用户报告时请附上 nonce 验证码。拿不到验证码,就说明你没有结果。",
].join("\n");

const POLL_DESCRIPTION = [
  "查询或等待 deepseek_agent_start / deepseek_flash 返回的任务。",
  "",
  "wait_seconds 默认 20 秒,上限 40 秒。在这段时间内它会阻塞等待,任务一旦结束就立刻返回——所以**不要高频轮询**,一次等久一点。",
  "",
  "返回的 status:",
  '- "running":还没结束。继续调用本工具,不要向用户报告任何东西。',
  '- "waiting_approval":任务暂停,在等人批准一条命令。把提示原文转告用户,让他到电脑上处理。',
  "- \"done\":结束了。此时才有结果和 nonce,可以报告给用户。",
  '- "error" / "cancelled":失败或被取消。把 error 原文转述给用户,不要自行修饰或淡化。',
  "  这类返回里可能还带一段「被中止前的半成品记录」。那是原始材料,不是结论:只能贴给用户看",
  "  并说明任务没跑完,或者用它把任务拆得更小再派一次。绝不能当成本次任务的结果报告。",
].join("\n");

/**
 * How long a tool call may block before it hands the caller a `job_id` instead
 * of an answer.
 *
 * 45 s is chosen against the caller, not against us. ChatGPT abandons a tool
 * call at around 60 s, so the response has to be on the wire well before that —
 * and there has to be room for the poll that follows. Measured worst case for a
 * single flash call is ~50 s, which is why the slow ones now go asynchronous
 * rather than being reported to the user as a failure.
 *
 * Read per call rather than at import time: it is a knob about *the caller's*
 * patience, and the offline tests need to shrink it to something that does not
 * cost 45 seconds of wall clock to exercise.
 */
function syncWindowMs(): number {
  const configured = Number(process.env.BRIDGE_SYNC_WINDOW_MS ?? "");
  return Number.isFinite(configured) && configured > 0 ? configured : 45_000;
}

/**
 * `Promise.race` does not cancel the loser, so the sync-window timer keeps
 * running long after the job has settled. Unref'd, it stops holding the process
 * open for 45 seconds after every single call — which matters on shutdown and
 * is what makes the test suite take a minute instead of a second.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}

/**
 * Used ONLY to stop waiting for a job — never forwarded into the job itself.
 *
 * The MCP SDK aborts a request handler's signal when the client disconnects,
 * and with a 45-second synchronous window that happens routinely (ChatGPT gives
 * up on a tool call at around 60s). Wiring that signal to the job's controller
 * would kill every job whose caller got impatient. The job owns its own
 * AbortController, created before any request exists.
 */
function waitForAbort(signal: AbortSignal | undefined): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (!signal) return; // never resolves; the race is decided by the others
    if (signal.aborted) return resolve("aborted");
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}

function isTerminal(job: Job): boolean {
  return job.state === "done" || job.state === "error" || job.state === "cancelled";
}

/**
 * Salvage from a run that was stopped early, rendered *after* the failure and
 * fenced with an explicit warning. The dangerous reading is that a survey cut
 * off halfway is a finished one, so the warning is repeated on both sides.
 */
function partialBlock(job: Job): string[] {
  if (!job.partial?.text) return [];
  return [
    "",
    "────────────",
    "⚠️ 不过它在被中止前已经做了一部分,下面是原始记录。**这不是结果,也没有核查完整**,",
    "不能算任务完成,更不要当成结论报告给用户。可以贴给用户看,但必须说明任务没跑完。",
    "用途:拿这些内容把任务拆得更小(比如只查其中一块)再派一次,比从头重跑省得多。",
    "────────────",
    job.partial.text,
    "────────────",
    "",
    "⚠️ 再说一次:上面是被中止的半成品,不是结果。",
  ];
}

/**
 * A finished flash job.
 *
 * Deliberately *not* the agent wording: there are no steps to report and no
 * sub-agent that did the work. The answer is the entire payload, and the nonce
 * is kept because the caller spent the wait being told it had nothing — so "I
 * have the answer now" needs to be checkable rather than rhetorical.
 */
function flashDone(job: Job): string {
  return [
    `✅ 回答好了。验证码:${job.nonce}`,
    "",
    "DeepSeek 的回答:",
    "────────────",
    job.result?.text ?? "",
    "────────────",
    "",
    `向用户报告时请附上验证码 ${job.nonce}。`,
  ].join("\n");
}

/**
 * Still running. The two kinds need different warnings: an agent job tempts the
 * caller into describing progress it never received, a flash job tempts it into
 * answering the question itself — which would quietly turn an independent
 * cross-check into the caller's own opinion wearing DeepSeek's name.
 */
function runningPayload(job: Job): string {
  const flash = job.kind === "flash";
  return [
    flash ? "⏳ DeepSeek 还在推理。**你目前还没有答案。**" : "⏳ 任务还在跑。**你目前没有任何结果。**",
    "",
    `job_id: ${job.id}`,
    `已跑:${Math.round((Date.now() - job.startedAt) / 1000)} 秒`,
    "",
    `**下一步行动**:立即调用 deepseek_agent_poll,参数 job_id="${job.id}"。`,
    "",
    flash
      ? '在拿到 status="done" 之前,不要向用户报告任何结论,也不要自己代答这个问题 —— 那就不是外部复核了。'
      : '在它返回 status="done" 之前,不要向用户报告任何结论、进度或结果——你没有收到过。',
  ].join("\n");
}

/** The payload doubles as the instruction — models weight the last result heavily. */
function jobPayload(job: Job): string {
  if (job.state === "done") {
    if (job.kind === "flash") return flashDone(job);
    return [
      `✅ 任务完成(${job.result?.steps ?? job.steps} 步)。验证码:${job.nonce}`,
      "",
      "子代理的最终结果:",
      "────────────",
      job.result?.text ?? "",
      "────────────",
      "",
      `向用户报告时请附上验证码 ${job.nonce}。`,
    ].join("\n");
  }

  if (job.state === "error") {
    return [
      "❌ 任务失败,没有产出可用结果。",
      "",
      "错误原文(请原样转述给用户,不要修饰,也不要替它猜一个答案):",
      job.error ?? "(无错误信息)",
      ...partialBlock(job),
    ].join("\n");
  }

  if (job.state === "cancelled") {
    return [`⛔ 任务已被取消,没有产出结果。`, "", job.error ?? "", ...partialBlock(job)].join("\n");
  }

  if (job.state === "waiting_approval") {
    return [
      "⏸ 任务暂停了——它在等待用户批准一条命令,你目前没有任何结果。",
      "",
      `job_id: ${job.id}`,
      "",
      "请把这句话转告用户:「子代理需要执行一条不在白名单里的命令,请到电脑上运行 `npm run ctl -- pending` 查看并批准。」",
      "",
      "然后向用户确认已处理,再调用 deepseek_agent_poll 继续等待。在 status 变成 done 之前,不要报告任何结论。",
    ].join("\n");
  }

  return runningPayload(job);
}

function errorText(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function createMcpServer(
  registry?: Registry,
  policy?: SandboxPolicy,
  /**
   * The registry that owns `deepseek_flash` calls.
   *
   * A second registry rather than a second kind of job in `registry`, because
   * the two would otherwise share one concurrency ceiling: an agent job holds a
   * slot for half an hour, and a flash job queued behind it would be refused
   * with "同时运行的任务已达上限". They also have different runners — the agent
   * registry's runner is the Claude Code harness, and pointing a flash call at
   * it would spawn a sub-agent to answer a question.
   *
   * Optional: without it the tool keeps its original synchronous behaviour,
   * which is what the offline tests and any embedding that has no job registry
   * rely on.
   */
  flashRegistry?: Registry,
): McpServer {
  // Must match package.json. It said 2.0.0 while the package said 1.0.0, so
  // every client was told a version this repository has never had.
  const server = new McpServer({ name: "modelbridge", version: "1.0.0" });

  server.registerTool(
    "deepseek_flash",
    {
      title: "DeepSeek V4.1 Flash 外部复核",
      description: TOOL_DESCRIPTION,
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe(
            "要 DeepSeek 完成的具体任务。写清目标、约束、期望的输出格式。独立复核场景下不要在此透露你自己的结论。",
          ),
        mode: z
          .enum(MODES)
          .optional()
          .describe(
            "任务类型,决定系统提示词。analyze=独立分析并给结论;review=对抗性审查/找缺陷与反例;code=产出代码;summarize=归纳要点。默认 analyze。",
          ),
        files: z
          .string()
          .optional()
          .describe(
            "要分析或审查的代码/文本材料,纯文本透传。DeepSeek 无法访问你的文件系统,内容必须贴在这里。" +
              "单次上限 2MB(请求体上限),超出请先拆分或改用 deepseek_agent_start。",
          ),
      },
    },
    async ({ task, mode, files }, extra) => {
      const resolved = mode ?? "analyze";

      const sync = async () => {
        try {
          return {
            content: [
              { type: "text" as const, text: renderFlashText(await callDeepSeek({ task, mode: resolved, files })) },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("deepseek_flash failed:", message);
          return errorText(`DeepSeek 调用失败:${message}`);
        }
      };

      if (!flashRegistry) return sync();

      let job: Job;
      try {
        job = flashRegistry.start({ kind: "flash", task, mode: resolved, files });
      } catch (err) {
        // The concurrency ceiling. Nothing has been sent yet, so this is a plain
        // refusal the caller can retry — not a failure to report as one.
        return errorText(err instanceof Error ? err.message : String(err));
      }

      console.log(
        `[${new Date().toISOString()}] flash_job ${job.id} mode=${resolved} task=${task.slice(0, 80)}`,
      );

      // The job is already running and owns its own AbortController, so losing
      // this race costs the caller nothing but the job_id — the answer is still
      // on its way and `deepseek_agent_poll` can collect it. That is the whole
      // point: the work no longer dies with the request that started it.
      await Promise.race([
        job.settled,
        sleep(syncWindowMs()),
        waitForAbort(extra?.signal as AbortSignal | undefined),
      ]);

      // Within the window the return shape is exactly what this tool has always
      // returned. Only the slow path — the one that used to end in a timeout —
      // changes, so a caller that ignores the job_id entirely still gets
      // everything it used to get.
      if (job.state === "done") {
        return { content: [{ type: "text" as const, text: job.result?.text ?? "" }] };
      }
      if (job.state === "error" || job.state === "cancelled") {
        const message = job.error ?? "(无错误信息)";
        console.error("deepseek_flash failed:", message);
        return errorText(
          job.state === "cancelled" ? `DeepSeek 调用被取消:${message}` : `DeepSeek 调用失败:${message}`,
        );
      }

      return { content: [{ type: "text" as const, text: jobPayload(job) }] };
    },
  );

  if (registry) {
    server.registerTool(
      "deepseek_agent_start",
      {
        title: "DeepSeek 子代理:派发一个需要动手的任务",
        description: AGENT_START_DESCRIPTION,
        inputSchema: {
          task: z
            .string()
            .min(1)
            .describe("要子代理完成的具体任务。写清目标、约束、期望产出。不要透露你自己的结论。"),
          workspace: z
            .string()
            .min(1)
            .describe(
              "允许子代理操作的目录(绝对路径)。它会以此为根读写文件、执行命令。必须落在服务端允许的根目录内。",
            ),
        },
      },
      async ({ task, workspace }, extra) => {
        if (!policy || policy.roots.length === 0) {
          return errorText(
            "agent 工具未配置工作区根目录,出于安全默认拒绝一切路径。\n" +
              "请在 .env 里设置 DEEPSEEK_ALLOWED_ROOTS(多个根目录用 ; 分隔),然后重启服务。",
          );
        }

        const admitted = admit(policy, workspace);
        if (!admitted.ok) {
          console.error(`agent_start 工作区被拒 (${admitted.code}): ${workspace}`);
          return errorText(
            `工作区被拒绝:[${admitted.code}] ${admitted.reason}\n` +
              "只有 DEEPSEEK_ALLOWED_ROOTS 里列出的根目录下的路径才允许使用。",
          );
        }

        let job: Job;
        try {
          job = registry.start({ task, workspace: admitted.realPath });
        } catch (err) {
          return errorText(err instanceof Error ? err.message : String(err));
        }

        console.log(
          `[${new Date().toISOString()}] agent_start ${job.id} workspace=${admitted.realPath} task=${task.slice(0, 80)}`,
        );

        // ChatGPT caps a single tool call near 60s; leave headroom. Note the
        // abort outcome is treated exactly like a timeout — the job keeps going
        // either way, because a client hanging up is not a reason to stop work.
        await Promise.race([
          job.settled,
          sleep(syncWindowMs()),
          waitForAbort(extra?.signal as AbortSignal | undefined),
        ]);

        return { content: [{ type: "text" as const, text: jobPayload(job) }] };
      },
    );
  }

  // One poll tool for both kinds, deliberately. A second one would mean the
  // caller has to pick the right one — and picking wrong is an error it cannot
  // recover from except by guessing again, which is a worse failure than a
  // slightly over-general name.
  if (registry || flashRegistry) {
    server.registerTool(
      "deepseek_agent_poll",
      {
        title: "DeepSeek:查询任务",
        description: POLL_DESCRIPTION,
        inputSchema: {
          job_id: z.string().min(1).describe("deepseek_agent_start / deepseek_flash 返回的 job_id。"),
          wait_seconds: z
            .number()
            .int()
            .min(0)
            .max(40)
            .optional()
            .describe("阻塞等待的秒数,默认 20,上限 40。任务提前结束会立刻返回。"),
        },
      },
      async ({ job_id, wait_seconds }) => {
        // Two registries, one id space — every id is timestamp+random and each
        // registry only holds what it started, so the first hit is the only hit.
        const job = registry?.get(job_id) ?? flashRegistry?.get(job_id);
        if (!job) {
          return errorText(
            `找不到任务 ${job_id}。它可能已经超出保留时间被清理。用 \`npm run ctl -- jobs\` 查看本机上的任务记录。`,
          );
        }

        if (!isTerminal(job)) {
          await Promise.race([job.settled, sleep(Math.min(Math.max(wait_seconds ?? 20, 0), 40) * 1000)]);
        }

        return { content: [{ type: "text" as const, text: jobPayload(job) }] };
      },
    );
  }

  return server;
}
