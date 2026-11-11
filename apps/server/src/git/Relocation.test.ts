import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Fiber, FileSystem, Latch } from "effect"
import type { Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { SqlClient } from "effect/sql"
import { git, tempDir, TestBoard } from "@huntaway/testing"
import { TaskId } from "@huntaway/contracts"
import type { Project, ProjectPatch, Task } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import type { DataDir } from "../platform/DataDir.ts"
import { Db } from "../platform/Db.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { AgentConfigs } from "../profiles/AgentConfigs.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { isHistory, Projects } from "../projects/Projects.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Git } from "./Git.ts"
import { claudeProjectDir, Relocation } from "./Relocation.ts"
import { Worktrees } from "./Worktrees.ts"

// huntaway's git/relocate/tests.test.ts: moving a project's folder, or pointing the project at where it is now, with its
// worktrees, links, submodules and conversations following; telling the repository by its worktrees, its history or its
// tasks' branches; the fingerprint recorder's pass; and a move against a worktree setup and a launch. Real repositories
// in temp folders, git with none of the machine's configuration.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

type Env =
  | Relocation
  | Projects
  | Profiles
  | AgentConfigs
  | Tasks
  | Worktrees
  | Git
  | Db
  | KeyedLock
  | DataDir
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope
const run = <A, E>(effect: Effect.Effect<A, E, Env>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

const fs = FileSystem.FileSystem
const exists = (p: string) => Effect.flatMap(fs, (f) => f.exists(p)).pipe(Effect.orDie)
const isDir = (p: string) =>
  Effect.flatMap(fs, (f) => f.stat(p)).pipe(
    Effect.map((i) => i.type === "Directory"),
    Effect.orElseSucceed(() => false),
  )
const mkdir = (p: string) => Effect.flatMap(fs, (f) => f.makeDirectory(p, { recursive: true })).pipe(Effect.orDie)
const write = (p: string, text: string) =>
  Effect.flatMap(fs, (f) => Effect.andThen(f.makeDirectory(p.slice(0, p.lastIndexOf("/")), { recursive: true }), f.writeFileString(p, text))).pipe(Effect.orDie)
const read = (p: string) => Effect.flatMap(fs, (f) => f.readFileString(p)).pipe(Effect.orDie)
const rename = (a: string, b: string) => Effect.flatMap(fs, (f) => f.rename(a, b)).pipe(Effect.orDie)
const symlink = (target: string, link: string) => Effect.flatMap(fs, (f) => f.symlink(target, link)).pipe(Effect.orDie)
const remove = (p: string) => Effect.flatMap(fs, (f) => f.remove(p, { recursive: true })).pipe(Effect.orDie)
const utimes = (p: string, t: Date) => Effect.flatMap(fs, (f) => f.utimes(p, t, t)).pipe(Effect.orDie)
const sh = (command: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (s) => s.string(ChildProcess.make(command, args))).pipe(Effect.orDie)
/** A temp folder, by its real path. */
const temp = Effect.flatMap(tempDir, (d) => Effect.flatMap(fs, (f) => f.realPath(d)).pipe(Effect.orDie))
const sibling = (p: string, name: string) => `${p.slice(0, p.lastIndexOf("/"))}/${name}`

/** Whether git works in `dir`. */
const works = (dir: string) => Effect.flatMap(Git, (g) => g.run(dir, ["status", "--short"])).pipe(Effect.map((o) => o.ok))

/** A new repository on master with a commit of its own at `path`. */
const repo = (path: string) =>
  Effect.gen(function* () {
    yield* mkdir(path)
    yield* git(path, ["init", "-q", "-b", "master"])
    yield* git(path, ["commit", "-q", "--allow-empty", "-m", `init ${path}`])
  })

const profile = Effect.flatMap(Profiles, (p) => p.create({ name: "p" })).pipe(Effect.orDie)
const create = (input: {
  readonly profile_id: Project["profile_id"]
  readonly name: string
  readonly repo_path: string
  readonly key?: string
  readonly base_branch?: string
}) => Effect.flatMap(Projects, (p) => p.create(input)).pipe(Effect.orDie)
const newTask = (project: Project, title = "Do it") => Effect.flatMap(Tasks, (t) => t.create({ project_id: project.id, title }, Actor.user)).pipe(Effect.orDie)
const getTask = (id: TaskId) =>
  Effect.flatMap(Tasks, (t) => t.get(id)).pipe(
    Effect.orDie,
    Effect.map((t) => t),
  )
const getProject = (p: Project) => Effect.flatMap(Projects, (ps) => ps.get(p.id)).pipe(Effect.orDie)
const setUp = (id: TaskId) => Effect.flatMap(Worktrees, (w) => w.setup(id)).pipe(Effect.orDie)
const update = (p: Project, patch: ProjectPatch) => Effect.flatMap(Relocation, (r) => r.update(p.id, patch))
/** Why an update fails, as its text. */
const refusal = (p: Project, patch: ProjectPatch) =>
  Effect.map(Effect.flip(update(p, patch)), (e) =>
    "reason" in e && typeof e.reason === "string" && e._tag === "Invalid" ? e.reason : "detail" in e ? e.detail : e._tag,
  )
const repoRoot = (p: Project) => Effect.flatMap(Projects, (ps) => ps.repoRoot(p.id))

/** A project in a new repository at `<tmp>/<name>` (key X), in the given profile or a new one. */
const gitProject = (name: string) =>
  Effect.gen(function* () {
    const path = `${yield* temp}/${name}`
    yield* repo(path)
    return yield* create({ profile_id: (yield* profile).id, name, repo_path: path, key: "X", base_branch: "master" })
  })

/** A project with a task in a worktree, kept in the repository's folder `worktrees` when given (else the data folder's). */
const projectWithWorktree = (name: string, worktrees: string | null = null) =>
  Effect.gen(function* () {
    let p = yield* gitProject(name)
    if (worktrees !== null) p = yield* Effect.flatMap(Projects, (ps) => ps.update(p.id, { worktrees_root: `${p.repo_path}/${worktrees}` })).pipe(Effect.orDie)
    const t = yield* setUp((yield* newTask(p)).id)
    return [p, t] as const
  })

/** A Claude config in a new folder, and a thread of `t`'s in it that ran in `cwd`. Its folder. */
const conversation = (t: Task, cwd: string) =>
  Effect.gen(function* () {
    const configDir = `${yield* temp}/claude`
    const config = yield* Effect.flatMap(AgentConfigs, (c) => c.create({ name: `Claude ${t.id}`, config_dir: configDir })).pipe(Effect.orDie)
    yield* Effect.flatMap(Tasks, (ts) => ts.change(t.id, () => ({ session_id: "s1", claude_config_id: config.id }), Actor.board)).pipe(Effect.orDie)
    const dir = `${configDir}/projects/${claudeProjectDir(cwd)}`
    yield* write(`${dir}/s1.jsonl`, "{}\n")
    yield* write(`${dir}/s1/subagents/a.jsonl`, "{}\n")
    return configDir
  })
const hasConversation = (configDir: string, cwd: string) =>
  Effect.gen(function* () {
    const dir = `${configDir}/projects/${claudeProjectDir(cwd)}`
    return (yield* exists(`${dir}/s1.jsonl`)) && (yield* exists(`${dir}/s1/subagents/a.jsonl`))
  })

describe("Relocation", () => {
  it("names Claude's folder for a working folder", () => {
    assert.strictEqual(claudeProjectDir("/home/me/my repo.x"), "-home-me-my-repo-x")
  })

  it.live("moves the folder and reconnects its worktrees", () =>
    run(
      Effect.gen(function* () {
        const [p, t] = yield* projectWithWorktree("os-sandbox")
        const wt = t.worktree_path ?? ""
        const old = p.repo_path
        const n = sibling(old, "omarchy-sandbox")
        // Not over another folder, and not without a path to move to.
        yield* mkdir(n)
        assert.include(yield* refusal(p, { repo_path: n, move_repo: true }), "already exists")
        yield* remove(n)
        assert.include(yield* refusal(p, { name: "omarchy-sandbox", move_repo: true }), "needs a new repo_path")

        const moved = yield* update(p, { name: "omarchy-sandbox", repo_path: n, move_repo: true })
        assert.deepStrictEqual([moved.name, moved.repo_path], ["omarchy-sandbox", n])
        assert.isFalse(yield* exists(old))
        assert.isTrue(yield* isDir(`${n}/.git`))
        assert.isTrue(yield* works(wt))
        assert.include(yield* read(`${wt}/.git`), n)
      }),
    ),
  )

  it.live("points at a folder moved elsewhere", () =>
    run(
      Effect.gen(function* () {
        const [p, t] = yield* projectWithWorktree("os-sandbox")
        const wt = t.worktree_path ?? ""
        const old = p.repo_path
        const n = sibling(old, "omarchy-sandbox")
        yield* rename(old, n)
        assert.isFalse(yield* works(wt))
        // Another repository, or a folder that isn't one, isn't the project's.
        const other = sibling(old, "other")
        yield* repo(other)
        assert.include(yield* refusal(p, { repo_path: other }), "doesn't have the task worktree")
        assert.include(yield* refusal(p, { repo_path: sibling(old, "missing") }), "isn't a folder")
        assert.include(yield* refusal(p, { repo_path: "relative/path" }), "absolute")
        assert.strictEqual((yield* update(p, { repo_path: n })).repo_path, n)
        assert.isTrue(yield* works(wt))
      }),
    ),
  )

  it.live("points at a link's target so the link can go", () =>
    run(
      Effect.gen(function* () {
        const [p, t] = yield* projectWithWorktree("os-sandbox")
        const wt = t.worktree_path ?? ""
        const old = p.repo_path
        const n = sibling(old, "omarchy-sandbox")
        yield* rename(old, n)
        yield* symlink(n, old)
        assert.isTrue(yield* works(wt))
        // While the old folder is there, only the same repository will do.
        const other = sibling(old, "other")
        yield* repo(other)
        assert.include(yield* refusal(p, { repo_path: other }), "isn't the project's repository")
        assert.include(yield* refusal(p, { repo_path: sibling(other, "elsewhere"), move_repo: true }), "is a link to")
        yield* update(p, { repo_path: n })
        yield* remove(old)
        assert.isTrue(yield* works(wt))
      }),
    ),
  )

  it.live("copies conversations that ran in the folder, and brings them up to date when moving back", () =>
    run(
      Effect.gen(function* () {
        const a = `${yield* temp}/notes`
        let p = yield* create({ profile_id: (yield* profile).id, name: "notes", repo_path: a })
        const t = yield* newTask(p, "Write")
        const configDir = yield* conversation(t, a)
        const b = sibling(a, "journal")
        p = yield* update(p, { repo_path: b, move_repo: true })
        assert.isTrue(yield* hasConversation(configDir, b))
        assert.isTrue(yield* hasConversation(configDir, a))

        // It carries on at B…
        const at = (dir: string) => `${configDir}/projects/${claudeProjectDir(dir)}`
        const later = DateTime.toDateUtc(DateTime.add(yield* DateTime.now, { minutes: 1 }))
        for (const [f, text] of [
          ["s1.jsonl", '{}\n{"more": 1}\n'],
          ["s1/subagents/a.jsonl", '{"sub": 2}\n'],
          ["s1/subagents/b.jsonl", "{}\n"],
        ] as const) {
          yield* write(`${at(b)}/${f}`, text)
          yield* utimes(`${at(b)}/${f}`, later)
        }
        // …and moving back to A, which has the copy from before, brings that up to date.
        yield* update(p, { repo_path: a, move_repo: true })
        assert.strictEqual(yield* read(`${at(a)}/s1.jsonl`), '{}\n{"more": 1}\n')
        assert.strictEqual(yield* read(`${at(a)}/s1/subagents/a.jsonl`), '{"sub": 2}\n')
        assert.isTrue(yield* exists(`${at(a)}/s1/subagents/b.jsonl`))
      }),
    ),
  )

  // Worktrees kept inside the repository move with it, whether the board moves it or it was moved before, and so does
  // the worktrees folder (or new tasks would recreate the old one).
  for (const moveFolder of [true, false]) {
    it.live(`worktrees inside the folder move with it (${moveFolder ? "moved by the board" : "moved before"})`, () =>
      run(
        Effect.gen(function* () {
          const [p0, t0] = yield* projectWithWorktree("os-sandbox", ".worktrees")
          const oldWt = t0.worktree_path ?? ""
          const old = p0.repo_path
          assert.isTrue(oldWt.startsWith(`${old}/.worktrees/`))
          const configDir = yield* conversation(t0, oldWt)
          const n = sibling(old, "omarchy-sandbox")
          if (!moveFolder) yield* rename(old, n)
          const p = yield* update(p0, { repo_path: n, move_repo: moveFolder })
          assert.strictEqual(p.worktrees_root, `${n}/.worktrees`)
          const wt = `${n}/${oldWt.slice(old.length + 1)}`
          assert.strictEqual((yield* getTask(t0.id))?.worktree_path, wt)
          assert.isTrue(yield* works(wt))
          assert.isTrue((yield* Effect.flatMap(Relocation, (r) => r.worktreeList(n))).has(wt))
          assert.isTrue(yield* hasConversation(configDir, wt))
          assert.isFalse(yield* exists(old))
        }),
      ),
    )
  }

  // Without worktrees to go by, a moved repository is told by the history it started from.
  it.live("tells a moved repository by its history", () =>
    run(
      Effect.gen(function* () {
        let p = yield* gitProject("os-sandbox")
        assert.strictEqual((yield* repoRoot(p))?.length, 40)
        const old = p.repo_path
        const n = sibling(old, "omarchy-sandbox")
        yield* rename(old, n)
        const other = sibling(old, "other")
        yield* repo(other)
        const plain = sibling(old, "plain")
        yield* mkdir(plain)
        assert.include(yield* refusal(p, { repo_path: other }), "none of the commits")
        assert.include(yield* refusal(p, { repo_path: plain }), "isn't a git repository")
        p = yield* update(p, { repo_path: n })
        assert.strictEqual(p.repo_path, n)

        // When the board didn't see what was there, it can't tell.
        yield* Effect.flatMap(Db, ({ sql }) => sql`UPDATE projects SET repo_root = NULL WHERE id = ${p.id}`).pipe(Effect.orDie)
        yield* rename(n, old)
        assert.include(yield* refusal(p, { repo_path: old }), "can't tell")
        // It looks while the folder is there.
        yield* rename(old, n)
        yield* Effect.flatMap(Projects, (ps) => ps.recordFingerprints)
        assert.isTrue(isHistory(yield* repoRoot(p)))
        yield* rename(n, old)
        p = yield* update(p, { repo_path: old })

        // A repository without commits isn't the one that had them.
        yield* rename(old, n)
        const empty = sibling(old, "empty")
        yield* mkdir(empty)
        yield* git(empty, ["init", "-q"])
        assert.include(yield* refusal(p, { repo_path: empty }), "has no commits")
      }),
    ),
  )

  // HA-42: a shallow clone's history starts where it was cut off, so once the rest was fetched its moved folder had none
  // of the commits the board had seen it start from.
  it.live("tells a moved shallow clone once its history is fetched", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* temp
        const upstream = `${dir}/upstream`
        yield* repo(upstream)
        for (const n of [1, 2, 3]) yield* git(upstream, ["commit", "-q", "--allow-empty", "-m", `commit ${n}`])
        const old = `${dir}/shallow`
        yield* git(upstream, ["clone", "-q", "--depth", "1", `file://${upstream}`, old])
        const p = yield* create({ profile_id: (yield* profile).id, name: "s", repo_path: old, key: "X", base_branch: "master" })
        const n = sibling(old, "unshallowed")
        yield* rename(old, n)
        yield* git(n, ["fetch", "-q", "--unshallow"])
        assert.notStrictEqual(yield* Effect.flatMap(Projects, (ps) => ps.fingerprint(n)), yield* repoRoot(p))
        assert.strictEqual((yield* update(p, { repo_path: n })).repo_path, n)
      }),
    ),
  )

  // A repository seen before its first commit is told by its history once it has one; until the board has seen that,
  // it can't tell.
  it.live("a repository without commits yet is no proof", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* temp
        const old = `${dir}/fresh`
        yield* mkdir(old)
        yield* git(old, ["init", "-q", "-b", "master"])
        const p = yield* create({ profile_id: (yield* profile).id, name: "fresh", repo_path: old })
        assert.strictEqual(yield* repoRoot(p), "git")
        yield* git(old, ["commit", "-q", "--allow-empty", "-m", "first"])
        const n = sibling(old, "moved")
        const other = sibling(old, "other")
        yield* repo(other)
        yield* rename(old, n)
        assert.include(yield* refusal(p, { repo_path: other }), "can't tell")
        yield* rename(n, old)
        yield* Effect.flatMap(Projects, (ps) => ps.recordFingerprints)
        assert.isTrue(isHistory(yield* repoRoot(p)))
        yield* rename(old, n)
        assert.include(yield* refusal(p, { repo_path: other }), "none of the commits")
        yield* update(p, { repo_path: n })
      }),
    ),
  )

  // A folder that wasn't a repository when the board looked may be one by the time it moves, so that's no proof either;
  // setting up a worktree has the board look again.
  it.live("a folder that wasn't a repository is no proof", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* temp
        const old = `${dir}/notes`
        yield* mkdir(old)
        const p = yield* create({ profile_id: (yield* profile).id, name: "notes", repo_path: old, base_branch: "master" })
        assert.strictEqual(yield* repoRoot(p), "")
        yield* git(old, ["init", "-q", "-b", "master"])
        yield* git(old, ["commit", "-q", "--allow-empty", "-m", "first"])
        const n = sibling(old, "moved")
        yield* rename(old, n)
        const other = sibling(old, "other")
        yield* repo(other)
        const plain = sibling(old, "plain")
        yield* mkdir(plain)
        for (const wrong of [other, plain]) assert.include(yield* refusal(p, { repo_path: wrong }), "can't tell")
        yield* rename(n, old)
        yield* setUp((yield* newTask(p)).id)
        assert.isTrue(isHistory(yield* repoRoot(p)))
      }),
    ),
  )

  it.live("knows a worktree repaired before the board was told", () =>
    run(
      Effect.gen(function* () {
        const [p, t] = yield* projectWithWorktree("os-sandbox", ".worktrees")
        const oldWt = t.worktree_path ?? ""
        const old = p.repo_path
        const n = sibling(old, "omarchy-sandbox")
        yield* rename(old, n)
        const wt = `${n}/${oldWt.slice(old.length + 1)}`
        yield* git(n, ["worktree", "repair", wt])
        assert.isTrue(yield* works(wt))
        yield* update(p, { repo_path: n })
        assert.strictEqual((yield* getTask(t.id))?.worktree_path, wt)
      }),
    ),
  )

  // A task whose worktree was removed (once merged, say) gets its folder back when it runs again, in the worktrees
  // folder's new place, and its conversation needs to be there.
  it.live("copies conversations of removed worktrees to where they come back", () =>
    run(
      Effect.gen(function* () {
        const [p0, t0] = yield* projectWithWorktree("os-sandbox", ".worktrees")
        const oldWt = t0.worktree_path ?? ""
        const configDir = yield* conversation(t0, oldWt)
        const t = yield* Effect.flatMap(Worktrees, (w) => w.teardown(t0.id, { force: false, deleteBranch: false })).pipe(Effect.orDie)
        assert.deepStrictEqual([t.worktree_path, t.branch !== null], [null, true])
        const old = p0.repo_path
        const n = sibling(old, "omarchy-sandbox")
        const p = yield* update(p0, { repo_path: n, move_repo: true })
        const wt = `${n}/${oldWt.slice(old.length + 1)}`
        assert.isTrue(yield* hasConversation(configDir, wt))
        // Even after the key changes, it comes back there.
        yield* update(p, { key: "Y" })
        assert.strictEqual((yield* setUp(t.id)).worktree_path, wt)
      }),
    ),
  )

  // Another checkout of the same repository is another folder: the project's hasn't moved.
  it.live("another checkout of the repository isn't the folder", () =>
    run(
      Effect.gen(function* () {
        const [p, t] = yield* projectWithWorktree("os-sandbox", ".worktrees")
        const checkout = sibling(p.repo_path, "checkout")
        yield* git(p.repo_path, ["worktree", "add", "-q", "-b", "other", checkout])
        assert.include(yield* refusal(p, { repo_path: checkout }), "still at")
        assert.strictEqual((yield* getTask(t.id))?.worktree_path, t.worktree_path)
        assert.strictEqual((yield* getProject(p)).worktrees_root, p.worktrees_root)
      }),
    ),
  )

  // HA-341: moving the folder updated only this project's paths, and another project on it was left at the old one.
  it.live("a folder another project uses isn't moved", () =>
    run(
      Effect.gen(function* () {
        const [p] = yield* projectWithWorktree("shared")
        const other = yield* create({ profile_id: p.profile_id, name: "api", repo_path: `${p.repo_path}/api`, key: "Y", base_branch: "master" })
        const n = sibling(p.repo_path, "moved")
        assert.include(yield* refusal(p, { repo_path: n, move_repo: true }), "also the folder of project api")
        assert.isTrue(yield* exists(p.repo_path))
        assert.isFalse(yield* exists(n))
        // Once the other project is elsewhere, it moves.
        yield* Effect.flatMap(Db, ({ sql }) => sql`UPDATE projects SET repo_path = '/elsewhere' WHERE id = ${other.id}`).pipe(Effect.orDie)
        yield* update(p, { repo_path: n, move_repo: true })
        assert.isTrue(yield* exists(n))
      }),
    ),
  )

  // A review thread works in the worktree of the task it reviews.
  it.live("copies a review thread's conversation from the worktree it reviewed", () =>
    run(
      Effect.gen(function* () {
        const [p, t] = yield* projectWithWorktree("os-sandbox", ".worktrees")
        const oldWt = t.worktree_path ?? ""
        yield* Effect.flatMap(
          Db,
          ({ sql }) =>
            sql`INSERT INTO tasks ${sql.insert({
              id: "review-1",
              profile_id: p.profile_id,
              project_id: p.id,
              kind: "review",
              parent_id: t.id,
              title: "Review of X-1",
              last_activity_at: "",
              created_at: "",
              updated_at: "",
            })}`,
        ).pipe(Effect.orDie)
        const review = yield* getTask(TaskId.make("review-1")).pipe(
          Effect.filterOrElse(
            (r) => r !== null,
            () => Effect.die("no review thread"),
          ),
        )
        const configDir = yield* conversation(review, oldWt)
        const old = p.repo_path
        const n = sibling(old, "omarchy-sandbox")
        yield* update(p, { repo_path: n, move_repo: true })
        assert.isTrue(yield* hasConversation(configDir, `${n}/${oldWt.slice(old.length + 1)}`))
      }),
    ),
  )

  it.live("a change that can't be stored leaves the folder where it is", () =>
    run(
      Effect.gen(function* () {
        const [p, t] = yield* projectWithWorktree("os-sandbox")
        const old = p.repo_path
        const n = sibling(old, "omarchy-sandbox")
        // (The old case's `use_worktrees: null` doesn't decode here: a review round count out of range is refused instead.)
        assert.include(yield* refusal(p, { repo_path: n, move_repo: true, review_rounds: 99 }), "review_rounds")
        assert.isTrue(yield* isDir(old))
        assert.isFalse(yield* exists(n))
        assert.deepStrictEqual([(yield* getProject(p)).repo_path, (yield* getProject(p)).review_rounds], [p.repo_path, p.review_rounds])
        assert.isTrue(yield* works(t.worktree_path ?? ""))
      }),
    ),
  )

  // The old two cases ran a move and a change of key at once: here the key is checked where it's stored, so one key goes
  // to one project whichever commits first, and a rename while the folder moves waits for it under the project's lock.
  it.live("a key taken while the folder moves isn't taken twice, and a rename meanwhile keeps every old key", () =>
    run(
      Effect.gen(function* () {
        const [p] = yield* projectWithWorktree("os-sandbox")
        const q = yield* create({ profile_id: p.profile_id, name: "q", repo_path: `${yield* temp}/q`, key: "Q" })
        const n = sibling(p.repo_path, "omarchy-sandbox")
        const [moving, taking] = yield* Effect.all(
          [Effect.result(update(p, { repo_path: n, move_repo: true, key: "NEW" })), Effect.result(update(q, { key: "NEW" }))],
          {
            concurrency: 2,
          },
        )
        const keys = [moving._tag === "Success" ? moving.success.key : null, taking._tag === "Success" ? taking.success.key : null]
        assert.strictEqual(keys.filter((k) => k === "NEW").length, 1, String(keys))
        // The project says where its folder is: moved with the key, or (the key gone before it was checked) not moved.
        const at = (yield* getProject(p)).repo_path
        assert.strictEqual(at, moving._tag === "Success" ? n : p.repo_path)
        assert.isTrue(yield* isDir(at))

        const rPath = `${yield* temp}/renamed`
        yield* repo(rPath)
        const r = yield* create({ profile_id: p.profile_id, name: "renamed", repo_path: rPath, key: "R", base_branch: "master" })
        const m = sibling(r.repo_path, "renamed-too")
        yield* Effect.all([update(r, { repo_path: m, move_repo: true, key: "NEW2" }), update(r, { key: "MIDDLE" })], { concurrency: 2 })
        const now = yield* getProject(r)
        assert.deepStrictEqual([...now.former_keys, now.key].toSorted(), ["MIDDLE", "NEW2", "R"])
        assert.strictEqual(now.repo_path, m)
      }),
    ),
  )

  it.live("submodules checked out in worktrees keep working", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* temp
        const lib = `${dir}/lib`
        yield* repo(lib)
        const old = `${dir}/os-sandbox`
        yield* repo(old)
        yield* git(old, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib"])
        yield* git(old, ["commit", "-q", "-m", "lib"])
        const p = yield* create({ profile_id: (yield* profile).id, name: "os", repo_path: old, key: "X", base_branch: "master" })
        const wt = (yield* setUp((yield* newTask(p)).id)).worktree_path ?? ""
        yield* git(wt, ["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"])
        assert.isTrue(yield* works(`${wt}/lib`))
        const n = sibling(old, "omarchy-sandbox")
        yield* update(p, { repo_path: n, move_repo: true })
        for (const d of [wt, `${wt}/lib`, `${n}/lib`]) assert.isTrue(yield* works(d), d)
        // Still relative, as git keeps them, so they survive the folders moving together.
        assert.isTrue((yield* read(`${n}/lib/.git`)).startsWith("gitdir: .."))
      }),
    ),
  )

  it.live("submodules of a project that is a linked checkout keep working", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* temp
        const lib = `${dir}/lib`
        yield* repo(lib)
        const main = `${dir}/main`
        yield* repo(main)
        yield* git(main, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib"])
        yield* git(main, ["commit", "-q", "-m", "lib"])
        const old = `${dir}/linked-old`
        yield* git(main, ["worktree", "add", "-q", "-b", "linked", old])
        yield* git(old, ["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"])
        let p = yield* create({ profile_id: (yield* profile).id, name: "linked", repo_path: old, key: "X", base_branch: "linked" })
        p = yield* Effect.flatMap(Projects, (ps) => ps.update(p.id, { worktrees_root: `${old}/.worktrees` })).pipe(Effect.orDie)
        let wt = (yield* setUp((yield* newTask(p)).id)).worktree_path ?? ""
        yield* git(wt, ["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"])
        const n = sibling(old, "linked-new")
        yield* update(p, { repo_path: n, move_repo: true })
        wt = `${n}/${wt.slice(old.length + 1)}`
        for (const d of [n, `${n}/lib`, wt, `${wt}/lib`, main, `${main}/lib`]) assert.isTrue(yield* works(d), d)
      }),
    ),
  )

  it.live("agents start once the folder has moved", () =>
    run(
      Effect.gen(function* () {
        const [p] = yield* projectWithWorktree("os-sandbox")
        const relocation = yield* Relocation
        const n = sibling(p.repo_path, "omarchy-sandbox")
        // The move waits for the project's lock, which the test holds, with the folder marked as moving.
        const held = yield* Latch.make(false)
        const release = yield* Latch.make(false)
        const holder = yield* Effect.forkChild((yield* KeyedLock).withLock(["project", p.id])(Effect.andThen(held.open, release.await)))
        yield* held.await
        const moving = yield* Effect.forkChild(update(p, { repo_path: n, move_repo: true }))
        while (!(yield* relocation.isMoving(p.id))) yield* Effect.yieldNow
        // A launch waits, then reads where the project is now.
        const starting = yield* Effect.forkChild(Effect.andThen(relocation.settled(p.id), getProject(p)))
        yield* release.open
        yield* Fiber.join(holder)
        yield* Fiber.join(moving)
        assert.strictEqual((yield* Fiber.join(starting)).repo_path, n)
      }),
    ),
  )

  it.live("a worktree being set up keeps the folder where it is", () =>
    run(
      Effect.gen(function* () {
        const [p] = yield* projectWithWorktree("os-sandbox", ".worktrees")
        const signals = yield* temp
        // The setup script says it started and waits to be let go, through two named pipes (no polling).
        yield* sh("mkfifo", [`${signals}/started`, `${signals}/go`])
        yield* Effect.flatMap(Projects, (ps) => ps.update(p.id, { setup_script: `echo > ${signals}/started; read x < ${signals}/go` })).pipe(Effect.orDie)
        const t = yield* newTask(p, "Another")
        const n = sibling(p.repo_path, "omarchy-sandbox")
        const setup = yield* Effect.forkChild(setUp(t.id))
        yield* read(`${signals}/started`)
        assert.include(yield* refusal(p, { repo_path: n, move_repo: true }), "being set up")
        yield* Effect.flatMap(fs, (f) => f.writeFileString(`${signals}/go`, "go\n")).pipe(Effect.orDie)
        let wt = (yield* Fiber.join(setup)).worktree_path ?? ""
        assert.isTrue(wt.startsWith(p.repo_path))
        assert.isTrue(yield* works(wt))
        // Once it's set up, the folder moves with it.
        yield* update(p, { repo_path: n, move_repo: true })
        wt = (yield* getTask(t.id))?.worktree_path ?? ""
        assert.isTrue(wt.startsWith(n))
        assert.isTrue(yield* works(wt))
      }),
    ),
  )

  // huntaway's worktree_files.test.ts `links_are_moved_with_the_repository_even_once_out_of_the_setting`.
  it.live("links are moved with the repository, even once out of the setting", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* temp
        const old = `${dir}/repo`
        yield* mkdir(old)
        yield* git(old, ["init", "-q", "-b", "master"])
        yield* write(`${old}/.gitignore`, "node_modules\n")
        yield* write(`${old}/node_modules/pkg/index.js`, "module")
        yield* git(old, ["add", ".gitignore"])
        yield* git(old, ["commit", "-q", "-m", "init"])
        let p = yield* create({ profile_id: (yield* profile).id, name: "repo", repo_path: old, key: "X", base_branch: "master" })
        p = yield* Effect.flatMap(Projects, (ps) => ps.update(p.id, { link_folders: "node_modules" })).pipe(Effect.orDie)
        const wt = (yield* setUp((yield* newTask(p)).id)).worktree_path ?? ""
        const link = Effect.flatMap(fs, (f) => f.readLink(`${wt}/node_modules`)).pipe(Effect.orDie)
        assert.strictEqual(yield* link, `${old}/node_modules`)
        p = yield* Effect.flatMap(Projects, (ps) => ps.update(p.id, { link_folders: "" })).pipe(Effect.orDie)
        const moved = `${dir}/moved`
        yield* update(p, { repo_path: moved, move_repo: true })
        assert.strictEqual(yield* link, `${moved}/node_modules`)
        assert.strictEqual(yield* read(`${wt}/node_modules/pkg/index.js`), "module")
      }),
    ),
  )

  it.live("records a project's fingerprint once its folder is a repository, only where it still is", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* temp
        const old = `${dir}/later`
        yield* mkdir(old)
        const p = yield* create({ profile_id: (yield* profile).id, name: "later", repo_path: old })
        const projects = yield* Projects
        yield* projects.recordFingerprints
        assert.strictEqual(yield* repoRoot(p), "")
        yield* repo(old)
        yield* projects.recordFingerprints
        const root = yield* repoRoot(p)
        assert.isTrue(isHistory(root))
        // A history known is kept.
        yield* git(old, ["commit", "-q", "--allow-empty", "--amend", "-m", "other"])
        yield* projects.recordFingerprints
        assert.strictEqual(yield* repoRoot(p), root)
      }),
    ),
  )
})
