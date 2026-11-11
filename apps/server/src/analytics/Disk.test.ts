import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { SqlClient } from "effect/sql"
import { ProfileId } from "@huntaway/contracts"
import { tempDir, TestBoard } from "@huntaway/testing"
import { DataDir } from "../platform/DataDir.ts"
import { Disk, RUNS_KEPT_DAYS } from "./Disk.ts"

// The old disk.test.ts, on the board's data folder and a temp folder of fake repositories and worktrees. Dropped: "the
// API's report, made in a worker thread, is the same" (no worker: the walk is asynchronous here).

const AT = "2026-09-01T00:00:00.000Z"

const write = (p: string, bytes: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.dirname(p), { recursive: true })
    yield* fs.writeFile(p, new Uint8Array(bytes).fill(120))
  }).pipe(Effect.orDie)

/** A linked worktree of `repo` at `dir`, as `git worktree add` leaves it, holding `bytes`. */
const fakeWorktree = (repo: string, dir: string, bytes: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const admin = path.join(repo, ".git/worktrees", path.basename(dir))
    yield* fs.makeDirectory(admin, { recursive: true })
    yield* fs.writeFileString(path.join(admin, "commondir"), "../..\n")
    yield* write(path.join(dir, "file"), bytes)
    yield* fs.writeFileString(path.join(dir, ".git"), `gitdir: ${admin}\n`)
  }).pipe(Effect.orDie)

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

