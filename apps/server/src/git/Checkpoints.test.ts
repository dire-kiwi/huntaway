import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { ProfileId, ProjectId, RunId, TaskId, Timestamp } from "@huntaway/contracts"
import type { Task } from "@huntaway/contracts"
import { fakeAgent, git, tempDir, TestBoard } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { PLAN_READY } from "../runs/finish.ts"
import { LaunchFacts } from "../runs/LaunchFacts.ts"
import { RunEnds } from "../runs/RunEnds.ts"
import { RunOutput } from "../runs/RunOutput.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Threads } from "../threads/Threads.ts"
import { createsCommit, headerPath, withoutFiles } from "./checkpoints/changed.ts"
import { conversation } from "./checkpoints/conversation.ts"
import type { ConvoResult } from "./checkpoints/conversation.ts"
import type { Checkpoint } from "./checkpoints/model.ts"
import { refName, refPrefix } from "./checkpoints/model.ts"
import { CheckpointCap, Checkpoints } from "./Checkpoints.ts"

// The cases of huntaway's git/checkpoints/tests.test.ts, on the whole board's services with worktrees made by plain git
// (4.1's `Worktrees.setup` is not on this base): the task's worktree columns are set by hand. Left out: the two cases
// of a teardown (`checkpoints_go_with_the_worktree`'s teardown and `checkpoints_stay_while_the_worktree_does`), which
// are 4.1's: here `forget` is called as the teardown calls it, with the repository reached through a symlink.

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")

/** git in `dir`, which may clone from a folder (a submodule's). */
const sh = (dir: string, args: ReadonlyArray<string>) => git(dir, ["-c", "protocol.file.allow=always", ...args])

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/"))

const write = (path: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(dirOf(path), { recursive: true })
    yield* fs.writeFileString(path, text)
  }).pipe(Effect.orDie)

const read = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return Option.getOrNull(yield* Effect.option(fs.readFileString(path)))
  })

const exists = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return Option.isSome(yield* Effect.option(fs.lstat(path)))
  })

const remove = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(path, { recursive: true })
  }).pipe(Effect.orDie)

const files = (dir: string) => sh(dir, ["status", "--porcelain", "--untracked-files=all"])

const loadTask = (id: TaskId) =>
  Effect.gen(function* () {
    const t = yield* (yield* TaskRepo).get(id)
    return t === null ? yield* Effect.die(`task ${id} is gone`) : t
  })

const setColumns = (id: TaskId, columns: Parameters<TaskRepo["Service"]["write"]>[1]) =>
  Effect.gen(function* () {
    yield* (yield* TaskRepo).write(id, columns, AT)
  })

interface Fixture {
  readonly task: TaskId
  readonly wt: string
  readonly repo: string
}

/**
 * A task with a worktree, in a repository whose master has `f.txt`, `gone.txt` and a `.gitignore` for `*.log`, reached
 * through a symlink to it if `link`.
 */
const taskRepo = (options: { readonly link?: boolean; readonly labels?: ReadonlyArray<string> } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const fs = yield* FileSystem.FileSystem
    const repo = yield* tempDir
    yield* sh(repo, ["init", "-q", "-b", "master"])
    yield* write(`${repo}/f.txt`, Array.from({ length: 20 }, (_, i) => `${i + 1}\n`).join(""))
    yield* write(`${repo}/gone.txt`, "bye\n")
    yield* write(`${repo}/.gitignore`, "*.log\n")
    yield* sh(repo, ["add", "."])
    yield* sh(repo, ["commit", "-qm", "init"])
    let path = repo
    if (options.link === true) {
      path = `${yield* tempDir}/link`
      yield* fs.symlink(repo, path).pipe(Effect.orDie)
    }
    const wt = `${yield* tempDir}/wt`
    yield* sh(path, ["worktree", "add", "-q", "-b", "ia/x-1", wt, "master"])
    const n = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks`.pipe(Effect.map((rows) => rows[0]?.n ?? 0))
    const id = TaskId.make(`t-${n}`)
    const project = ProjectId.make(`pr-${n}`)
    yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('p', 'p', ${AT})`
    yield* sql`INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at)
      VALUES (${project}, 'p', ${`x${n}`}, ${`X${n}`}, ${path}, ${`${path}/s`}, ${`${path}/w`}, ${AT})`
    yield* sql`INSERT INTO tasks (id, profile_id, project_id, number, title, status, labels, use_worktree, worktree_state, worktree_path, branch, base_branch,
        last_activity_at, created_at, updated_at)
      VALUES (${id}, ${ProfileId.make("p")}, ${project}, 1, 'Do it', 'in_progress', ${`[${(options.labels ?? []).map((l) => `"${l}"`).join(",")}]`}, 1, 'ready', ${wt}, 'ia/x-1',
        'master', ${AT}, ${AT}, ${AT})`
    const fixture: Fixture = { task: id, wt, repo }
    return fixture
  }).pipe(Effect.orDie)

/** A run of the task that's started with a message `text`: the run's id and the message's write number. */
const start = (task: TaskId, text: string) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo
    const threads = yield* Threads
    const id = RunId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4())
    yield* runs.insert({ id, task_id: task, kind: "prompt", created_at: AT })
    yield* runs.setPhase(id, "running")
    const m = yield* threads.userMessage(task, text, {}).pipe(Effect.orDie)
    yield* runs.update(id, { write_no: m, agent_at: `at-${m}` })
    return { run: id, message: m }
  })

