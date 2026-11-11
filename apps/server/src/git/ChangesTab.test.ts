import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import type { Scope } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { SqlClient } from "effect/sql"
import { git, tempDir, TestBoard } from "@huntaway/testing"
import type { GitStatus, TaskId } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import type { DataDir } from "../platform/DataDir.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { badPath, badRev, numstatPaths, parseStatus } from "./changes/parse.ts"
import { ChangesTab } from "./ChangesTab.ts"
import { Git } from "./Git.ts"
import { Worktrees } from "./Worktrees.ts"

// huntaway's git/git_view/tests.test.ts, every case, on the whole board's services with real repositories in temp
// folders and git with none of the machine's configuration. The old 400 is `ChangesInvalid`, the old 409
// `ChangesRefused`.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

type Env = ChangesTab | Worktrees | Tasks | Projects | Profiles | Git | DataDir | SqlClient.SqlClient
const run = <A, E>(effect: Effect.Effect<A, E, Env | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

const write = (path: string, text: string | Uint8Array) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    if (typeof text === "string") yield* fs.writeFileString(path, text)
    else yield* fs.writeFile(path, text)
  }).pipe(Effect.orDie)
const read = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(Effect.orDie)
const exists = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path)).pipe(Effect.orDie)
const remove = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(path)).pipe(Effect.orDie)
/** git's output, untrimmed (the testing helper trims it). */
const out = (dir: string, args: ReadonlyArray<string>) => Effect.map(Effect.flatMap(Git, (g) => g.ok(dir, args)).pipe(Effect.orDie), (s) => s)
const bytes = (dir: string, args: ReadonlyArray<string>) => Effect.map(Effect.flatMap(Git, (g) => g.bytes(dir, args)).pipe(Effect.orDie), (o) => o.stdout)

/** What a call failed with: the old status code (400 for `ChangesInvalid`, 409 for `ChangesRefused`) and the text. */
const fails = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (e) => ({
    status: e._tag === "ChangesInvalid" ? 400 : e._tag === "ChangesRefused" ? 409 : 0,
    message: "reason" in e && typeof e.reason === "string" ? `${e.reason}: ${"detail" in e ? String(e.detail) : ""}` : e._tag,
  }))

/** A file in the status. */
const fileRow = (path: string, orig: string | null, x: string, y: string) => ({ path, orig_path: orig, x, y })

const lines20 = () => Array.from({ length: 20 }, (_, i) => `${i + 1}\n`).join("")

/** A repository in a folder of its own, on master, committing as "t". */
const newRepo = (dir: string) =>
  Effect.gen(function* () {
    yield* git(dir, ["init", "-q", "-b", "master"])
    yield* git(dir, ["config", "user.name", "t"])
    yield* git(dir, ["config", "user.email", "t@t"])
  })

/** A project on `repo` in a profile of its own, and a task in it. */
const taskIn = (repo: string, more: { readonly base_branch?: string | null; readonly use_worktrees?: boolean } = {}) =>
  Effect.gen(function* () {
    const profile = yield* (yield* Profiles).create({ name: "p" })
    const project = yield* (yield* Projects).create({ profile_id: profile.id, name: "x", key: "X", repo_path: repo, ...more })
    return (yield* (yield* Tasks).create({ project_id: project.id, title: "Do it" }, Actor.user)).id
  }).pipe(Effect.orDie)

/**
 * A task with a worktree on a branch with one commit ("branch work"), in a repository whose master has `f.txt` (20
 * numbered lines) and `gone.txt`: the task and its worktree.
 */
const taskRepo = Effect.gen(function* () {
  const repo = `${yield* tempDir}/repo`
  yield* write(`${repo}/f.txt`, lines20())
  yield* write(`${repo}/gone.txt`, "bye\n")
  yield* newRepo(repo)
  yield* git(repo, ["add", "."])
  yield* git(repo, ["commit", "-qm", "init"])
  const id = yield* taskIn(repo, { base_branch: "master" })
  const task = yield* (yield* Worktrees).setup(id).pipe(Effect.orDie)
  const wt = task.worktree_path ?? ""
  yield* write(`${wt}/b.txt`, "b\n")
  yield* git(wt, ["add", "b.txt"])
  yield* git(wt, ["commit", "-qm", "branch work"])
  return { id, wt }
})