describe("Disk", () => {
  it.effect("sizes skip nested folders and count hard links once", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const disk = yield* Disk
        const root = `${yield* tempDir}/r`
        yield* write(`${root}/a`, 10_000)
        yield* write(`${root}/sub/b`, 10_000)
        yield* write(`${root}/skipme/c`, 50_000)
        yield* fs.link(`${root}/a`, `${root}/sub/a-link`)
        const all = yield* disk.dirSize(root, [])
        const part = yield* disk.dirSize(root, [`${root}/skipme`])
        assert.strictEqual(all?.files, 3)
        assert.strictEqual(part?.files, 2)
        assert.isTrue((part?.bytes ?? 0) >= 20_000 && (part?.bytes ?? 0) < (all?.bytes ?? 0))
        assert.isNull(yield* disk.dirSize(`${root}/missing`, []))
      }),
    ),
  )

  it.effect("reports repositories, worktrees and stray folders", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const data = yield* DataDir
        const tmp = yield* tempDir
        const repo = `${tmp}/repo`
        yield* write(`${repo}/src/main.rs`, 8_000)
        yield* write(`${repo}/.git/objects/pack`, 40_000)
        const wts = `${data.projectDir("p1")}/worktrees`
        yield* sql`INSERT INTO profiles (id, name, created_at) VALUES ('me', 'me', ${AT})`
        yield* sql`INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at)
          VALUES ('p1', 'me', 'Proj', 'PRJ', ${repo}, ${`${data.projectDir("p1")}/scratch`}, ${wts}, ${AT})`
        yield* write(`${wts}/1-one/big`, 100_000)
        yield* fakeWorktree(repo, `${wts}/old`, 20_000)
        // Not a worktree, so not the project's to clear up.
        yield* write(`${wts}/notes/todo`, 1_000)
        yield* write(`${data.projectDir("p1")}/scratch/notes`, 4_000)
        yield* sql`INSERT INTO tasks (id, profile_id, project_id, kind, number, title, status, worktree_path, last_activity_at, created_at, updated_at)
          VALUES ('t1', 'me', 'p1', 'task', 1, 'One', 'done', ${`${wts}/1-one`}, ${AT}, ${AT}, ${AT}),
                 ('t2', 'me', 'p1', 'task', 2, 'Gone', 'todo', ${`${wts}/2-gone`}, ${AT}, ${AT}, ${AT}),
                 ('t3', 'me', NULL, 'task', 3, 'Chat', 'todo', NULL, ${AT}, ${AT}, ${AT})`
        // Runs of its tasks, and of a task in no project.
        yield* sql`INSERT INTO runs (id, task_id, kind, status, created_at) VALUES ('r1', 't1', 'prompt', 'exited', ${AT}),
          ('r2', 't1', 'prompt', 'exited', ${AT}), ('r3', 't3', 'prompt', 'exited', ${AT}), ('r4', 't2', 'prompt', 'exited', ${AT})`
        yield* write(`${data.runDir("r1")}/out.jsonl`, 30_000)
        yield* write(`${data.runDir("r2")}/out.jsonl`, 1_000)
        yield* write(`${data.runDir("r2")}/err.log`, 1_000)
        yield* write(`${data.runDir("r3")}/out.jsonl`, 5_000)
        const r = yield* (yield* Disk).report(ProfileId.make("me"))
        assert.strictEqual(r.projects.length, 1)
        const p = r.projects[0]
        assert.strictEqual(p?.repo?.files, 3)
        // The pack, and the stray worktree's commondir.
        assert.strictEqual(p?.git?.files, 2)
        assert.isAtLeast(p?.git?.bytes ?? 0, 40_000)
        assert.deepStrictEqual(
          p?.worktrees.map((w) => [w.task_id, w.size.files]),
          [
            ["t1", 1],
            [null, 2],
          ],
        )
        assert.isAtLeast(p?.worktrees[0]?.size.bytes ?? 0, 100_000)
        assert.strictEqual(p?.other.files, 1)
        // r4's folder is gone.
        assert.strictEqual(p?.runs.files, 3)
        assert.isAtLeast(p?.runs.bytes ?? 0, 32_000)
        assert.strictEqual(r.runs.files, 1)
        assert.strictEqual(r.runs_kept_days, RUNS_KEPT_DAYS)
        const gone = yield* Effect.flip((yield* Disk).report(ProfileId.make("nobody")))
        assert.strictEqual(gone._tag, "NotFound")
      }),
    ),
  )

  it.effect("a shared worktrees folder counts only the repository's worktrees no task has as stray", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const shared = `${yield* tempDir}/code`
        const [a, b] = [`${shared}/a`, `${shared}/b`]
        yield* write(`${a}/.git/HEAD`, 10)
        yield* write(`${b}/.git/HEAD`, 10)
        yield* fakeWorktree(a, `${shared}/a-1`, 1_000)
        yield* fakeWorktree(b, `${shared}/b-1`, 1_000)
        yield* fakeWorktree(a, `${shared}/a-old`, 1_000)
        yield* sql`INSERT INTO profiles (id, name, created_at) VALUES ('me', 'me', ${AT}), ('work', 'work', ${AT})`
        yield* sql`INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at)
          VALUES ('pa', 'me', 'A', 'A', ${a}, '/nonexistent/a', ${shared}, ${AT}), ('pb', 'work', 'B', 'B', ${b}, '/nonexistent/b', ${shared}, ${AT})`
        yield* sql`INSERT INTO tasks (id, profile_id, project_id, kind, number, title, status, worktree_path, last_activity_at, created_at, updated_at)
          VALUES ('ta', 'me', 'pa', 'task', 1, 'A one', 'in_progress', ${`${shared}/a-1`}, ${AT}, ${AT}, ${AT}),
                 ('tb', 'work', 'pb', 'task', 1, 'B one', 'in_progress', ${`${shared}/b-1`}, ${AT}, ${AT}, ${AT})`
        const r = yield* (yield* Disk).report(ProfileId.make("me"))
        const wts = (r.projects[0]?.worktrees ?? []).map((w) => [w.task_id, w.path]).toSorted((x, y) => String(x[0]).localeCompare(String(y[0])))
        assert.deepStrictEqual(wts, [
          [null, `${shared}/a-old`],
          ["ta", `${shared}/a-1`],
        ])
      }),
    ),
  )
})
