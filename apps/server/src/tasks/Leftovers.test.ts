import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schedule } from "effect"
import type { Scope } from "effect"
import { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { TestPlatform } from "@huntaway/testing"
import { TaskId, Timestamp } from "@huntaway/contracts"
import { DataDir } from "../platform/DataDir.ts"
import { foldersIn, Leftovers } from "./Leftovers.ts"
import type { LeftoverProc } from "./Leftovers.ts"
import { folder, TaskTmp } from "./TaskTmp.ts"

// HA-186: a done task's test servers, their shims and agents are stopped, and nothing else is (the old
// leftovers.test.ts). Real processes, so `it.live`: fakes started by this file, each marked with this run's marker in
// its environment, and only those are ever signalled.

/** A fake server: starts a child (as a TS server's `sh` wrapper starts `node`), then waits to be stopped. */
const SERVER = `const { spawn } = require("node:child_process");
const tag = process.argv[process.argv.indexOf("--name") + 1];
spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9) /* fake:" + tag + "-child */"], { stdio: "ignore" });
setInterval(() => {}, 1e9);
`

/** A fake ia-shim: starts its agent in a process group of its own, which starts a helper in it, as Claude Code starts MCP servers. */
const SHIM = `const { spawn } = require("node:child_process");
const tag = process.argv[process.argv.length - 1];
const helper = "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9) /* fake:" + tag + "-helper */'], { stdio: 'ignore' }); setInterval(() => {}, 1e9)";
spawn(process.execPath, ["-e", helper + " /* fake:" + tag + "-agent */"], { stdio: "ignore", detached: true });
setInterval(() => {}, 1e9);
`

/** A fake server that, on TERM, starts another (`--late-exe`, with `--late-data` as its data dir) and exits half a second later. */
const STARTS_ONE = `const { spawn } = require("node:child_process");
const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
process.on("SIGTERM", () => {
  spawn(process.execPath, [arg("--late-exe"), "serve", "--data-dir", arg("--late-data"), "--name", "late-b"], { stdio: "ignore", detached: true }).unref();
  setTimeout(() => process.exit(0), 500);
});
setInterval(() => {}, 1e9);
`

/**
 * In the environment of this run's fakes (see `start`), which their children inherit. Their tags are the same in every
 * run of these tests, so without it a run at the same time (another worktree's, another agent's) would have its fakes
 * taken for this one's, and stopped as this one cleans up its own (HA-232).
 */
const RUN = { IA_LEFTOVERS_TEST_RUN: `${process.pid}-${randomBytes(6).toString("hex")}` }
const RUN_ENV = `IA_LEFTOVERS_TEST_RUN=${RUN.IA_LEFTOVERS_TEST_RUN}`

/** Whether process `pid` is one of this run's fakes, by its environment. Linux only, as the board's process listing is tested there. */
const thisRuns = (pid: number): boolean => {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(RUN_ENV)
  } catch {
    return false
  }
}

const tagOf = (p: LeftoverProc): string | undefined =>
  // An agent's command line has its helper's tag in it too, before its own.
  [...p.cmd.matchAll(/\/\* fake:(\S+) \*\//g)].pop()?.[1] ??
  /--name (\S+)|-- agent (\S+)$/
    .exec(p.cmd)
    ?.slice(1)
    .find((t) => t !== undefined)

/** This run's fake processes running now, by their tags. */
const fakes = Effect.gen(function* () {
  const leftovers = yield* Leftovers
  const out = new Map<string, LeftoverProc>()
  for (const p of (yield* leftovers.list) ?? []) {
    const tag = tagOf(p)
    if (tag !== undefined && p.cmd.includes(process.execPath) && thisRuns(p.pid)) out.set(tag, p)
  }
  return out
})

/** Waits (up to 10 s) until the fakes tagged `tags` are all running. */
const running = (tags: ReadonlyArray<string>) =>
  fakes.pipe(
    Effect.filterOrFail(
      (f) => tags.every((t) => f.has(t)),
      (f) => `these didn't start: ${tags.filter((t) => !f.has(t)).join(", ")}`,
    ),
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 200 }),
    Effect.orDie,
  )

/** Runs `body`, then stops every fake of `started` that's left, whatever happened. */
const withFakes = <A, E, R>(started: ReadonlyArray<string>, body: Effect.Effect<A, E, R>) =>
  body.pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const leftovers = yield* Leftovers
        // Again while any are left: stopping one may start another (see STARTS_ONE).
        for (let i = 0; i < 5; i++) {
          const left = [...(yield* fakes).entries()].filter(([t]) => started.some((s) => t === s || t.startsWith(`${s}-`))).map(([, p]) => p)
          if (left.length === 0) break
          yield* leftovers.stop(left, 2000)
        }
      }),
    ),
  )

