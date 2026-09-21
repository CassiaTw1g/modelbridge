import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeepSeekMode, Usage } from "../deepseek.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Job state lives on disk, not just in memory, for two reasons:
 *
 *  1. `npm run ctl` is a *separate process* from the server. A file is the
 *     cheapest channel that works across that boundary without adding an
 *     endpoint — and adding a control endpoint would widen the attack surface
 *     of a process whose whole security model is "one secret URL".
 *  2. When the server restarts, a job that was running leaves a record behind,
 *     so a lost result is recoverable rather than simply gone.
 */
export const STATE_DIR = process.env.BRIDGE_STATE_DIR ?? join(ROOT, ".state");
const JOBS_DIR = join(STATE_DIR, "jobs");
const CANCEL_DIR = join(STATE_DIR, "cancel");

export type JobState = "running" | "waiting_approval" | "done" | "error" | "cancelled";

/**
 * What kind of work a job is.
 *
 * The registry used to hold one shape of job and one only — a Claude Code
 * harness run, with a workspace, a step count and an approval queue — because
 * that was the only thing it ran. `deepseek_flash` then needed the same
 * machinery (id, nonce, state, salvage, TTL, a cross-process kill) for a
 * different animal entirely: one chat completion. No workspace, no tools, no
 * steps to count, nothing a human ever approves.
 *
 * Naming the difference is the point. The alternative was to file a flash call
 * as an agent job with most of its fields blank, which is a record that lies
 * about what ran — the exact failure this file already carries a comment about,
 * from when every record named a harness that had not been chosen.
 */
export type JobKind = "agent" | "flash";

export interface JobEvent {
  at: number;
  step: number;
  type: "model" | "tool" | "note" | "error";
  name?: string;
  detail?: string;
}

export interface JobResult {
  text: string;
  steps: number;
  usage?: Usage;
  /**
   * Set when the runner stopped before finishing, with the reason. The job
   * still settles as `error` — a half-finished review is not a review — but the
   * text is kept so the work is not simply thrown away.
   */
  incomplete?: string;
}

export interface Job {
  id: string;
  /** Revealed only in the terminal result — see `nonce` in `start()`. */
  nonce: string;
  state: JobState;
  kind: JobKind;
  task: string;
  mode: DeepSeekMode;
  /**
   * Absent on a flash job: a single chat completion touches no files, so there
   * is no directory it was allowed to work in and inventing one — the process
   * cwd, say — would put a path in the record that nothing ever enforced.
   */
  workspace?: string;
  /** Which runner executed it. Supplied by the caller via `harnessName`. */
  harness: string;
  startedAt: number;
  finishedAt?: number;
  steps: number;
  result?: JobResult;
  /** Salvage from a run that was stopped early. Never a substitute for `result`. */
  partial?: JobResult;
  error?: string;
  events: JobEvent[];
  /** Resolves on the first terminal state. Never rejects. */
  settled: Promise<void>;
}

export interface JobInput {
  task: string;
  /** Defaults to `"agent"` — the shape every existing caller meant. */
  kind?: JobKind;
  /**
   * On an agent job: recorded, not honoured — the Claude Code harness picks its
   * own behaviour from the task text. The `deepseek_agent_start` schema no
   * longer offers it, because a parameter that does nothing is worse than no
   * parameter: the caller plans around it. Kept because it is part of the job
   * record. On a flash job it *is* honoured: it selects the system prompt.
   */
  mode?: DeepSeekMode;
  workspace?: string;
  /**
   * Material for a flash job, passed through verbatim to the model.
   *
   * Deliberately **not** copied into the job record: it is capped at 2 MB and
   * `snapshot()` writes the whole record to disk on every state change, so
   * carrying it would mean rewriting megabytes of caller material to
   * `.state/jobs` several times per call — and putting it in front of `ctl
   * jobs`, which prints records.
   */
  files?: string;
}

export interface JobContext {
  jobId: string;
  /** Job-scoped. Owned by the registry — NEVER wired to a request's signal. */
  signal: AbortSignal;
  /** How the harness reports progress; feeds `ctl jobs --trace`. */
  record: (event: Omit<JobEvent, "at">) => void;
  setSteps: (n: number) => void;
  setWaitingApproval: (waiting: boolean) => void;
  /** Cross-process kill switch: `.state/cancel/<job_id>`. */
  checkCancelled: () => boolean;
}

export type JobRunner = (input: JobInput, ctx: JobContext) => Promise<JobResult>;

