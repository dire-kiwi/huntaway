import { Cause, Context, Deferred, Effect, Exit, FiberSet, FileSystem, Layer, Ref } from "effect"
import { SecureRandom } from "effect/crypto"
import type { Rewind, RewindResult, RunId, Task, TaskId, Timestamp, Turn, TurnDiff, Turns } from "@huntaway/contracts"
import { nowTimestamp } from "../platform/columns.ts"
import { Events } from "../platform/Events.ts"
import { Actor } from "../platform/Changes.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { DataDir } from "../platform/DataDir.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound, Tasks } from "../tasks/Tasks.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import type { UserMessageData } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"
import { WriteNo } from "../threads/model.ts"
import { CheckpointRepo } from "./CheckpointRepo.ts"
import { broughtIn, names, numstat, turnStats, withoutFiles } from "./checkpoints/changed.ts"
import { conversation } from "./checkpoints/conversation.ts"
import type { Convo } from "./checkpoints/conversation.ts"
import { head, outputLines, snapshot, text, tools } from "./checkpoints/git.ts"
import type { Tools } from "./checkpoints/git.ts"
import { CheckpointFailed, CheckpointInvalid, CheckpointNotFound, MAX_CHECKPOINTS, MAX_DIFF, refName, refPrefix, RewindRefused } from "./checkpoints/model.ts"
import type { Checkpoint, Snap, TurnStatus } from "./checkpoints/model.ts"
import { restore, unstaged } from "./checkpoints/restore.ts"
import { Git } from "./Git.ts"

// Checkpoints of a task's worktree (docs/plan/06-server.md, Git; inventory 04, section 2.9; huntaway's
// git/checkpoints.ts and checkpoints/*), to see what each of its agent's turns changed and to rewind the task to before
// one of them.
//
// A checkpoint is a commit of everything in the worktree that git doesn't ignore (tracked files as they are on disk,
// and untracked ones), whose parent is the worktree's HEAD then, kept under `refs/huntaway/checkpoints/<task>/<n>`.
// It's made with a scratch index, `git add -A`, `write-tree` and `commit-tree`, so the worktree's index, branch and
// stashes are never touched. One is taken before each run starts when the files or HEAD have changed since the last
// one, and one when each of the agent's turns ends, stopped and failed ones too. Only tasks with a worktree of their
// own get them. A turn's message is its thread write number (`runs.write_no`, the old `turn_message_id`).
//
// Captures, rewinds and dropping a task's checkpoints run one at a time per task, in the order they were asked for: a
// worker fiber per task that has jobs, which goes once they're done (the old `QUEUES`).

export { pendingRewind } from "./checkpoints/conversation.ts"
export { CheckpointFailed, CheckpointInvalid, CheckpointNotFound, RewindRefused } from "./checkpoints/model.ts"
export type { Checkpoint, TurnStatus } from "./checkpoints/model.ts"

/** What a turn's checkpoint reads of its run (a `Run` row has it). */
export interface TurnRun {
  readonly id: RunId
  readonly task_id: TaskId
  readonly kind: string
  /** The thread write its turn started with; null for a turn the agent started by itself. */
  readonly write_no: number | null
  /** Its place in the agent's conversation. */
  readonly agent_at: string | null
}

/** What a run's start checkpoint and the plan rule read of a run. */
export interface StartedRun {
  readonly id: RunId
  readonly kind: string
  readonly created_at: Timestamp
}

/** Checkpoints a task keeps (`MAX_CHECKPOINTS`); tests lower it. */
export const CheckpointCap = Context.Reference<number>("huntaway-server/git/Checkpoints/CheckpointCap", { defaultValue: () => MAX_CHECKPOINTS })