/** Starts a fake, marked as this run's (see `RUN`). */
const start = (args: ReadonlyArray<string>, cwd?: string) =>
  Effect.sync(() => {
    const c = spawn(process.execPath, args, { cwd, env: { ...process.env, ...RUN }, stdio: "ignore", detached: true })
    c.unref()
  })

const writeFile = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const main = (d: string) => join(d, "server-ts", "src", "main.js")
const serve = (exe: string, dataDir: string, tag: string) => [exe, "serve", "--host", "127.0.0.1", "--port", "0", "--data-dir", dataDir, "--name", tag]
const shim = (exe: string, runDir: string, tag: string) => [exe, runDir, "--", "agent", tag]

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")

const layer = () => TaskTmp.layer.pipe(Layer.provideMerge(Leftovers.layer), Layer.provideMerge(TestPlatform()))
type Env = TaskTmp | Leftovers | SqlClient.SqlClient | SecureRandom.SecureRandom | DataDir | Scope.Scope
const run = <A, E>(effect: Effect.Effect<A, E, Env>) => effect.pipe(Effect.scoped, Effect.provide(layer()))

/** A task in progress, with no worktree. */
const newTask = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const random = yield* SecureRandom.SecureRandom
  const task = TaskId.make(yield* random.uuidV4())
  yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('p', 'p', ${AT})`
  yield* sql`INSERT INTO tasks (id, profile_id, title, status, last_activity_at, created_at, updated_at)
    VALUES (${task}, 'p', 'A task', 'in_progress', ${AT}, ${AT}, ${AT})`
  return task
}).pipe(Effect.orDie)

const done = (id: TaskId) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE tasks SET status = 'done' WHERE id = ${id}`).pipe(Effect.orDie)

const LIVE = { timeout: 60_000 }
const linux = process.platform === "linux"