const status = (id: TaskId) => Effect.flatMap(ChangesTab, (c) => c.status(id)).pipe(Effect.orDie)
const files = (st: GitStatus) => st.files ?? []
const subjects = (id: TaskId) => Effect.map(status(id), (st) => (st.commits ?? []).map((c) => c.subject))
const diff = (id: TaskId, path: string, staged: boolean, untracked: boolean) => Effect.flatMap(ChangesTab, (c) => c.diff(id, path, { staged, untracked }))
const patchOf = (id: TaskId, path: string, staged: boolean, untracked: boolean) =>
  Effect.map(diff(id, path, staged, untracked).pipe(Effect.orDie), (d) => d.patch)
const tab = Effect.map(ChangesTab, (c) => c)

describe("ChangesTab", () => {
  it("reads the porcelain status", () => {
    const text =
      "# branch.oid 0123abcd\0# branch.head ia/x-1\0# branch.upstream origin/ia/x-1\0# branch.ab +2 -1\0" +
      "1 .M N... 100644 100644 100644 aa aa src/a b.rs\0" +
      "2 R. N... 100644 100644 100644 aa aa R100 new name\0old name\0" +
      "u UU N... 100644 100644 100644 100644 aa bb cc both\0" +
      "? new dir/x\0"
    const st = parseStatus(text)
    assert.deepStrictEqual([st.head, st.branch, st.upstream], ["0123abcd", "ia/x-1", "origin/ia/x-1"])
    assert.deepStrictEqual([st.ahead, st.behind, st.truncated], [2, 1, false])
    assert.deepStrictEqual(st.files, [
      fileRow("src/a b.rs", null, " ", "M"),
      fileRow("new name", "old name", "R", " "),
      fileRow("both", null, "U", "U"),
      fileRow("new dir/x", null, "?", "?"),
    ])
    // Before the first commit, and detached.
    const st2 = parseStatus("# branch.oid (initial)\0# branch.head (detached)\0")
    assert.deepStrictEqual([st2.head, st2.branch, st2.files.length], [null, null, 0])
    // No more than 5,000 files.
    const many = parseStatus(Array.from({ length: 5001 }, (_, i) => `? f${i}\0`).join(""))
    assert.deepStrictEqual([many.files.length, many.truncated], [5000, true])
  })

  it("checks paths and hashes", () => {
    for (const ok of ["a", "a/b c", "./a", ".hidden/x"]) assert.isNull(badPath(ok), ok)
    for (const bad of ["", "/etc/passwd", "../x", "a/../../x"]) assert.isNotNull(badPath(bad), bad)
    assert.isNull(badRev("0123abcdef"))
    for (const bad of ["--hard", "HEAD", "abc", "0123abcz", "a".repeat(65)]) assert.isNotNull(badRev(bad), bad)
  })

  it("reads the paths of a patch, renames' both", () => {
    assert.deepStrictEqual(numstatPaths("1\t0\ta.txt\x000\t0\t\0old\0new\0-\t-\tbin\0"), ["a.txt", "old", "new", "bin"])
  })

  it.live("stages lines and files and discards them", () =>
    run(
      Effect.gen(function* () {
        const { id, wt } = yield* taskRepo
        const c = yield* tab
        const f = Array.from({ length: 20 }, (_, k) => k + 1)
          .map((i) => (i === 2 ? "two\n" : i === 15 ? "fifteen\n" : `${i}\n`))
          .join("")
        yield* write(`${wt}/f.txt`, f)
        yield* remove(`${wt}/gone.txt`)
        yield* write(`${wt}/new/u.txt`, "u1\nu2\n")

        const st = yield* status(id)
        assert.deepStrictEqual(
          files(st).map((x) => `${x.x}${x.y} ${x.path}`),
          [" M f.txt", " D gone.txt", "?? new/u.txt"],
        )
        assert.deepStrictEqual([st.base, st.branch], ["master", yield* git(wt, ["branch", "--show-current"])])
        assert.deepStrictEqual(
          (st.commits ?? []).map((x) => [x.subject, x.on_branch]),
          [
            ["branch work", true],
            ["init", false],
          ],
        )

        // Two hunks: staging a patch of the first stages just that.
        const patch = yield* patchOf(id, "f.txt", false, false)
        assert.strictEqual(patch.split("\n@@ ").length - 1, 2, patch)
        const first = patch.slice(0, patch.lastIndexOf("\n@@ ") + 1)
        yield* c.apply(id, first, { cached: true, reverse: false })
        const staged = yield* patchOf(id, "f.txt", true, false)
        assert.isTrue(staged.includes("+two\n") && !staged.includes("fifteen"), staged)
        // …and its reverse unstages it again.
        yield* c.apply(id, staged, { cached: true, reverse: true })
        assert.strictEqual(yield* patchOf(id, "f.txt", true, false), "")
        // A patch that no longer fits is refused, with git's reason.
        const err = yield* fails(c.apply(id, first.replace("-2\n", "-3\n"), { cached: true, reverse: false }))
        assert.strictEqual(err.status, 409, err.message)

        // An untracked file's diff is as if it were added.
        const u = yield* patchOf(id, "new/u.txt", false, true)
        assert.isTrue(u.includes("new file mode") && u.includes("+++ b/new/u.txt") && u.includes("+u2\n"), u)
        assert.strictEqual((yield* fails(diff(id, "../x", false, true))).status, 400)

        // Whole files, and everything.
        yield* c.stage(id, ["gone.txt"])
        assert.strictEqual(files(yield* status(id))[1]?.x, "D")
        yield* c.stage(id, [])
        assert.deepStrictEqual(
          files(yield* status(id)).map((x) => `${x.x}${x.y}`),
          ["M ", "D ", "A "],
        )
        yield* c.unstage(id, ["f.txt"])
        assert.strictEqual(files(yield* status(id))[0]?.x, " ")
        yield* c.unstage(id, [])
        assert.strictEqual(yield* patchOf(id, ".", true, false), "")

        // HA-341: a folder isn't discarded: its untracked files would go and its tracked ones stay changed.
        yield* write(`${wt}/new/v.txt`, "v\n")
        assert.strictEqual((yield* fails(c.discard(id, ["new"], false))).status, 400)
        assert.isTrue(yield* exists(`${wt}/new/v.txt`))
        yield* remove(`${wt}/new/v.txt`)

        // Discarding what isn't staged goes back to the index; with `staged`, to HEAD.
        yield* git(wt, ["add", "new/u.txt"])
        yield* write(`${wt}/new/u.txt`, "changed\n")
        yield* c.discard(id, ["gone.txt", "new/u.txt"], false)
        assert.strictEqual(yield* read(`${wt}/gone.txt`), "bye\n")
        assert.strictEqual(yield* read(`${wt}/new/u.txt`), "u1\nu2\n")
        yield* git(wt, ["add", "f.txt"])
        yield* write(`${wt}/untracked.txt`, "x\n")
        yield* c.discard(id, ["f.txt", "new/u.txt", "untracked.txt"], true)
        assert.deepStrictEqual(files(yield* status(id)), [])
        assert.isFalse((yield* exists(`${wt}/new/u.txt`)) || (yield* exists(`${wt}/untracked.txt`)))
        assert.strictEqual(yield* read(`${wt}/f.txt`), lines20())
        // Nothing to discard.
        assert.strictEqual((yield* fails(c.discard(id, [], false))).status, 400)
      }),
    ),
  )

  it.live("commits, stashes and resets", () =>
    run(
      Effect.gen(function* () {
        const { id, wt } = yield* taskRepo
        const c = yield* tab
        const commitWith = (message: string, amend: boolean, reword: boolean) => c.commit(id, message, { amend, reword })

        assert.strictEqual((yield* fails(commitWith(" ", false, false))).status, 400)
        yield* write(`${wt}/c.txt`, "c\n")
        yield* c.stage(id, [])
        yield* commitWith("add c\n\nwith a body", false, false)
        assert.deepStrictEqual(yield* subjects(id), ["add c", "branch work", "init"])
        // Amending keeps the message; rewording leaves what's staged.
        yield* write(`${wt}/c.txt`, "cc\n")
        yield* c.stage(id, [])
        yield* commitWith("", true, false)
        assert.deepStrictEqual(yield* subjects(id), ["add c", "branch work", "init"])
        assert.strictEqual(yield* out(wt, ["show", "HEAD:c.txt"]), "cc\n")
        yield* write(`${wt}/c.txt`, "ccc\n")
        yield* c.stage(id, [])
        const head = yield* commitWith("reworded", true, true)
        assert.deepStrictEqual(yield* subjects(id), ["reworded", "branch work", "init"])
        assert.deepStrictEqual([yield* out(wt, ["show", "HEAD:c.txt"]), yield* out(wt, ["show", ":c.txt"])], ["cc\n", "ccc\n"])
        assert.strictEqual(head, yield* git(wt, ["rev-parse", "HEAD"]))

        // A commit's message and changes.
        const shown = yield* c.show(id, head, false)
        assert.deepStrictEqual([shown.message, shown.sha], ["reworded", head])
        assert.include(shown.patch, "+cc\n")
        assert.strictEqual((yield* fails(c.show(id, "HEAD", false))).status, 400)

        // Stash everything (untracked files too), then pop it, given the stash's commit.
        yield* write(`${wt}/u.txt`, "u\n")
        yield* c.stash(id, { action: "push", message: "wip" })
        let st = yield* status(id)
        assert.deepStrictEqual(files(st), [])
        const sha = st.stashes?.[0]?.sha ?? ""
        assert.isTrue(st.stashes?.[0]?.subject.endsWith(": wip"))
        const stashed = yield* c.show(id, sha, true)
        assert.include(stashed.patch, "+u\n")
        const pop = (of: string) => c.stash(id, { action: "pop", message: "", index: 0, sha: of })
        const changed = yield* fails(pop(head))
        assert.strictEqual(changed.status, 409)
        assert.include(changed.message, "changed_meanwhile")
        assert.strictEqual((yield* fails(c.stash(id, { action: "pop" }))).status, 400)
        yield* pop(sha)
        st = yield* status(id)
        assert.deepStrictEqual([files(st).length, st.stashes?.length], [2, 0])

        // A soft reset keeps the undone commit's changes staged.
        const work = (yield* status(id)).commits?.[1]?.sha ?? ""
        assert.strictEqual((yield* fails(c.reset(id, "HEAD~1", "soft"))).status, 400)
        yield* c.reset(id, work, "soft")
        assert.deepStrictEqual(yield* subjects(id), ["branch work", "init"])
        assert.strictEqual(yield* out(wt, ["diff", "--cached", "--name-only"]), "c.txt\n")
      }),
    ),
  )

  // HA-42: a project folder inside a bigger repository (a home folder kept as a dotfiles repository) staged, stashed and
  // reset that whole repository.
  it.live("a folder inside a bigger repository is all that is touched", () =>
    run(
      Effect.gen(function* () {
        const home = `${yield* tempDir}/home`
        const proj = `${home}/proj`
        yield* write(`${home}/.bashrc`, "rc\n")
        yield* write(`${proj}/a.txt`, "a\n")
        yield* newRepo(home)
        yield* git(home, ["add", "."])
        yield* git(home, ["commit", "-qm", "dotfiles"])
        yield* write(`${home}/.bashrc`, "rc\nmine\n")
        yield* git(home, ["commit", "-qam", "outside only"])
        const id = yield* taskIn(proj, { use_worktrees: false })
        const c = yield* tab
        yield* write(`${home}/.bashrc`, "rc\nmine\nmore\n")
        yield* write(`${proj}/a.txt`, "a\nb\n")

        // Only the folder's files and commits.
        const st = yield* status(id)
        assert.strictEqual(st.folder, "proj/")
        assert.deepStrictEqual(
          files(st).map((f) => f.path),
          ["proj/a.txt"],
        )
        assert.deepStrictEqual(
          (st.commits ?? []).map((x) => x.subject),
          ["dotfiles"],
        )
        assert.deepStrictEqual(st.stashes, [])
        // Staging everything stages the folder's; files outside it can't be named.
        yield* c.stage(id, [])
        assert.strictEqual(yield* out(home, ["diff", "--cached", "--name-only"]), "proj/a.txt\n")
        assert.strictEqual((yield* fails(c.stage(id, [".bashrc"]))).status, 400)
        assert.strictEqual((yield* fails(c.discard(id, [".bashrc"], true))).status, 400)
        const rc = yield* out(home, ["diff", "--", ".bashrc"])
        const err = yield* fails(c.apply(id, rc, { cached: true, reverse: false }))
        assert.strictEqual(err.status, 400, err.message)
        const renamed = "diff --git a/proj/a.txt b/.profile\nsimilarity index 100%\nrename from proj/a.txt\nrename to .profile\n"
        assert.strictEqual((yield* fails(c.apply(id, renamed, { cached: true, reverse: false }))).status, 400)
        // What would act on the whole repository is refused.
        const head = yield* git(home, ["rev-parse", "HEAD"])
        const first = yield* git(home, ["rev-parse", "HEAD~"])
        const reset = yield* fails(c.reset(id, first, "hard"))
        assert.strictEqual(reset.status, 409)
        assert.include(reset.message, "whole_repository")
        assert.strictEqual((yield* fails(c.stash(id, { action: "push" }))).status, 409)
        assert.strictEqual((yield* fails(c.commit(id, "", { amend: true, reword: false }))).status, 409)
        // A commit would take what's staged outside the folder too.
        yield* git(home, ["add", ".bashrc"])
        const outside = yield* fails(c.commit(id, "a", { amend: false, reword: false }))
        assert.isTrue(outside.status === 409 && outside.message.includes(".bashrc"), outside.message)
        yield* git(home, ["reset", "-q", "--", ".bashrc"])
        yield* c.commit(id, "a", { amend: false, reword: false })
        assert.strictEqual(yield* out(home, ["show", "--name-only", "--format=", "HEAD"]), "proj/a.txt\n")
        assert.strictEqual(yield* git(home, ["rev-parse", "HEAD~"]), head)
        assert.strictEqual(yield* read(`${home}/.bashrc`), "rc\nmine\nmore\n")
      }),
    ),
  )

  it.live("unstages before the first commit", () =>
    run(
      Effect.gen(function* () {
        const repo = `${yield* tempDir}/repo`
        yield* write(`${repo}/a`, "a\n")
        yield* write(`${repo}/b`, "b\n")
        yield* newRepo(repo)
        const id = yield* taskIn(repo, { use_worktrees: false })
        const c = yield* tab
        yield* c.stage(id, [])
        const st = yield* status(id)
        assert.deepStrictEqual([st.head, st.commits, files(st)[0]?.x], [null, [], "A"])
        yield* c.unstage(id, ["a"])
        assert.strictEqual(yield* out(repo, ["diff", "--cached", "--name-only"]), "b\n")
        yield* c.unstage(id, [])
        assert.strictEqual(yield* out(repo, ["diff", "--cached", "--name-only"]), "")
      }),
    ),
  )

  // A patch made from a lossily decoded diff wrote U+FFFD into the index in place of a Latin-1 byte.
  it.live("files not in UTF-8 are staged whole, not by line", () =>
    run(
      Effect.gen(function* () {
        const { id, wt } = yield* taskRepo
        const c = yield* tab
        // A Latin-1 line added to f.txt, and an untracked Latin-1 file.
        const f = new Uint8Array([...new TextEncoder().encode(lines20()), 0x63, 0x61, 0x66, 0xe9, 0x0a])
        yield* write(`${wt}/f.txt`, f)
        const latin = new Uint8Array([0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a])
        yield* write(`${wt}/latin.txt`, latin)
        for (const [path, untracked, line] of [
          ["f.txt", false, "+caf�\n"],
          ["latin.txt", true, "+na�ve\n"],
        ] as const) {
          const d = yield* diff(id, path, false, untracked)
          assert.deepStrictEqual([d.patch, d.not_utf8], ["", true], path)
          assert.include(d.preview ?? "", line, path)
        }
        // Staged whole, their bytes are kept; and the staged diff isn't for staging by line either.
        yield* c.stage(id, ["f.txt", "latin.txt"])
        assert.deepStrictEqual([yield* bytes(wt, ["show", ":f.txt"]), yield* bytes(wt, ["show", ":latin.txt"])], [f, latin])
        assert.isTrue((yield* diff(id, "f.txt", true, false)).not_utf8)
        // UTF-8 text that isn't ASCII is staged by line as before.
        yield* write(`${wt}/utf8.txt`, "café\n")
        const d = yield* diff(id, "utf8.txt", false, true)
        assert.isTrue(d.patch.includes("+café\n") && d.not_utf8 === undefined, d.patch)
        // Past 4 MiB a diff isn't sent.
        yield* write(`${wt}/big.txt`, "x".repeat(100).concat("\n").repeat(42_000))
        assert.deepStrictEqual(yield* diff(id, "big.txt", false, true), { patch: "", too_large: true })
      }),
    ),
  )

  it.live("says when there is no repository, and refuses to act on one", () =>
    run(
      Effect.gen(function* () {
        const dir = `${yield* tempDir}/plain`
        yield* write(`${dir}/a`, "a\n")
        const id = yield* taskIn(dir, { use_worktrees: false })
        assert.deepStrictEqual(yield* status(id), { available: false, reason: "not a git repository" })
        assert.strictEqual((yield* fails(Effect.flatMap(ChangesTab, (c) => c.stage(id, [])))).status, 400)
      }),
    ),
  )
})