export interface RegistryOptions {
  /** A job is up to N model calls; keep this well under the tool rate limit. */
  maxConcurrent?: number;
  hardWallMs?: number;
  /** How long a finished job stays retrievable before it is swept. */
  resultTtlMs?: number;
  stateDir?: string;
  /**
   * Written into every job record. The registry cannot work this out for
   * itself — all it sees is a `JobRunner` function — so whoever picked the
   * runner has to say which one they picked. This used to be the literal
   * `"pending"`, which nothing ever overwrote: every record named a harness
   * that had not been chosen, which is a lie in the one structure that exists
   * to be a record.
   */
  harnessName?: string;
}

export interface Registry {
  start(input: JobInput): Job;
  get(id: string): Job | undefined;
  list(): Job[];
  cancel(id: string): boolean;
  shutdown(): void;
}

const MAX_EVENTS = 400;

/**
 * What `mode` means when the caller did not say. The two runners disagree on
 * purpose: the harness overwrites the task text into its own prompt and this
 * field only tags the record, whereas a flash job's `mode` *is* its system
 * prompt — and "写出代码" is the wrong prompt for "帮我复核这段逻辑".
 */
const DEFAULT_MODE: Record<JobKind, DeepSeekMode> = { agent: "code", flash: "analyze" };

/**
 * Short, pronounceable, unambiguous — no O/0 or I/1, so a model reciting it
 * back has to have actually received it. This nonce is the only defence against
 * a caller confabulating a result it never got: the value is returned *only* in
 * the terminal payload, so "I have the answer" is checkable rather than
 * rhetorical.
 *
 * `randomInt`, not `Math.random`: the nonce is the one value in this system
 * that an interested party might want to *predict*. Math.random is not
 * cryptographic, and 74 bits of predictable output is not the same thing as 74
 * bits of entropy. Cheap to fix, so it is fixed.
 */
function makeNonce(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = () => alphabet[randomInt(alphabet.length)];
  const block = () => pick() + pick() + pick() + pick();
  return `${block()}-${pick()}${pick()}${pick()}`;
}