const runRow = (id: RunId) =>
  Effect.gen(function* () {
    const found = yield* (yield* RunRepo).get(id)
    return Option.isSome(found) ? found.value : yield* Effect.die(`run ${id} is gone`)
  })

/** A turn of the agent's: its run starts (with its checkpoint), `work` changes the files, and the turn ends. */
const turn = <E, R>(task: TaskId, text: string, work: Effect.Effect<unknown, E, R>) =>
  Effect.gen(function* () {
    const checkpoints = yield* Checkpoints
    const { run, message } = yield* start(task, text)
    yield* checkpoints.beforeRun(yield* loadTask(task), yield* runRow(run))
    yield* work
    yield* checkpoints.afterTurn(yield* runRow(run), "done")
    yield* checkpoints.settled(task)
    return message
  })

const rewind = (task: TaskId, message: number, convo: boolean, branch: boolean) =>
  Effect.gen(function* () {
    return yield* (yield* Checkpoints).rewind(task, message, { conversation: convo, branch })
  })

const turns = (task: TaskId) =>
  Effect.gen(function* () {
    const ts = yield* (yield* Checkpoints).turns(task).pipe(Effect.orDie)
    return ts.available ? ts : yield* Effect.die("no turns")
  })

const list = (task: TaskId) =>
  Effect.gen(function* () {
    return yield* (yield* Checkpoints).settled(task)
  })

const board = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