export interface CheckpointsShape {
  /** Before a run of `task` starts (its worktree set up): a checkpoint, if the files or HEAD changed since the last one. */
  readonly beforeRun: (task: Task, run: StartedRun) => Effect.Effect<void>
  /** One of the agent's turns ended: a checkpoint of what it left, taken in the background after those asked for before. */
  readonly afterTurn: (run: TurnRun, status: TurnStatus) => Effect.Effect<void>
  /** Drop the task's checkpoints, refs and rows (its worktree at `repo` is going), after any being taken. */
  readonly forget: (task: TaskId, repo: string) => Effect.Effect<void>
  /** A task's checkpoints once those asked for are taken (tests, and what waits for them). */
  readonly settled: (task: TaskId) => Effect.Effect<ReadonlyArray<Checkpoint>>
  /**
   * Whether run `run` of `task` wrote or revised only its plan (HA-198): it has the plan label, wrote its plan and created
   * no tasks, and works in a folder of its own, or in a worktree whose files and HEAD none of its turns changed (once
   * their checkpoints are taken). False when that can't be told.
   */
  readonly planOnly: (task: Task, run: StartedRun) => Effect.Effect<boolean>
  /** The task's turns with checkpoints, what each changed, and whether each can be rewound to. */
  readonly turns: (task: TaskId) => Effect.Effect<Turns, TaskNotFound | CheckpointFailed>
  /** The changes from checkpoint `from` to `to`, without the files git brought in. */
  readonly turnDiff: (
    task: TaskId,
    from: number,
    to: number,
  ) => Effect.Effect<TurnDiff, TaskNotFound | CheckpointInvalid | CheckpointNotFound | RewindRefused | CheckpointFailed>
  /**
   * Restore the task's files to the checkpoint from before the turn message `message` started, and optionally its branch
   * and (on its next run) its agent's conversation. Refused while its agent or a review of it runs.
   */
  readonly rewind: (
    task: TaskId,
    message: number,
    options: { readonly conversation: boolean; readonly branch: boolean },
  ) => Effect.Effect<RewindResult, TaskNotFound | CheckpointInvalid | RewindRefused | CheckpointFailed>
  /** The agent's next run keeps its conversation as it is. */
  readonly cancelRewind: (task: TaskId) => Effect.Effect<Task, TaskNotFound>
  /**
   * A run of the task has started its agent, with the conversation rollback `used` (if it made one): the task's rollback
   * is done with, also one for another session than the run's.
   */
  readonly rewound: (task: TaskId, used: Rewind | null) => Effect.Effect<void>
}