function makeJobId(): string {
  const t = Date.now().toString(36);
  const r = randomInt(0, 36 ** 6).toString(36).padStart(6, "0");
  return `${t}-${r}`;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface JobRecord extends Job {
  controller: AbortController;
  settle: () => void;
}

export function createRegistry(run: JobRunner, opts: RegistryOptions = {}): Registry {
  const maxConcurrent = opts.maxConcurrent ?? 2;
  // No step limit here on purpose: this layer cannot count steps — only the
  // runner sees the model's tool calls. It used to read a `maxSteps` option and
  // never use it, which read as "the registry enforces 24 steps" while the real
  // ceiling lived somewhere else entirely.
  const hardWallMs = opts.hardWallMs ?? 20 * 60_000;
  // Matched to the runner's default job timeout (30 min) rather than the 10
  // minutes this used to be: a job that ran for 25 minutes and finished could
  // be swept before its caller ever polled, and "找不到任务" reads like a lost
  // result — the natural response is to dispatch the whole thing again.
  const resultTtlMs = opts.resultTtlMs ?? 30 * 60_000;
  const harnessName = opts.harnessName ?? "unknown";

  const stateDir = opts.stateDir ?? STATE_DIR;
  const jobsDir = join(stateDir, "jobs");
  const cancelDir = join(stateDir, "cancel");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(cancelDir, { recursive: true });

  const jobs = new Map<string, JobRecord>();

  function snapshot(rec: JobRecord): void {
    const { controller: _c, settle: _s, settled: _p, ...plain } = rec;
    try {
      writeFileSync(join(jobsDir, `${rec.id}.json`), JSON.stringify(plain, null, 2), "utf8");
    } catch {
      // Disk is a nicety here, not a correctness requirement. A job must not
      // die because the state directory went away.
    }
  }

  function isCancelled(id: string): boolean {
    return existsSync(join(cancelDir, `${id}.json`));
  }

  function settleWith(rec: JobRecord, state: JobState, patch: Partial<JobRecord> = {}): void {
    if (rec.state === "done" || rec.state === "error" || rec.state === "cancelled") return;
    rec.state = state;
    rec.finishedAt = Date.now();
    Object.assign(rec, patch);
    snapshot(rec);
    rec.settle();
  }

  function activeCount(): number {
    let n = 0;
    for (const rec of jobs.values()) if (rec.state === "running" || rec.state === "waiting_approval") n++;
    return n;
  }

  function sweep(): void {
    const now = Date.now();
    for (const [id, rec] of jobs) {
      const finished = rec.state === "done" || rec.state === "error" || rec.state === "cancelled";
      if (finished && now - (rec.finishedAt ?? 0) > resultTtlMs) {
        jobs.delete(id);
        try {
          rmSync(join(jobsDir, `${id}.json`), { force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }

  const sweeper = setInterval(sweep, 60_000);
  sweeper.unref();

  return {
    start(input: JobInput): Job {
      if (activeCount() >= maxConcurrent) {
        throw new Error(
          `同时运行的任务已达上限(${maxConcurrent})。等当前任务结束,或用 \`npm run ctl -- jobs\` 查看在用任务。`,
        );
      }

      const { promise: settled, resolve: settle } = deferred();

      const kind: JobKind = input.kind ?? "agent";

      const rec: JobRecord = {
        id: makeJobId(),
        nonce: makeNonce(),
        state: "running",
        kind,
        task: input.task,
        // The fallback follows the kind rather than being one constant. A flash
        // job left to default to the agent default would run its `analyze`
        // system prompt while its own record said `code`.
        mode: input.mode ?? DEFAULT_MODE[kind],
        workspace: input.workspace,
        harness: harnessName,
        startedAt: Date.now(),
        steps: 0,
        events: [],
        settled,
        controller: new AbortController(),
        settle,
      };
      jobs.set(rec.id, rec);
      snapshot(rec);

      // The hard wall clock is the backstop for a job whose runner ignores its
      // signal, or a model that keeps finding one more thing to try.
      const wallTimer = setTimeout(() => {
        rec.controller.abort();
        settleWith(rec, "error", { error: `任务超过 ${Math.round(hardWallMs / 60_000)} 分钟硬上限,已中止。` });
      }, hardWallMs);
      wallTimer.unref();

      const ctx: JobContext = {
        jobId: rec.id,
        signal: rec.controller.signal,
        record(event) {
          rec.events.push({ at: Date.now(), ...event });
          if (rec.events.length > MAX_EVENTS) rec.events.splice(0, rec.events.length - MAX_EVENTS);
        },
        setSteps(n) {
          rec.steps = n;
        },
        setWaitingApproval(waiting) {
          if (rec.state === "done" || rec.state === "error" || rec.state === "cancelled") return;
          rec.state = waiting ? "waiting_approval" : "running";
          snapshot(rec);
        },
        checkCancelled: () => isCancelled(rec.id) || rec.controller.signal.aborted,
      };

      void run(input, ctx)
        .then((result) => {
          clearTimeout(wallTimer);
          const salvage = result.incomplete ? result : undefined;
          if (rec.controller.signal.aborted || isCancelled(rec.id)) {
            settleWith(rec, "cancelled", { error: "任务被取消。", partial: salvage });
            return;
          }
          // Stopped early by the runner: filed as an error, never as a success.
          // `partial` carries what it did manage, so the caller can narrow the
          // task instead of starting over from nothing.
          if (result.incomplete) {
            settleWith(rec, "error", { error: result.incomplete, partial: result });
            return;
          }
          settleWith(rec, "done", { result });
        })
        .catch((err: unknown) => {
          clearTimeout(wallTimer);
          const message = err instanceof Error ? err.message : String(err);
          // Both ways of cancelling have to be checked here. `ctl job kill`
          // arrives as a *file*, not as an abort, so a killed job used to settle
          // as `error` — and the caller was then told the sub-agent had failed
          // when in fact a person had stopped it. Those are different events and
          // the payload says different things about each.
          const cancelled = rec.controller.signal.aborted || isCancelled(rec.id);
          settleWith(rec, cancelled ? "cancelled" : "error", { error: message });
        });

      return rec;
    },

    get(id: string): Job | undefined {
      return jobs.get(id);
    },

    list(): Job[] {
      return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
    },

    cancel(id: string): boolean {
      const rec = jobs.get(id);
      // Write the sentinel even for a job we do not know about: the running
      // server may hold a job this process never started.
      try {
        mkdirSync(cancelDir, { recursive: true });
        writeFileSync(join(cancelDir, `${id}.json`), JSON.stringify({ at: Date.now() }), "utf8");
      } catch {
        /* best effort */
      }
      if (!rec) return false;
      rec.controller.abort();
      settleWith(rec, "cancelled", { error: "任务被取消。" });
      return true;
    },

    shutdown(): void {
      clearInterval(sweeper);
      for (const rec of jobs.values()) {
        if (rec.state === "running" || rec.state === "waiting_approval") rec.controller.abort();
      }
    },
  };
}

/** Read job snapshots left on disk by the server (used by `ctl jobs`). */
export function readJobSnapshots(stateDir = STATE_DIR): Job[] {
  const dir = join(stateDir, "jobs");
  if (!existsSync(dir)) return [];
  const out: Job[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as Job;
      out.push(parsed);
    } catch {
      /* skip corrupt snapshot */
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}