describe.skipIf(!linux)("Leftovers", () => {
  it.live(
    "a task's servers, shims and agents are stopped, and nothing else",
    () =>
      run(
        Effect.gen(function* () {
          const leftovers = yield* Leftovers
          const data = yield* DataDir
          const base = `${data.root}/leftovers`
          const troot = join(base, "tmp-root")
          const mine = join(troot, "aaaaaaaaaaaa")
          const theirs = join(troot, "bbbbbbbbbbbb")
          mkdirSync(mine, { recursive: true })
          mkdirSync(theirs, { recursive: true })
          // The board names the temp folder through a link (as macOS's /var is /private/var); some processes name it either way.
          const link = join(base, "link")
          symlinkSync(troot, link)
          const wt = join(base, "worktrees", "1-task")
          const otherWt = join(base, "worktrees", "2-other")
          const board = join(base, "board")
          const elsewhere = join(base, "release")
          for (const d of [wt, otherWt, elsewhere]) writeFile(join(d, "server-ts", "src", "main.js"), SERVER)
          writeFile(join(wt, "server", "target", "debug", "ia-shim"), SHIM)
          writeFile(join(elsewhere, "ia-shim"), SHIM)
          const stopped = ["by-tmp", "by-link", "by-wt", "relative", "shim-of-dead", "shim-by-wt"]
          const kept = ["their-tmp", "their-wt", "board", "board-shim", "their-shim"]
          yield* withFakes(
            [...stopped, ...kept],
            Effect.gen(function* () {
              // Its data in the temp folder, by its real path and through the link; a release build, not the worktree's.
              yield* start(serve(main(elsewhere), join(mine, "ia-test-1"), "by-tmp"))
              yield* start(serve(main(elsewhere), join(link, "aaaaaaaaaaaa", "ia-test-2"), "by-link"))
              // The worktree's build, with its data in a custom folder.
              yield* start(serve(main(wt), join(base, "custom", "ia-test-3"), "by-wt"))
              // Started in the worktree, by relative paths.
              yield* start(serve(join("server-ts", "src", "main.js"), "rel-data", "relative"), wt)
              // A run of a server already gone, in the temp folder, and one by the worktree's ia-shim elsewhere.
              yield* start(shim(join(elsewhere, "ia-shim"), join(link, "aaaaaaaaaaaa", "ia-test-9", "runs", "r1"), "shim-of-dead"))
              yield* start(shim(join(wt, "server", "target", "debug", "ia-shim"), join(base, "custom", "ia-test-3", "runs", "r2"), "shim-by-wt"))
              // Left alone: another task's temp folder (even on this worktree's build), another worktree's server, the
              // board itself (on this worktree's build), the board's own runs, and another task's run.
              yield* start(serve(main(wt), join(theirs, "ia-test-4"), "their-tmp"))
              yield* start(serve(main(otherWt), join(base, "custom", "ia-test-5"), "their-wt"))
              yield* start(serve(main(wt), board, "board"))
              yield* start(shim(join(wt, "server", "target", "debug", "ia-shim"), join(board, "runs", "r3"), "board-shim"))
              yield* start(shim(join(elsewhere, "ia-shim"), join(theirs, "ia-test-4", "runs", "r4"), "their-shim"))

              const shims = ["shim-of-dead", "shim-by-wt", "board-shim", "their-shim"]
              const servers = [...stopped, ...kept].filter((t) => !shims.includes(t))
              const all = [...servers, ...servers.map((t) => `${t}-child`), ...shims, ...shims.flatMap((t) => [`${t}-agent`, `${t}-helper`])]
              yield* running(all)
              const ours = (tag: string) => stopped.some((s) => tag === s || tag.startsWith(`${s}-`))

              const scope = { tmp: [join(link, "aaaaaaaaaaaa")], worktrees: [wt], data_dir: board, tmp_root: link }
              // What `ps` lists (as on macOS) picks the same processes as /proc.
              const byTag = new Map([...(yield* fakes)].map(([t, p]) => [p.pid, t]))
              const tags = (procs: ReadonlyArray<LeftoverProc>) =>
                Effect.map(leftovers.find(procs, scope), (found) =>
                  found
                    .map((p) => byTag.get(p.pid))
                    .filter((t) => t !== undefined)
                    .toSorted(),
                )
              const want = all.filter(ours).toSorted()
              assert.deepStrictEqual(yield* tags((yield* leftovers.list) ?? []), want)
              assert.deepStrictEqual(yield* tags(yield* leftovers.listPs), want)

              const gone = yield* leftovers.stopTask(scope, "test")
              assert.isTrue(gone.length >= want.length)
              const left = yield* fakes
              assert.deepStrictEqual([...left.keys()].filter(ours), [], "the task's processes are stopped")
              assert.deepStrictEqual(
                all.filter((t) => !ours(t) && !left.has(t)),
                [],
                "the others are left alone",
              )
            }),
          )
        }),
      ),
    LIVE,
  )

  it.live(
    "a done task's test server is stopped with its folder, or once its folder has gone",
    () =>
      run(
        Effect.gen(function* () {
          const tmp = yield* TaskTmp
          const leftovers = yield* Leftovers
          const data = yield* DataDir
          const [a, b, open] = [yield* newTask, yield* newTask, yield* newTask]
          const exe = join(data.root, "rel", "server-ts", "src", "main.js")
          writeFile(exe, SERVER)
          const dataOf = (t: TaskId) => join(tmp.root, folder(t), "ia-test-x")
          for (const t of [a, b, open]) mkdirSync(dataOf(t), { recursive: true })
          const tags = ["done-a", "gone-b", "open"]
          yield* withFakes(
            tags,
            Effect.gen(function* () {
              yield* start([exe, "serve", "--data-dir", dataOf(a), "--name", "done-a"])
              yield* start([exe, "serve", "--data-dir", dataOf(b), "--name", "gone-b"])
              yield* start([exe, "serve", "--data-dir", dataOf(open), "--name", "open"])
              yield* running([...tags, ...tags.map((t) => `${t}-child`)])
              assert.deepStrictEqual([...foldersIn((yield* leftovers.list) ?? [], [tmp.root])].toSorted(), [a, b, open].map((t) => folder(t)).toSorted())

              // A done task's folder goes, and its server with it.
              yield* done(a)
              assert.isTrue(yield* tmp.remove(folder(a)))
              assert.isFalse((yield* fakes).has("done-a"))
              assert.isTrue((yield* fakes).has("gone-b"))

              // One whose folder went before (by hand, or by an older server) is stopped by the sweep, once its task is done.
              rmSync(join(tmp.root, folder(b)), { recursive: true })
              rmSync(join(tmp.root, folder(open)), { recursive: true })
              assert.strictEqual(yield* tmp.sweep, 0)
              assert.isTrue((yield* fakes).has("gone-b"), "not while its task is open")
              yield* done(b)
              yield* tmp.sweep
              const left = yield* fakes
              assert.isTrue(!left.has("gone-b") && !left.has("gone-b-child"))
              assert.isTrue(left.has("open") && left.has("open-child"), "an open task's server is left alone")
              assert.isFalse(existsSync(join(tmp.root, folder(a))))
            }),
          )
        }),
      ),
    LIVE,
  )

  // HA-227: the folder is renamed away before its processes are looked for, so a server started in it with a relative
  // `--data-dir` has its data dir (through its working directory) in the renamed folder.
  it.live(
    "a server started in the folder with a relative data dir is stopped with it",
    () =>
      run(
        Effect.gen(function* () {
          const tmp = yield* TaskTmp
          const data = yield* DataDir
          const a = yield* newTask
          const exe = join(data.root, "rel", "server-ts", "src", "main.js")
          writeFile(exe, SERVER)
          const dir = join(tmp.root, folder(a))
          mkdirSync(join(dir, "ia-test-rel"), { recursive: true })
          yield* withFakes(
            ["rel-a"],
            Effect.gen(function* () {
              yield* start([exe, "serve", "--data-dir", "ia-test-rel", "--name", "rel-a"], dir)
              yield* running(["rel-a", "rel-a-child"])
              yield* done(a)
              assert.isTrue(yield* tmp.remove(folder(a)))
              const left = yield* fakes
              assert.isTrue(!left.has("rel-a") && !left.has("rel-a-child"))
            }),
          )
        }),
      ),
    LIVE,
  )

  // HA-227: with the whole root gone, the sweep still stops what ran in its folders.
  it.live(
    "a done task's test server is stopped once the whole root has gone",
    () =>
      run(
        Effect.gen(function* () {
          const tmp = yield* TaskTmp
          const data = yield* DataDir
          const a = yield* newTask
          const exe = join(data.root, "root", "server-ts", "src", "main.js")
          writeFile(exe, SERVER)
          const dataDir = join(tmp.root, folder(a), "ia-test-x")
          mkdirSync(dataDir, { recursive: true })
          yield* withFakes(
            ["rootless"],
            Effect.gen(function* () {
              yield* start([exe, "serve", "--data-dir", dataDir, "--name", "rootless"])
              yield* running(["rootless", "rootless-child"])
              yield* done(a)
              rmSync(tmp.root, { recursive: true })
              assert.strictEqual(yield* tmp.sweep, 0)
              const left = yield* fakes
              assert.isTrue(!left.has("rootless") && !left.has("rootless-child"))
            }),
          )
        }),
      ),
    LIVE,
  )

  // HA-227: each gone folder's processes are listed as it's come to, not once for all of them, as stopping one folder's
  // may take seconds. Here stopping A's server starts one in B's folder, which a listing from before then wouldn't have.
  it.live(
    "each gone folder's processes are listed afresh",
    () =>
      run(
        Effect.gen(function* () {
          const tmp = yield* TaskTmp
          const data = yield* DataDir
          const [a, b] = [yield* newTask, yield* newTask]
          const exe = join(data.root, "late", "server-ts", "src", "main.js")
          const exeA = join(data.root, "a", "server-ts", "src", "main.js")
          writeFile(exe, SERVER)
          writeFile(exeA, STARTS_ONE)
          const dataOf = (t: TaskId) => join(tmp.root, folder(t), "ia-test-x")
          for (const t of [a, b]) mkdirSync(dataOf(t), { recursive: true })
          const tags = ["first-a", "first-b", "late-b"]
          yield* withFakes(
            tags,
            Effect.gen(function* () {
              // A's first, so its folder is come to first (processes are listed by pid).
              yield* start([exeA, "serve", "--data-dir", dataOf(a), "--name", "first-a", "--late-exe", exe, "--late-data", dataOf(b)])
              yield* running(["first-a"])
              yield* start([exe, "serve", "--data-dir", dataOf(b), "--name", "first-b"])
              yield* running(["first-b", "first-b-child"])
              for (const t of [a, b]) {
                yield* done(t)
                rmSync(join(tmp.root, folder(t)), { recursive: true })
              }
              yield* tmp.sweep
              const left = yield* fakes
              assert.deepStrictEqual(
                [...left].filter(([t]) => tags.some((g) => t === g || t.startsWith(`${g}-`))).map(([t, p]) => `${t} ${p.pid} ${p.start}`),
                [],
              )
            }),
          )
        }),
      ),
    LIVE,
  )
})