describe("Checkpoints", () => {
  it.effect("a checkpoint leaves the index, branch and stashes alone", () =>
    board(
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints
        const fs = yield* FileSystem.FileSystem
        const { task, wt } = yield* taskRepo()
        yield* write(`${wt}/f.txt`, "stashed\n")
        yield* sh(wt, ["stash", "push", "-q", "-m", "mine"])
        yield* write(`${wt}/staged.txt`, "s\n")
        yield* sh(wt, ["add", "staged.txt"])
        yield* write(`${wt}/f.txt`, "changed\n")
        yield* write(`${wt}/new/untracked.txt`, "u\n")
        yield* write(`${wt}/build.log`, "ignored\n")
        const gitDir = yield* sh(wt, ["rev-parse", "--absolute-git-dir"])
        const index = yield* fs.readFile(`${gitDir}/index`).pipe(Effect.orDie)
        const state = Effect.all(
          [sh(wt, ["rev-parse", "HEAD"]), sh(wt, ["branch", "--show-current"]), sh(wt, ["stash", "list", "--format=%H %gs"]), files(wt)],
          {
            concurrency: 1,
          },
        )
        const before = yield* state

        let { run } = yield* start(task, "go")
        yield* checkpoints.beforeRun(yield* loadTask(task), yield* runRow(run))
        const cps = yield* list(task)
        assert.deepStrictEqual(
          cps.map((c) => [c.kind, c.head]),
          [["start", before[0]]],
        )
        assert.deepStrictEqual(yield* fs.readFile(`${gitDir}/index`).pipe(Effect.orDie), index, "the index is untouched")
        assert.deepStrictEqual(yield* state, before)
        // Everything but ignored files, as it is on disk.
        const tree = yield* sh(wt, ["ls-tree", "-r", "--name-only", refName(task, 0)])
        assert.deepStrictEqual(tree.split("\n"), [".gitignore", "f.txt", "gone.txt", "new/untracked.txt", "staged.txt"])
        assert.strictEqual(yield* sh(wt, ["show", `${refName(task, 0)}:f.txt`]), "changed")
        const left = yield* fs.readDirectory(gitDir).pipe(Effect.orDie)
        assert.isTrue(
          left.every((e) => !e.startsWith("huntaway-")),
          "no scratch index left",
        )

        // Nothing new since: no second one.
        ;({ run } = yield* start(task, "again"))
        yield* checkpoints.beforeRun(yield* loadTask(task), yield* runRow(run))
        assert.strictEqual((yield* list(task)).length, 1)
      }),
    ),
  )

  it.effect("a file rewritten in the second the index was written is a change (HA-237)", () =>
    board(
      Effect.gen(function* () {
        // f.txt is rewritten at the same size and time as the index's entry for it, in the second the worktree's index
        // was written (as the agent's first edit after the checkout can be). Git reads such a file again rather than
        // trust the entry, which it can only tell from the index's own time. The ctime, which can't be set, is left out.
        const fs = yield* FileSystem.FileSystem
        const { task, wt } = yield* taskRepo()
        yield* sh(wt, ["config", "core.trustctime", "false"])
        const second = 1_700_000_000
        yield* fs.utimes(`${wt}/f.txt`, second, second).pipe(Effect.orDie)
        yield* sh(wt, ["update-index", "-q", "--refresh"])
        const index = yield* sh(wt, ["rev-parse", "--path-format=absolute", "--git-path", "index"])
        yield* fs.utimes(index, second, second).pipe(Effect.orDie)
        const before = (yield* read(`${wt}/f.txt`)) ?? ""
        const after = before.replace("1\n", "x\n")
        assert.strictEqual(after.length, before.length)
        yield* turn(
          task,
          "go",
          Effect.gen(function* () {
            yield* write(`${wt}/f.txt`, after)
            yield* fs.utimes(`${wt}/f.txt`, second, second).pipe(Effect.orDie)
          }),
        )
        const cp = (yield* list(task)).at(-1)
        assert.strictEqual(cp?.kind, "turn")
        assert.strictEqual(cp?.stats?.files, 1)
        assert.strictEqual(yield* sh(wt, ["show", `${cp?.sha}:f.txt`]), after.trim())
      }),
    ),
  )

  it.effect("turns show their own changes and a rewind restores the files", () =>
    board(
      Effect.gen(function* () {
        const { task, wt } = yield* taskRepo()
        yield* setColumns(task, { session_id: "sess" })
        yield* write(`${wt}/build.log`, "ignored\n")
        const m1 = yield* turn(
          task,
          "one",
          Effect.gen(function* () {
            yield* write(`${wt}/f.txt`, "one\n")
            yield* write(`${wt}/a.txt`, "a\n")
            yield* sh(wt, ["add", "-A"])
            yield* sh(wt, ["commit", "-qm", "turn one"])
            yield* remove(`${wt}/gone.txt`)
          }),
        )
        const headOne = yield* sh(wt, ["rev-parse", "HEAD"])
        const m2 = yield* turn(
          task,
          "two",
          Effect.gen(function* () {
            yield* write(`${wt}/f.txt`, "two\n")
            yield* write(`${wt}/dir/u.txt`, "untracked\n")
            yield* write(`${wt}/build.log`, "ignored, changed\n")
            yield* sh(wt, ["add", "f.txt"])
            yield* sh(wt, ["commit", "-qm", "turn two"])
            yield* write(`${wt}/a.txt`, "a, changed\n")
          }),
        )

        let ts = yield* turns(task)
        const [one, two] = ts.turns
        assert.deepStrictEqual([one?.turn, one?.message_id, one?.text], [1, m1, "one"])
        assert.deepStrictEqual([two?.turn, two?.stats?.files], [2, 3])
        assert.deepStrictEqual(two?.rewind, { ok: true, conversation: { ok: true, fresh: false } })
        // Turn 1 started the conversation: going back before it starts a new one.
        assert.deepStrictEqual(one?.rewind, { ok: true, conversation: { ok: true, fresh: true } })

        const d = yield* (yield* Checkpoints).turnDiff(task, two?.before_n ?? -1, two?.n ?? -1).pipe(Effect.orDie)
        assert.isTrue(d.patch.includes("+two") && d.patch.includes("dir/u.txt") && d.patch.includes("a, changed"), d.patch)
        assert.isFalse(d.patch.includes("gone.txt") || d.patch.includes("build.log"), d.patch)

        // Back to before turn 2, with its conversation.
        const r = yield* rewind(task, m2, true, false).pipe(Effect.orDie)
        assert.deepStrictEqual([r.written, r.removed], [2, 1])
        assert.deepStrictEqual([yield* read(`${wt}/f.txt`), yield* read(`${wt}/a.txt`)], ["one\n", "a\n"])
        assert.isFalse(yield* exists(`${wt}/dir`), "the folder it left empty goes too")
        assert.strictEqual(yield* read(`${wt}/build.log`), "ignored, changed\n", "ignored files are left alone")
        // The branch stays where it was: turn 2's commit is undone in the working tree.
        assert.strictEqual(yield* sh(wt, ["rev-parse", "HEAD^"]), headOne)
        assert.strictEqual(yield* files(wt), "M f.txt\n D gone.txt")
        let t: Task = yield* loadTask(task)
        assert.deepStrictEqual(t.rewind, { turn: 2, message_id: m2, session: "sess", resume_at: `at-${m1}` })
        assert.deepStrictEqual(
          (yield* list(task)).map((c) => [c.kind, c.stale]),
          [
            ["start", 0],
            ["turn", 0],
            ["turn", 2],
            ["rewind", 1],
          ],
        )
        // The files the rewind replaced are kept.
        assert.strictEqual(yield* sh(wt, ["show", `${r.kept}:a.txt`]), "a, changed")
        const again = yield* Effect.flip(rewind(task, m2, false, false))
        assert.strictEqual(again._tag, "CheckpointInvalid", "a stale turn can't be rewound to again")
        // The message, for the composer.
        assert.deepStrictEqual(r.message, { text: "two", auto: false })

        // The next turn starts from the rewound files.
        yield* turn(task, "three", write(`${wt}/c.txt`, "c\n"))
        ts = yield* turns(task)
        const three = ts.turns[2]
        assert.deepStrictEqual([three?.turn, three?.stats?.files, three?.stale], [3, 1, false])
        assert.isFalse(ts.turns[1]?.rewind.ok)

        // Back before turn 1 with the branch: the baseline, on its commit, and a new conversation.
        yield* rewind(task, m1, true, true).pipe(Effect.orDie)
        assert.notStrictEqual(yield* sh(wt, ["rev-parse", "HEAD"]), headOne)
        assert.strictEqual(yield* files(wt), "")
        assert.strictEqual(yield* read(`${wt}/gone.txt`), "bye\n")
        assert.isFalse((yield* exists(`${wt}/c.txt`)) || (yield* exists(`${wt}/a.txt`)))
        t = yield* loadTask(task)
        assert.deepStrictEqual([t.session_id, t.rewind], [null, null])
      }),
    ),
  )

  it.effect("rewinding waits for the agent and its reviews", () =>
    board(
      Effect.gen(function* () {
        const { task, wt } = yield* taskRepo()
        const m = yield* turn(task, "one", write(`${wt}/a.txt`, "a\n"))
        yield* setColumns(task, { running: true })
        const e = yield* Effect.flip(rewind(task, m, false, false))
        assert.deepStrictEqual([e._tag, e._tag === "RewindRefused" ? e.reason : null], ["RewindRefused", "agent_running"])
        assert.isFalse((yield* turns(task)).turns[0]?.rewind.ok)
        // A review of it running in its worktree.
        yield* setColumns(task, { running: false })
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO tasks (id, profile_id, kind, parent_id, title, running, last_activity_at, created_at, updated_at)
          VALUES ('review', 'p', 'review', ${task}, 'Review', 1, ${AT}, ${AT}, ${AT})`.pipe(Effect.orDie)
        const r = yield* Effect.flip(rewind(task, m, false, false))
        assert.isTrue(r._tag === "RewindRefused" && r.detail.includes("review"), r.message)
        yield* sql`UPDATE tasks SET running = 0 WHERE id = 'review'`.pipe(Effect.orDie)
        assert.isTrue(yield* exists(`${wt}/a.txt`))
        yield* rewind(task, m, false, false).pipe(Effect.orDie)
        assert.isFalse(yield* exists(`${wt}/a.txt`))
      }),
    ),
  )

  it.effect("files git hides are left alone", () =>
    board(
      Effect.gen(function* () {
        const { task, wt } = yield* taskRepo()
        // A submodule, a file marked skip-worktree and one marked assume-unchanged, each changed locally.
        const sub = yield* tempDir
        yield* sh(sub, ["init", "-q", "-b", "master"])
        yield* sh(sub, ["commit", "-q", "--allow-empty", "-m", "one"])
        yield* sh(wt, ["submodule", "add", "-q", sub, "sub"])
        yield* write(`${wt}/local.cfg`, "shared\n")
        yield* write(`${wt}/au.txt`, "shared\n")
        yield* sh(wt, ["add", "-A"])
        yield* sh(wt, ["commit", "-qm", "setup"])
        yield* sh(wt, ["update-index", "--skip-worktree", "local.cfg"])
        yield* sh(wt, ["update-index", "--assume-unchanged", "au.txt"])
        yield* write(`${wt}/local.cfg`, "mine\n")
        yield* write(`${wt}/au.txt`, "mine\n")
        const m = yield* turn(
          task,
          "one",
          Effect.gen(function* () {
            yield* sh(`${wt}/sub`, ["commit", "-q", "--allow-empty", "-m", "two"])
            yield* write(`${wt}/a.txt`, "a\n")
            yield* write(`${wt}/local.cfg`, "mine, changed\n")
          }),
        )
        const subHead = yield* sh(`${wt}/sub`, ["rev-parse", "HEAD"])
        const r = yield* rewind(task, m, false, false).pipe(Effect.orDie)
        assert.isFalse(yield* exists(`${wt}/a.txt`))
        assert.deepStrictEqual(r.skipped, ["sub"])
        assert.strictEqual(yield* sh(`${wt}/sub`, ["rev-parse", "HEAD"]), subHead, "the submodule's checkout is its own")
        assert.deepStrictEqual([yield* read(`${wt}/local.cfg`), yield* read(`${wt}/au.txt`)], ["mine, changed\n", "mine\n"])
        assert.strictEqual(yield* sh(wt, ["ls-files", "-v", "local.cfg", "au.txt"]), "h au.txt\nS local.cfg")
      }),
    ),
  )

  it.effect("a rewind never writes over what the checkpoints don't have", () =>
    board(
      Effect.gen(function* () {
        const { task, wt } = yield* taskRepo()
        yield* write(`${wt}/x`, "a file\n")
        yield* write(`${wt}/sub/file`, "a folder\n")
        yield* write(`${wt}/local.cfg`, "old\n")
        const m = yield* turn(
          task,
          "one",
          Effect.gen(function* () {
            // A file becomes a folder, with an ignored file and another repository in it.
            yield* remove(`${wt}/x`)
            yield* write(`${wt}/x/a`, "a\n")
            yield* write(`${wt}/x/keep.log`, "ignored\n")
            yield* write(`${wt}/x/vendor/f`, "theirs\n")
            yield* sh(`${wt}/x/vendor`, ["init", "-q"])
            yield* sh(`${wt}/x/vendor`, ["add", "f"])
            yield* sh(`${wt}/x/vendor`, ["commit", "-qm", "v"])
            yield* write(`${wt}/x/vendor/wip`, "uncommitted\n")
            // A folder becomes another repository.
            yield* remove(`${wt}/sub`)
            yield* write(`${wt}/sub/mine`, "mine\n")
            yield* sh(`${wt}/sub`, ["init", "-q"])
            yield* sh(`${wt}/sub`, ["add", "mine"])
            yield* sh(`${wt}/sub`, ["commit", "-qm", "s"])
            // A file the checkpoints had becomes ignored, and changes.
            yield* write(`${wt}/.gitignore`, "*.log\nlocal.cfg\n")
            yield* write(`${wt}/local.cfg`, "new\n")
          }),
        )
        const r = yield* rewind(task, m, false, false).pipe(Effect.orDie)
        assert.deepStrictEqual(r.skipped.toSorted(), ["local.cfg", "sub", "sub/file", "x", "x/vendor"])
        assert.isFalse(yield* exists(`${wt}/x/a`))
        assert.strictEqual(yield* read(`${wt}/x/keep.log`), "ignored\n")
        assert.strictEqual(yield* read(`${wt}/x/vendor/wip`), "uncommitted\n")
        assert.isTrue(yield* exists(`${wt}/x/vendor/.git`))
        assert.deepStrictEqual([yield* read(`${wt}/sub/mine`), yield* read(`${wt}/sub/file`)], ["mine\n", null])
        assert.strictEqual(yield* read(`${wt}/local.cfg`), "new\n")
        assert.strictEqual(yield* read(`${wt}/.gitignore`), "*.log\n")
      }),
    ),
  )

  it.effect("a rewind that fails part way leaves the branch alone", () =>
    board(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { task, wt } = yield* taskRepo()
        const m = yield* turn(
          task,
          "one",
          Effect.gen(function* () {
            yield* write(`${wt}/a.txt`, "a\n")
            yield* sh(wt, ["add", "a.txt"])
            yield* sh(wt, ["commit", "-qm", "a"])
            yield* write(`${wt}/ro/f.txt`, "f\n")
          }),
        )
        const head = yield* sh(wt, ["rev-parse", "HEAD"])
        // A file it can't remove.
        yield* fs.chmod(`${wt}/ro`, 0o555).pipe(Effect.orDie)
        const e = yield* Effect.flip(rewind(task, m, false, true))
        yield* fs.chmod(`${wt}/ro`, 0o755).pipe(Effect.orDie)
        assert.isTrue(e._tag === "RewindRefused" && e.detail.includes("part way") && e.detail.includes(refPrefix(task)), e.message)
        assert.strictEqual(yield* sh(wt, ["rev-parse", "HEAD"]), head)
        // Once it can, it goes through, branch and all.
        yield* rewind(task, m, false, true).pipe(Effect.orDie)
        assert.strictEqual(yield* sh(wt, ["rev-parse", "HEAD"]), yield* sh(wt, ["rev-parse", "master"]))
        assert.strictEqual(yield* files(wt), "")
      }),
    ),
  )

  it.effect("a rewind goes to before the first turn a message started", () =>
    board(
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints
        const { task, wt } = yield* taskRepo()
        const { run, message } = yield* start(task, "go")
        yield* checkpoints.beforeRun(yield* loadTask(task), yield* runRow(run))
        yield* write(`${wt}/a.txt`, "a\n")
        yield* checkpoints.afterTurn(yield* runRow(run), "done")
        // The agent goes on by itself (a background task finished), with no message of the user's.
        yield* (yield* RunRepo).update(run, { write_no: null })
        yield* write(`${wt}/b.txt`, "b\n")
        yield* checkpoints.afterTurn(yield* runRow(run), "done")
        const cps = yield* list(task)
        assert.deepStrictEqual(
          cps.filter((c) => c.kind === "turn").map((c) => [c.turn, c.write_no]),
          [
            [1, message],
            [2, null],
          ],
        )
        yield* rewind(task, message, false, false).pipe(Effect.orDie)
        assert.isFalse((yield* exists(`${wt}/a.txt`)) || (yield* exists(`${wt}/b.txt`)))
      }),
    ),
  )

  it.effect("a rewind never follows a symlink out of the worktree", () =>
    board(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { task, wt } = yield* taskRepo()
        const outside = yield* tempDir
        yield* write(`${outside}/keep.txt`, "keep\n")
        const m = yield* turn(
          task,
          "one",
          Effect.gen(function* () {
            yield* fs.symlink(outside, `${wt}/out`).pipe(Effect.orDie)
            yield* write(`${wt}/d/x.txt`, "x\n")
          }),
        )
        // A folder the turn made becomes a symlink to the outside afterwards.
        yield* remove(`${wt}/d`)
        yield* fs.symlink(outside, `${wt}/d`).pipe(Effect.orDie)
        yield* write(`${outside}/x.txt`, "outside\n")
        yield* rewind(task, m, false, false).pipe(Effect.orDie)
        assert.isFalse(yield* exists(`${wt}/out`))
        assert.strictEqual(yield* read(`${outside}/keep.txt`), "keep\n")
        assert.strictEqual(yield* read(`${outside}/x.txt`), "outside\n")
      }),
    ),
  )

  it.effect("files a merge brought in are left out of a turn", () =>
    board(
      Effect.gen(function* () {
        const { task, wt, repo } = yield* taskRepo()
        yield* write(`${wt}/mine.txt`, "mine\n")
        yield* sh(wt, ["add", "-A"])
        yield* sh(wt, ["commit", "-qm", "mine"])
        // Master moves on meanwhile, in the main checkout.
        yield* write(`${repo}/theirs.txt`, "theirs\n")
        yield* write(`${repo}/f.txt`, "master's\n")
        yield* sh(repo, ["add", "-A"])
        yield* sh(repo, ["commit", "-qm", "theirs"])
        yield* turn(
          task,
          "merge",
          Effect.gen(function* () {
            // A merge with a conflict, resolved, and a change of its own.
            yield* write(`${wt}/f.txt`, "branch's\n")
            yield* sh(wt, ["commit", "-qam", "branch f"])
            yield* Effect.ignore(sh(wt, ["merge", "-q", "master"]))
            assert.isTrue(yield* exists(`${yield* sh(wt, ["rev-parse", "--absolute-git-dir"])}/MERGE_HEAD`), "a conflict")
            yield* write(`${wt}/f.txt`, "resolved\n")
            yield* sh(wt, ["add", "f.txt"])
            yield* sh(wt, ["commit", "-q", "--no-edit"])
            yield* write(`${wt}/own.txt`, "own\n")
          }),
        )
        const one = (yield* turns(task)).turns[0]
        assert.deepStrictEqual(one?.stats?.excluded, ["theirs.txt"])
        const d = yield* (yield* Checkpoints).turnDiff(task, one?.before_n ?? -1, one?.n ?? -1).pipe(Effect.orDie)
        assert.isTrue(d.patch.includes("+resolved") && d.patch.includes("own.txt") && !d.patch.includes("theirs.txt"), d.patch)
        assert.deepStrictEqual(d.excluded, ["theirs.txt"])
      }),
    ),
  )

  it.effect("files a rebase went onto are left out of a turn", () =>
    board(
      Effect.gen(function* () {
        const { task, wt, repo } = yield* taskRepo()
        yield* write(`${wt}/mine.txt`, "mine\n")
        yield* sh(wt, ["add", "-A"])
        yield* sh(wt, ["commit", "-qm", "mine"])
        yield* write(`${repo}/more.txt`, "more\n")
        yield* sh(repo, ["add", "-A"])
        yield* sh(repo, ["commit", "-qm", "more"])
        yield* turn(
          task,
          "rebase",
          Effect.gen(function* () {
            yield* write(`${wt}/own.txt`, "own\n")
            yield* sh(wt, ["add", "-A"])
            yield* sh(wt, ["commit", "-qm", "own"])
            yield* sh(wt, ["rebase", "-q", "master"])
          }),
        )
        let ts = yield* turns(task)
        assert.deepStrictEqual(ts.turns[0]?.stats?.excluded, ["more.txt"])
        assert.strictEqual(ts.turns[0]?.stats?.files, 1)
        // Pulled in by a fast-forward: all of it is left out.
        yield* write(`${repo}/ff.txt`, "ff\n")
        yield* sh(repo, ["add", "-A"])
        yield* sh(repo, ["commit", "-qm", "ff"])
        const master = yield* sh(repo, ["rev-parse", "master"])
        yield* turn(task, "ff", sh(wt, ["reset", "-q", "--hard", master]))
        ts = yield* turns(task)
        assert.strictEqual(ts.turns[1]?.stats?.files, 2)
      }),
    ),
  )

  it.effect("checkpoints go with the worktree (forget), in a repository reached through a symlink", () =>
    board(
      Effect.gen(function* () {
        const { task, wt, repo } = yield* taskRepo({ link: true })
        yield* turn(task, "one", write(`${wt}/a.txt`, "a\n"))
        const refs = Effect.map(sh(repo, ["for-each-ref", "--format=%(refname)", refPrefix(task)]), (out) => out.split("\n").filter((l) => l !== "").length)
        assert.strictEqual(yield* refs, 2)
        yield* (yield* Checkpoints).forget(task, repo)
        assert.strictEqual(yield* refs, 0)
        assert.strictEqual((yield* list(task)).length, 0)
      }),
    ),
  )

  it.effect("the oldest checkpoints go past the cap", () =>
    Effect.gen(function* () {
      const checkpoints = yield* Checkpoints
      const { task, wt } = yield* taskRepo()
      for (let i = 0; i < 8; i++) {
        const { run } = yield* start(task, `go ${i}`)
        yield* write(`${wt}/n.txt`, `${i}\n`)
        yield* checkpoints.afterTurn(yield* runRow(run), "done")
      }
      const cps = yield* list(task)
      assert.strictEqual(cps.length, 5)
      assert.strictEqual(cps[0]?.n, 3)
      const refs = (yield* sh(wt, ["for-each-ref", "--format=%(refname)", refPrefix(task)])).split("\n")
      assert.strictEqual(refs.length, 5)
      assert.isFalse(refs.includes(refName(task, 2)))
    }).pipe(
      Effect.scoped,
      // A cap of 5 rather than 200, so that it takes 8 turns to go past it rather than 203.
      Effect.provide(TestBoard().pipe(Layer.provide(Layer.succeed(CheckpointCap, 5)))),
    ),
  )
})

const cp = (n: number, turnNo: number | null, session: string, at: string | null, stale: number): Checkpoint => ({
  n,
  kind: turnNo !== null ? "turn" : "start",
  sha: "",
  tree: "",
  head: null,
  before_n: n - 1,
  run_id: null,
  turn: turnNo,
  write_no: turnNo !== null ? turnNo * 10 : null,
  status: null,
  session,
  agent_at: at,
  stats: null,
  stale,
  created_at: AT,
})

const resume = (at: string, turnNo: number): ConvoResult => ({
  ok: { _tag: "Back", rewind: { turn: turnNo, message_id: turnNo * 10, session: "s", resume_at: at } },
})

const Json = Schema.fromJsonString(Schema.Unknown)

/** The agent writes `lines`, and the line handler takes each in, as the follower hands them on. */
const output = (agent: FakeAgent, lines: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const handler = yield* RunOutput
    const fs = yield* FileSystem.FileSystem
    for (const line of lines) {
      yield* agent.write([line])
      const end = Number((yield* fs.stat(`${agent.dir}/out.jsonl`).pipe(Effect.orDie)).size)
      yield* handler.handle(yield* agent.row, yield* Schema.encodeEffect(Json)(line).pipe(Effect.orDie), end)
    }
  })

const result = (subtype: string) => ({ type: "result", subtype, is_error: subtype !== "success", total_cost_usd: 0, num_turns: 1, session_id: "s1" })

/** A run of the task by the fake agent, started with a message (its checkpoint before it taken, as its launch takes it). */
const agentRun = (task: TaskId, text: string) =>
  Effect.gen(function* () {
    const agent = yield* fakeAgent({ task })
    const m = yield* (yield* Threads).userMessage(task, text, {}).pipe(Effect.orDie)
    yield* (yield* RunRepo).update(agent.run.id, { write_no: m })
    yield* (yield* Checkpoints).beforeRun(yield* loadTask(task), agent.run)
    return { agent, message: m }
  })

const ended = (agent: FakeAgent, code = 0) =>
  Effect.gen(function* () {
    yield* (yield* RunEnds).ended({ _tag: "RunExited", run: agent.run.id, task: agent.run.task_id, exit: { code, signal: null }, errorTail: "" })
  })

describe("checkpoints through a run", () => {
  it.effect("a turn's end takes one with its message, and a turn a run never ended takes one at the run's end", () =>
    board(
      Effect.gen(function* () {
        const { task, wt } = yield* taskRepo()
        const first = yield* agentRun(task, "one")
        yield* write(`${wt}/a.txt`, "a\n")
        yield* output(first.agent, [result("success")])
        let cps = yield* list(task)
        assert.deepStrictEqual(
          cps.map((c) => [c.kind, c.turn, c.write_no, c.status, c.stats?.files ?? null]),
          [
            ["start", null, null, null, null],
            ["turn", 1, first.message, "done", 1],
          ],
        )
        // The message is the turn's: one the agent starts by itself has none.
        assert.strictEqual((yield* first.agent.row).write_no, null)
        yield* ended(first.agent)

        // Killed mid-turn: its checkpoint comes with the run's end.
        const second = yield* agentRun(task, "two")
        yield* write(`${wt}/b.txt`, "b\n")
        yield* ended(second.agent, 1)
        cps = yield* list(task)
        assert.deepStrictEqual(cps.at(-1) && [cps.at(-1)?.kind, cps.at(-1)?.write_no, cps.at(-1)?.status], ["turn", second.message, "failed"])
      }),
    ),
  )

  it.effect("a run that only writes the plan waits for the user; one that does the work goes to review", () =>
    board(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const { task, wt } = yield* taskRepo({ labels: ["plan"] })
        let version = 0
        /** A new version of the plan, written after the run's start. */
        const writePlan = Effect.gen(function* () {
          version += 1
          yield* sql`INSERT INTO documents (task_id, label, version, content, created_at, updated_at)
            VALUES (${task}, 'plan', ${version}, '<h1>Plan</h1>', '2026-11-12T00:00:01.000Z', '2026-11-12T00:00:01.000Z')`.pipe(Effect.orDie)
        })
        /** One run of one turn: the plan written, and `work` done. */
        const planRun = <E, R>(work: Effect.Effect<unknown, E, R>, plan = true) =>
          Effect.gen(function* () {
            yield* setColumns(task, { status: "in_progress", running: true, attention_reason: null })
            const { agent } = yield* agentRun(task, "Go on")
            if (plan) yield* writePlan
            yield* work
            yield* output(agent, [result("success")])
            yield* ended(agent)
            const t = yield* loadTask(task)
            return [t.status, t.attention_reason]
          })
        assert.deepStrictEqual(yield* planRun(Effect.void), ["needs_attention", PLAN_READY])
        // Feedback on it, and a revision: it waits again.
        assert.deepStrictEqual(yield* planRun(Effect.void), ["needs_attention", PLAN_READY])
        // It ticks off the plan's steps as it changes the code...
        assert.deepStrictEqual(yield* planRun(write(`${wt}/f.txt`, "2\n")), ["in_review", null])
        // ...or commits it.
        const commit = Effect.gen(function* () {
          yield* write(`${wt}/g.txt`, "new\n")
          yield* sh(wt, ["add", "."])
          yield* sh(wt, ["commit", "-qm", "work"])
        })
        assert.deepStrictEqual(yield* planRun(commit), ["in_review", null])
        // A commit of a change made before the run (by the user, say) moves HEAD only.
        yield* write(`${wt}/f.txt`, "3\n")
        assert.deepStrictEqual(yield* planRun(sh(wt, ["commit", "-qam", "more"])), ["in_review", null])
        // Breaking the approved plan into tasks is doing the work too.
        const breakUp = sql`INSERT INTO tasks (id, profile_id, title, created_by, last_activity_at, created_at, updated_at)
          VALUES ('step-1', 'p', 'Step 1', ${task}, ${AT}, '2026-11-12T00:00:02.000Z', ${AT})`.pipe(Effect.orDie)
        assert.deepStrictEqual(yield* planRun(breakUp), ["in_review", null])
        // A question answered without touching the plan, and a task without the label.
        assert.deepStrictEqual(yield* planRun(Effect.void, false), ["in_review", null])
        yield* setColumns(task, { labels: [] })
        assert.deepStrictEqual(yield* planRun(Effect.void), ["in_review", null])
      }),
    ),
  )

  it.effect("a plan task that works in its own folder has no code to change", () =>
    board(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const { task } = yield* taskRepo({ labels: ["plan"] })
        yield* setColumns(task, { use_worktree: false, worktree_state: "none", worktree_path: null, work_dir: `documents/${task}` })
        const { agent } = yield* agentRun(task, "Plan it")
        yield* sql`INSERT INTO documents (task_id, label, version, content, created_at, updated_at)
          VALUES (${task}, 'plan', 1, '<h1>Plan</h1>', '2026-11-12T00:00:01.000Z', '2026-11-12T00:00:01.000Z')`.pipe(Effect.orDie)
        yield* output(agent, [result("success")])
        yield* ended(agent)
        const t = yield* loadTask(task)
        assert.deepStrictEqual([t.status, t.attention_reason], ["needs_attention", PLAN_READY])
      }),
    ),
  )

  it.effect("the next run takes the conversation back, and is done with the rollback once its agent starts", () =>
    board(
      Effect.gen(function* () {
        const { task } = yield* taskRepo()
        const rollback = { turn: 2, message_id: 7, session: "sess", resume_at: "u1" }
        yield* setColumns(task, { session_id: "sess", rewind: rollback })
        const { agent } = yield* agentRun(task, "again")
        const prepared = yield* (yield* LaunchFacts).claude(agent.run, "again")
        const args = prepared.spec.args
        assert.strictEqual(args[args.indexOf("--resume-session-at") + 1], "u1")
        assert.deepStrictEqual(prepared.rewind, rollback)
        yield* (yield* Checkpoints).rewound(task, prepared.rewind ?? null)
        assert.strictEqual((yield* loadTask(task)).rewind, null)
        const items = (yield* (yield* Threads).stored(task).pipe(Effect.orDie)).entries.map((e) => e.item)
        assert.isTrue(items.some((i) => i.type === "notice" && i.text === "The conversation goes on from before turn 2"))
        // One for another session is not made, and goes too.
        yield* setColumns(task, { rewind: { ...rollback, session: "other" } })
        const other = yield* (yield* LaunchFacts).claude(agent.run, "again")
        assert.isFalse(other.spec.args.includes("--resume-session-at"))
        yield* (yield* Checkpoints).rewound(task, other.rewind ?? null)
        assert.strictEqual((yield* loadTask(task)).rewind, null)
        // The user keeps the whole conversation instead.
        yield* setColumns(task, { rewind: rollback })
        assert.strictEqual((yield* (yield* Checkpoints).cancelRewind(task).pipe(Effect.orDie)).rewind, null)
      }),
    ),
  )
})

describe("conversation", () => {
  it("goes back to the turn before still in it", () => {
    const rows = [cp(0, null, "s", null, 0), cp(1, 1, "s", "u1", 0), cp(2, 2, "s", "u2", 2), cp(3, 3, "s", "u3", 1), cp(4, 4, "s", "u4", 0)]
    const [r0, r1, , r3, r4] = rows
    if (r0 === undefined || r1 === undefined || r3 === undefined || r4 === undefined) return assert.fail("rows")
    const back = (t: Checkpoint, codex: boolean) => conversation("s", rows, t, codex, 10)
    // Turn 2 was taken out of the conversation already; turn 3 only had its files rewound.
    assert.deepStrictEqual(back(r4, false), resume("u3", 4))
    assert.deepStrictEqual(back(r3, false), resume("u1", 3))
    assert.deepStrictEqual(back(r1, false), { ok: { _tag: "Fresh" } })
    assert.deepStrictEqual(back(r4, true), { ok: { _tag: "Back", rewind: { turn: 4, message_id: 40, session: "s", before_turn: "u4" } } })
    assert.deepStrictEqual(back(r1, true), { ok: { _tag: "Fresh" } })
    // A new session since, or no record of where the conversation was.
    assert.isTrue("err" in conversation("other", rows, r4, false, 10))
    assert.isTrue("err" in conversation("other", rows, r4, true, 10))
    assert.isTrue("err" in conversation("s", rows, r1, false, 5))
    assert.deepStrictEqual(conversation(null, rows, r4, false, 10), { ok: { _tag: "Nothing" } })
    return undefined
  })
})

describe("diffs", () => {
  it("reads diff headers, leaves files out of a patch, and tells commits made here", () => {
    assert.strictEqual(headerPath("diff --git a/x y b/x y"), "x y")
    assert.strictEqual(headerPath("diff --git a/a b/c b/a b/c"), "a b/c")
    assert.strictEqual(headerPath('diff --git "a/t\\tab" "b/t\\tab"'), "t\tab")
    assert.strictEqual(headerPath('diff --git "a/\\303\\251" "b/\\303\\251"'), "é")
    const patch = "diff --git a/k b/k\n+k\ndiff --git a/x b/x\n+x\ndiff --git a/k2 b/k2\n+k2\n"
    assert.strictEqual(withoutFiles(patch, new Set(["x"])), "diff --git a/k b/k\n+k\ndiff --git a/k2 b/k2\n+k2\n")
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      ["commit: x", true],
      ["commit (amend): x", true],
      ["commit (merge): Merge branch 'master'", true],
      ["merge master: Merge made by the 'ort' strategy.", true],
      ["rebase (pick): x", true],
      ["pull --rebase (pick): x", true],
      ["cherry-pick: x", true],
      ["merge master: Fast-forward", false],
      ["pull: Fast-forward", false],
      ["rebase (finish): returning to refs/heads/x", false],
      ["rebase (start): checkout master", false],
      ["reset: moving to HEAD~1", false],
      ["checkout: moving from a to b", false],
    ]
    for (const [subject, made] of cases) assert.strictEqual(createsCommit(subject), made, subject)
  })
})