/** The text a message starts with, for a turn's label. */
const label = (m: UserMessageData): string => {
  const t = (m.user_text ?? m.text).trim()
  return t.length > 300 ? `${t.slice(0, 299)}…` : t
}

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`

/** The git states in which a rewind waits for the user: a merge, rebase, cherry-pick or revert in progress. */
const IN_PROGRESS = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"]

/** A checkpoint row: `fields` over a row of nothing but its number and time. */
const row = (n: number, at: Timestamp, fields: Partial<Checkpoint> & Pick<Checkpoint, "kind" | "sha" | "tree" | "head">): Checkpoint => ({
  n,
  before_n: null,
  run_id: null,
  turn: null,
  write_no: null,
  status: null,
  session: null,
  agent_at: null,
  stats: null,
  stale: 0,
  created_at: at,
  ...fields,
})

export class Checkpoints extends Context.Service<Checkpoints, CheckpointsShape>()("huntaway-server/git/Checkpoints") {
  static readonly layer = Layer.effect(
    Checkpoints,
    Effect.gen(function* () {
      const git = yield* Git
      const fs = yield* FileSystem.FileSystem
      const random = yield* SecureRandom.SecureRandom
      const config = yield* ServerConfig
      const dataDir = yield* DataDir
      const repo = yield* CheckpointRepo
      const taskRepo = yield* TaskRepo
      const tasks = yield* Tasks
      const threads = yield* Threads
      const readers = yield* ThreadReaders
      const events = yield* Events
      const configs = yield* AgentConfigRepo
      const cap = yield* CheckpointCap
      const t: Tools = tools(git, fs, random.uuidV4())
      const workers = yield* FiberSet.make()

      // ---- the queue ----

      /** Each task's jobs not yet done, the one being run first. */
      const pending = yield* Ref.make<ReadonlyMap<TaskId, ReadonlyArray<Effect.Effect<void>>>>(new Map())

      /** Runs the task's jobs in order until there are none; the entry goes with the last. */
      const work = (task: TaskId): Effect.Effect<void> =>
        Effect.gen(function* () {
          let job = (yield* Ref.get(pending)).get(task)?.[0]
          while (job !== undefined) {
            yield* job
            job = yield* Ref.modify(pending, (all) => {
              const rest = (all.get(task) ?? []).slice(1)
              const next = new Map(all)
              if (rest.length === 0) next.delete(task)
              else next.set(task, rest)
              return [rest[0], next] as const
            })
          }
        })

      /** Run `job` after the task's jobs asked for before it. What it fails with is logged. */
      const enqueue = Effect.fnUntraced(function* <E>(task: TaskId, job: Effect.Effect<void, E>) {
        const safe = job.pipe(Effect.catchCause((cause) => Effect.logWarning(`task=${task} a checkpoint job failed`, cause)))
        const first = yield* Ref.modify(pending, (all) => {
          const queue = all.get(task)
          return [queue === undefined, new Map(all).set(task, [...(queue ?? []), safe])] as const
        })
        if (first) yield* FiberSet.run(workers, work(task))
      })

      /** Run `effect` in the task's queue and wait for it (what it fails with is failed here). */
      const queued = <A, E>(task: TaskId, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
        Effect.gen(function* () {
          const done = yield* Deferred.make<A, E>()
          yield* enqueue(
            task,
            Effect.flatMap(Effect.exit(effect), (exit) => Deferred.done(done, exit)),
          )
          return yield* Deferred.await(done)
        })

      // ---- worktrees ----

      const expand = (path: string) => (path === "~" ? config.home : path.startsWith("~/") ? `${config.home}${path.slice(1)}` : path)

      /** The folder a task works in instead of a worktree (a documents-only or scratch task's, or a pen's thread's). */
      const workDir = (task: Task): string | null => {
        if (task.kind !== "task") return null
        const d = task.work_dir
        if (d !== null && !d.startsWith("~") && !d.startsWith("/")) return `${dataDir.root}/${d}`
        if (d !== null) return expand(d)
        return task.task_type === "scratch" || task.task_type === "pen" ? dataDir.documents(task.id) : null
      }

      /**
       * The worktree a task's checkpoints are of: its own, once it's set up. Not a review thread's (it works in its
       * task's) nor a document's or scratch task's (they work in folders of their own).
       */
      const ownWorktree = Effect.fnUntraced(function* (task: Task) {
        if (task.kind !== "task" || !task.use_worktree || task.worktree_state !== "ready" || workDir(task) !== null) return null
        if (task.worktree_path === null) return null
        const path = expand(task.worktree_path)
        const info = yield* Effect.option(fs.stat(path))
        return info._tag === "Some" && info.value.type === "Directory" ? path : null
      })

      /** The top of a task's own worktree, if it has one that's ready. */
      const worktreeTop = Effect.fnUntraced(function* (task: Task) {
        const wt = yield* ownWorktree(task)
        if (wt === null) return null
        const o = yield* t.run(wt, ["rev-parse", "--show-toplevel"]).pipe(Effect.orElseSucceed(() => null))
        return o !== null && o.ok ? text(o.stdout) : null
      })

      const load = Effect.fnUntraced(function* (id: TaskId) {
        const task = yield* taskRepo.get(id)
        if (task === null) return yield* new TaskNotFound({ id })
        return task
      })

      /** Whether a run of `task` takes checkpoints. */
      const wanted = (task: Task, run: { readonly kind: string }) => (run.kind === "compact" ? Effect.succeed(null) : ownWorktree(task))

      // ---- keeping ----

      /** Store `snap` as the task's next checkpoint: its ref, then its row. */
      const keep = Effect.fnUntraced(function* (task: TaskId, top: string, snap: Snap, make: (n: number) => Checkpoint) {
        const n = yield* repo.nextN(task)
        const name = refName(task, n)
        yield* t.ok(top, ["update-ref", name, snap.sha])
        const c = make(n)
        yield* repo.insert(task, c).pipe(Effect.onError(() => t.run(top, ["update-ref", "-d", name]).pipe(Effect.ignore)))
        return c
      })

      /** Drop the task's oldest checkpoints past the cap. */
      const prune = Effect.fnUntraced(function* (task: TaskId, top: string) {
        const old = yield* repo.beyond(task, cap)
        if (old.length === 0) return
        yield* t.ok(top, ["update-ref", "--stdin"], { stdin: old.map((n) => `delete ${refName(task, n)}\n`).join("") })
        yield* repo.remove(task, old)
      })

      /** The top of the task's own worktree, which it must have. */
      const requireTop = Effect.fnUntraced(function* (id: TaskId) {
        const top = yield* worktreeTop(yield* load(id))
        if (top === null) return yield* new CheckpointFailed({ reason: "no worktree" })
        return top
      })

      const beforeRun = Effect.fn("Checkpoints.beforeRun")(function* (task: Task, run: StartedRun) {
        if ((yield* wanted(task, run)) === null) return
        const session = task.session_id
        yield* queued(
          task.id,
          Effect.gen(function* () {
            const top = yield* requireTop(task.id)
            const last = yield* repo.latest(task.id)
            const snap = yield* snapshot(t, top, last)
            if (last === null || last.tree !== snap.tree || last.head !== snap.head) {
              const at = yield* nowTimestamp
              yield* keep(task.id, top, snap, (n) => row(n, at, { kind: "start", sha: snap.sha, tree: snap.tree, head: snap.head, run_id: run.id, session }))
              yield* prune(task.id, top)
            }
          }),
        ).pipe(Effect.catchCause((cause) => Effect.logWarning(`task=${task.id} couldn't take a checkpoint before the run`, cause)))
      })

      const afterTurn = Effect.fn("Checkpoints.afterTurn")(function* (run: TurnRun, status: TurnStatus) {
        const task = yield* taskRepo.get(run.task_id)
        if (task === null || (yield* wanted(task, run)) === null) return
        // The session as the turn left it, read when it ended.
        const session = task.session_id
        yield* enqueue(
          task.id,
          Effect.gen(function* () {
            const top = yield* requireTop(task.id)
            const before = yield* repo.latest(task.id)
            const snap = yield* snapshot(t, top, before)
            const stats =
              before === null
                ? null
                : yield* turnStats(t, top, before, snap).pipe(
                    Effect.catchCause((cause) => Effect.as(Effect.logWarning(`task=${task.id} couldn't count a turn's changes`, cause), null)),
                  )
            const turn = yield* repo.nextTurn(task.id)
            const at = yield* nowTimestamp
            yield* keep(task.id, top, snap, (n) =>
              row(n, at, {
                kind: "turn",
                sha: snap.sha,
                tree: snap.tree,
                head: snap.head,
                before_n: before?.n ?? null,
                run_id: run.id,
                turn,
                write_no: run.write_no,
                status,
                session,
                agent_at: run.agent_at,
                stats,
              }),
            )
            yield* prune(task.id, top)
            yield* events.emit({ type: "checkpoints", task_id: task.id })
          }).pipe(Effect.catchCause((cause) => Effect.logWarning(`task=${task.id} couldn't take a checkpoint after a turn`, cause))),
        )
      })

      const forget = Effect.fn("Checkpoints.forget")(function* (task: TaskId, dir: string) {
        yield* queued(
          task,
          Effect.gen(function* () {
            const refs = yield* t.ok(dir, ["for-each-ref", "--format=delete %(refname)", refPrefix(task)])
            if (refs.length > 0) yield* t.ok(dir, ["update-ref", "--stdin"], { stdin: refs })
            yield* repo.removeAll(task)
          }),
        ).pipe(Effect.catchCause((cause) => Effect.logWarning(`task=${task} couldn't drop the task's checkpoints`, cause)))
      })

      const settled = (task: TaskId) => queued(task, repo.list(task))

      const planOnly = Effect.fn("Checkpoints.planOnly")(function* (task: Task, run: StartedRun) {
        if (task.kind !== "task" || run.kind !== "prompt" || !task.labels.includes("plan")) return false
        if (!(yield* repo.planWrittenSince(task.id, run.created_at)) || (yield* repo.createdTasksSince(task.id, run.created_at))) return false
        // A task that works in its own folder has no code to change; one in its project's repository has no checkpoints.
        if (workDir(task) !== null) return true
        if ((yield* ownWorktree(task)) === null) return false
        const all = yield* settled(task.id)
        const theirs = all.filter((c) => c.kind === "turn" && c.run_id === run.id)
        if (theirs.length === 0) return false
        return theirs.every((c) => {
          const before = all.find((b) => b.n === c.before_n)
          return c.stats !== null && c.stats.files === 0 && before !== undefined && before.head === c.head
        })
      })

      // ---- reading ----

      /** Whether the task's agent runs on Codex (its config's agent). */
      const isCodex = Effect.fnUntraced(function* (task: Task) {
        if (task.claude_config_id === null) return false
        const cfg = yield* configs.get(task.claude_config_id)
        return cfg._tag === "Some" && cfg.value.agent === "codex"
      })

      /** The checkpoints whose refs are still there. */
      const refsOf = Effect.fnUntraced(function* (task: TaskId, top: string) {
        const o = yield* t.run(top, ["for-each-ref", "--format=%(refname:lstrip=-1)", refPrefix(task)]).pipe(Effect.orElseSucceed(() => null))
        const have = new Set<number>()
        if (o === null) return have
        for (const l of outputLines(o.stdout)) if (/^[+-]?\d+$/.test(l.trim())) have.add(Number(l.trim()))
        return have
      })

      const turns = Effect.fn("Checkpoints.turns")(function* (id: TaskId) {
        const task = yield* load(id)
        const top = yield* worktreeTop(task)
        if (top === null) {
          const reason = task.use_worktree ? "the task's worktree isn't set up" : "the task works in its project's repository, not a worktree of its own"
          const none: Turns = { available: false, reason, turns: [], rewind: task.rewind }
          return none
        }
        const rows = yield* repo.list(id)
        const have = yield* refsOf(id, top)
        const messages = new Map<number, UserMessageData>()
        for (const r of rows) {
          if (r.write_no === null || messages.has(r.write_no)) continue
          const m = yield* readers.userMessage(id, WriteNo.make(r.write_no))
          if (m !== null) messages.set(r.write_no, m)
        }
        const first = yield* readers.firstUserMessage(id)
        const codex = yield* isCodex(task)
        const list = rows.flatMap((r): ReadonlyArray<Turn> => {
          if (r.kind !== "turn") return []
          const before = r.before_n !== null && have.has(r.before_n) && rows.some((x) => x.n === r.before_n) ? r.before_n : null
          const m = r.write_no === null ? undefined : messages.get(r.write_no)
          let files: string | null = null
          if (task.running) files = "the agent is running"
          else if (r.stale > 0) files = "a rewind has gone back to before this turn"
          else if (before === null) files = "there's no checkpoint from before this turn"
          else if (r.write_no === null) files = "the message this turn started with isn't known"
          const c = conversation(task.session_id, rows, r, codex, first)
          const round = m?.review_round
          return [
            {
              turn: r.turn ?? 0,
              n: r.n,
              before_n: before,
              run_id: r.run_id,
              message_id: r.write_no,
              text: m === undefined ? "" : label(m),
              auto: m?.auto === true,
              review_round: round !== undefined && Number.isInteger(round) && round >= 0 ? round : null,
              status: r.status,
              stale: r.stale > 0,
              at: r.created_at,
              head: r.head,
              before_head: before === null ? null : (rows.find((x) => x.n === before)?.head ?? null),
              stats: r.stats,
              diff: before !== null && have.has(r.n),
              rewind:
                files !== null
                  ? { ok: false, reason: files }
                  : { ok: true, conversation: "ok" in c ? { ok: true, fresh: c.ok._tag === "Fresh" } : { ok: false, reason: c.err } },
            },
          ]
        })
        const result: Turns = { available: true, turns: list, head: yield* head(t, top), rewind: task.rewind, agent: codex ? "codex" : "claude" }
        return result
      })

      /** Fails unless checkpoint `c`'s ref still names its commit. */
      const stillThere = Effect.fnUntraced(function* (task: TaskId, top: string, c: Checkpoint, detail: string) {
        const o = yield* t.run(top, ["rev-parse", "-q", "--verify", `${refName(task, c.n)}^{commit}`]).pipe(Effect.orElseSucceed(() => null))
        if (o === null || !o.ok || text(o.stdout) !== c.sha) return yield* new RewindRefused({ reason: "changed_meanwhile", detail })
        return c
      })

      const turnDiff = Effect.fn("Checkpoints.turnDiff")(function* (id: TaskId, fromN: number, toN: number) {
        const top = yield* worktreeTop(yield* load(id))
        if (top === null) return yield* new CheckpointInvalid({ field: "task_id", reason: "the task has no worktree" })
        const rows = yield* repo.list(id)
        const find = (n: number) => {
          const c = rows.find((r) => r.n === n)
          return c === undefined ? Effect.fail(new CheckpointNotFound({ n })) : Effect.succeed(c)
        }
        const from = yield* find(fromN)
        const to = yield* find(toN)
        for (const c of [from, to]) yield* stillThere(id, top, c, `checkpoint ${c.n} is gone from the repository`)
        const excluded = yield* broughtIn(t, top, from.head, to.head, to.tree)
        const s = yield* numstat(t, top, from.sha, to.sha, excluded)
        const raw = yield* t.ok(top, [
          "-c",
          "core.quotePath=false",
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-renames",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          from.sha,
          to.sha,
          "--",
        ])
        const patch = withoutFiles(new TextDecoder().decode(raw), new Set(s.leftOut))
        const tooLarge = new TextEncoder().encode(patch).length > MAX_DIFF
        const diff: TurnDiff = {
          patch: tooLarge ? "" : patch,
          too_large: tooLarge,
          stats: { files: s.files, additions: s.additions, deletions: s.deletions, excluded: s.leftOut.slice(0, 200), excluded_count: s.leftOut.length },
          excluded: s.leftOut,
        }
        return diff
      })

      // ---- rewinding ----

      /** Why the task can't be rewound now: its agent, or a review of it, is running. */
      const busy = Effect.fnUntraced(function* (task: Task) {
        if (task.running) return "The agent is running: stop it before rewinding"
        const reviews = yield* taskRepo.reviewThreads(task.id)
        if (reviews.some((r) => r.running)) return "A review of the task is running in its worktree: wait for it or stop it first"
        return null
      })

      const rewindNow = Effect.fnUntraced(function* (id: TaskId, message: number, options: { readonly conversation: boolean; readonly branch: boolean }) {
        const task = yield* load(id)
        const why = yield* busy(task)
        if (why !== null) return yield* new RewindRefused({ reason: "agent_running", detail: why })
        const top = yield* worktreeTop(task)
        if (top === null) return yield* new CheckpointInvalid({ field: "task_id", reason: "the task has no worktree of its own to rewind" })
        const gitDir = text(yield* t.ok(top, ["rev-parse", "--absolute-git-dir"]))
        for (const f of IN_PROGRESS) {
          if (yield* fs.exists(`${gitDir}/${f}`).pipe(Effect.orElseSucceed(() => false))) {
            return yield* new RewindRefused({
              reason: "in_use",
              detail: "A merge, rebase or cherry-pick is in progress in the worktree: finish or abort it first",
            })
          }
        }
        const rows = yield* repo.list(id)
        // The first turn the message started (the agent may have gone on by itself after it).
        const turn = rows.find((r) => r.kind === "turn" && r.write_no === message && r.stale === 0)
        if (turn === undefined) {
          return yield* new CheckpointInvalid({
            field: "message_id",
            reason: "there's no checkpoint for this message's turn (or a rewind has gone back past it)",
          })
        }
        const before = turn.before_n === null ? undefined : rows.find((r) => r.n === turn.before_n)
        if (before === undefined) return yield* new RewindRefused({ reason: "changed_meanwhile", detail: "there's no checkpoint from before this turn" })
        yield* stillThere(id, top, before, "the checkpoint from before this turn is gone from the repository")
        let convo: Convo = { _tag: "Nothing" }
        if (options.conversation) {
          const c = conversation(task.session_id, rows, turn, yield* isCodex(task), yield* readers.firstUserMessage(id))
          if ("err" in c) return yield* new RewindRefused({ reason: "changed_meanwhile", detail: `Can't take the conversation back: ${c.err}` })
          convo = c.ok
        }

        // The files as they are now, kept (stale) so the rewind can be undone by hand.
        const last = yield* repo.latest(id)
        const snap = yield* snapshot(t, top, last)
        const at = yield* nowTimestamp
        const kept = yield* keep(id, top, snap, (n) =>
          row(n, at, { kind: "rewind", sha: snap.sha, tree: snap.tree, head: snap.head, session: task.session_id, stale: 1 }),
        )
        const keptRef = refName(id, kept.n)

        // The branch goes back once the files have: checked first, so a refusal leaves everything as it was.
        let moved: readonly [old: string, current: string] | null = null
        if (before.head !== null && snap.head !== null && options.branch && before.head !== snap.head) {
          if (!(yield* git.isAncestor(top, before.head, snap.head))) {
            return yield* new RewindRefused({
              reason: "changed_meanwhile",
              detail: "The branch has been rewritten since (a rebase or reset), so it can't be moved back: rewind the files only",
            })
          }
          moved = [before.head, snap.head]
        }
        const restored = yield* Effect.gen(function* () {
          const done = yield* restore(t, top, snap.tree, before.tree)
          const unstage = new Set(done.changed)
          if (moved !== null) {
            const [old, current] = moved
            yield* t.ok(top, ["reset", "-q", "--soft", old])
            for (const p of yield* names(t, top, old, current)) if (!done.hidden.has(p)) unstage.add(p)
          }
          yield* unstaged(t, top, unstage)
          return done
        }).pipe(
          Effect.mapError(
            (e) =>
              new RewindRefused({
                reason: "changed_meanwhile",
                detail: `The rewind stopped part way: ${e.reason}. The files as they were are kept in ${keptRef} (${kept.sha}).`,
              }),
          ),
        )

        yield* repo.markStale(id, before.n, convo._tag === "Nothing" ? 1 : 2, kept.n)
        const n = turn.turn ?? 0
        const saidConvo =
          convo._tag === "Nothing"
            ? options.conversation
              ? "; the agent had no conversation to take back"
              : "; the agent's conversation is kept as it is"
            : convo._tag === "Fresh"
              ? "; the next message starts a new conversation"
              : "; the agent's next run goes on from before that message"
        const after =
          convo._tag === "Nothing"
            ? yield* load(id)
            : yield* tasks.change(id, () => (convo._tag === "Back" ? { rewind: convo.rewind } : { session_id: null, rewind: null, context: null }), Actor.user)
        const branch = moved === null ? "" : `; the branch is back at ${moved[0].slice(0, 8)} (from ${moved[1].slice(0, 8)})`
        let detail = `The files as they were are kept in ${keptRef} (${kept.sha}).`
        if (restored.skipped.length > 0) {
          detail +=
            "\nLeft as they are (submodules and other repositories, files marked skip-worktree or assume-unchanged, and files or folders the " +
            `checkpoints don't have, such as ignored ones): ${restored.skipped.join(", ")}`
        }
        yield* threads
          .notice(
            id,
            "info",
            `Rewound to before turn ${n}: ${plural(restored.written, "file")} restored, ${plural(restored.removed, "file")} removed${branch}${saidConvo}`,
            detail,
          )
          .pipe(Effect.ignore)
        yield* events.emit({ type: "checkpoints", task_id: id })
        // The message, for the user to edit and send again.
        const m = yield* readers.userMessage(id, WriteNo.make(message))
        const result: RewindResult = {
          message: { text: m === null ? null : (m.user_text ?? m.text), auto: m?.auto === true },
          task: after,
          written: restored.written,
          removed: restored.removed,
          skipped: restored.skipped,
          branch: moved === null ? null : { from: moved[1], to: moved[0] },
          kept: keptRef,
        }
        return result
      })

      const rewind = Effect.fn("Checkpoints.rewind")(function* (
        id: TaskId,
        message: number,
        options: { readonly conversation: boolean; readonly branch: boolean },
      ) {
        yield* load(id)
        return yield* queued(id, rewindNow(id, message, options))
      })

      const cancelRewind = Effect.fn("Checkpoints.cancelRewind")(function* (id: TaskId) {
        return yield* tasks.change(id, (task) => (task.rewind === null ? null : { rewind: null }), Actor.user)
      })

      const rewound = Effect.fn("Checkpoints.rewound")(function* (id: TaskId, used: Rewind | null) {
        const exit = yield* Effect.exit(tasks.change(id, (task) => (task.rewind === null ? null : { rewind: null }), Actor.board))
        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) yield* Effect.logWarning(`task=${id} clearing the conversation rollback`, exit.cause)
        if (used !== null) yield* threads.notice(id, "info", `The conversation goes on from before turn ${used.turn}`).pipe(Effect.ignore)
      })

      return Checkpoints.of({
        beforeRun,
        afterTurn,
        forget,
        settled,
        planOnly,
        turns,
        turnDiff,
        rewind,
        cancelRewind,
        rewound,
      })
    }),
  )
}
