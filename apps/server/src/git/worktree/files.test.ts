import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import type { Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { git, tempDir, TestBoard } from "@huntaway/testing"
import type { Project, TaskId } from "@huntaway/contracts"
import { Actor } from "../../platform/Changes.ts"
import { Profiles } from "../../profiles/Profiles.ts"
import { Projects } from "../../projects/Projects.ts"
import { checkFileList } from "../../projects/checks.ts"
import { Tasks } from "../../tasks/Tasks.ts"
import { Threads } from "../../threads/Threads.ts"
import { Git } from "../Git.ts"
import { Worktrees } from "../Worktrees.ts"
import { bringIn, checkPattern, INCLUDE_FILE, linkPath, literalMatches, relink } from "./files.ts"

// huntaway's git/worktree_files.test.ts: the ignored files and folders a project brings into each new worktree.
// Dropped: `links_are_moved_with_the_repository_even_once_out_of_the_setting` (moving a project's folder is
// `Relocation`'s, a later task; `relink`, which it calls, is tested here on its own).

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

type Needs =
  | SqlClient.SqlClient
  | Worktrees
  | Tasks
  | Projects
  | Profiles
  | Threads
  | Git
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope
const run = <A, E>(effect: Effect.Effect<A, E, Needs>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

const sh = (command: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) => spawner.string(ChildProcess.make(command, args))).pipe(Effect.orDie)
const write = (path: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    yield* fs.writeFileString(path, text)
  }).pipe(Effect.orDie)
const read = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(Effect.orDie)
const exists = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path)).pipe(Effect.orDie)
const symlink = (target: string, path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.symlink(target, path)).pipe(Effect.orDie)
/** Whether anything is at `path`, a broken link too. */
const there = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.lstat(path).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ),
  )
const isLink = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.lstat(path).pipe(
      Effect.map((i) => i.type === "SymbolicLink"),
      Effect.orElseSucceed(() => false),
    ),
  )
const readLink = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readLink(path)).pipe(Effect.orDie)
const notices = (id: TaskId) =>
  Effect.map(Effect.flatMap(Threads, (t) => t.stored(id)).pipe(Effect.orDie), (s) =>
    s.entries.flatMap((e) => (e.item.type === "notice" ? [{ level: e.item.level, text: e.item.text, detail: e.item.detail ?? "" }] : [])),
  )

interface Fixture {
  readonly root: string
  readonly repo: string
  readonly outside: string
  readonly project: Project
}

/** A repository with ignored files and folders, a folder outside it, and a project on it. */
const fixture = (copyFiles: string, linkFolders: string) =>
  Effect.gen(function* () {
    const root = yield* tempDir
    const repo = `${root}/repo`
    const outside = `${root}/outside`
    yield* write(`${outside}/passwd`, "outside")
    yield* sh("mkdir", ["-p", repo])
    yield* git(repo, ["init", "-q", "-b", "master"])
    yield* write(`${repo}/.gitignore`, ".env\nnode_modules/\ncache/\nbuild/\n*.local.json\nleak\nout-dir\nlinked-file\n")
    yield* write(`${repo}/README`, "readme")
    yield* write(`${repo}/config/app.local.json`, "tracked")
    yield* write(`${repo}/${INCLUDE_FILE}`, "# from the repository\n/config/*.local.json\n")
    yield* git(repo, ["add", "."])
    yield* git(repo, ["add", "-f", "config/app.local.json"])
    yield* git(repo, ["commit", "-qm", "init"])
    // Ignored, untracked: copied or linked.
    yield* write(`${repo}/.env`, "secret")
    yield* write(`${repo}/sub/.env`, "sub secret")
    yield* write(`${repo}/config/dev.local.json`, "dev")
    yield* write(`${repo}/build/out.txt`, "built")
    yield* write(`${repo}/node_modules/pkg/index.js`, "module")
    yield* write(`${repo}/cache/model.bin`, "weights")
    // The tracked file, changed in the repository folder: the worktree keeps its own.
    yield* write(`${repo}/config/app.local.json`, "changed")
    // Untracked but not ignored: never copied.
    yield* write(`${repo}/notes.txt`, "notes")
    // Ignored symlinks leading out of the repository.
    yield* symlink(`${outside}/passwd`, `${repo}/leak`)
    yield* symlink(outside, `${repo}/out-dir`)
    const profile = yield* (yield* Profiles).create({ name: "p" }).pipe(Effect.orDie)
    const created = yield* (yield* Projects).create({ profile_id: profile.id, name: "x", key: "X", repo_path: repo, base_branch: "master" }).pipe(Effect.orDie)
    const project = yield* (yield* Projects).update(created.id, { copy_files: copyFiles, link_folders: linkFolders }).pipe(Effect.orDie)
    const fixed: Fixture = { root, repo: project.repo_path, outside, project }
    return fixed
  })

const newTask = (f: Fixture, title: string) =>
  Effect.gen(function* () {
    const t = yield* (yield* Tasks).create({ project_id: f.project.id, title }, Actor.user).pipe(Effect.orDie)
    const set = yield* (yield* Worktrees).setup(t.id)
    return { t: set, wt: set.worktree_path ?? "" }
  })

/** The originals the worktree's links lead to are all still there. */
const originalsIntact = (f: Fixture) =>
  Effect.gen(function* () {
    assert.strictEqual(yield* read(`${f.repo}/node_modules/pkg/index.js`), "module")
    assert.strictEqual(yield* read(`${f.repo}/cache/model.bin`), "weights")
    assert.strictEqual(yield* read(`${f.repo}/.env`), "secret")
    assert.strictEqual(yield* read(`${f.outside}/passwd`), "outside")
  })

const COPY = ".env\n# a comment\nbuild/out.txt\nleak\nnotes.txt\nREADME\nmissing.txt\n../escape\n"
const LINK = "node_modules\n./cache/\nmissing-dir\n.env\nout-dir\nREADME\n/etc\n"

describe("worktree files", () => {
  it.live("copies ignored files and links ignored folders before the setup script", () =>
    run(
      Effect.gen(function* () {
        // The settings' checks would refuse `../escape` and `/etc`: stored as they are, to see bringIn leave them out.
        const f = yield* fixture("", "")
        yield* (yield* Projects).update(f.project.id, { setup_script: "cat .env node_modules/pkg/index.js > seen" })
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE projects SET copy_files = ${COPY}, link_folders = ${LINK} WHERE id = ${f.project.id}`.pipe(Effect.orDie)
        const { t, wt } = yield* newTask(f, "Do it")
        // The setup script sees them.
        assert.strictEqual(yield* read(`${wt}/seen`), "secretmodule")
        yield* sh("rm", [`${wt}/seen`])
        // Ignored files matching the patterns, at any depth unless anchored, and from .worktreeinclude.
        assert.strictEqual(yield* read(`${wt}/.env`), "secret")
        assert.strictEqual(yield* read(`${wt}/sub/.env`), "sub secret")
        assert.strictEqual(yield* read(`${wt}/build/out.txt`), "built")
        assert.strictEqual(yield* read(`${wt}/config/dev.local.json`), "dev")
        // Not tracked files (the branch's own is kept), not untracked ones git doesn't ignore, and nothing from outside.
        assert.strictEqual(yield* read(`${wt}/config/app.local.json`), "tracked")
        for (const not of ["notes.txt", "leak", "out-dir", "missing.txt", "missing-dir"]) assert.isFalse(yield* there(`${wt}/${not}`), not)
        // The folders are links to the repository's.
        assert.strictEqual(yield* readLink(`${wt}/node_modules`), `${f.repo}/node_modules`)
        assert.strictEqual(yield* readLink(`${wt}/cache`), `${f.repo}/cache`)
        assert.strictEqual(yield* read(`${wt}/cache/model.bin`), "weights")
        // None of it is a change to commit: the links are excluded, since `node_modules/` doesn't ignore a symlink.
        assert.strictEqual(yield* git(wt, ["status", "--porcelain", "--untracked-files=all"]), "")
        assert.include(yield* read(`${f.repo}/.git/info/exclude`), "\n/node_modules\n/cache\n")

        const evs = yield* notices(t.id)
        const e = evs.find((x) => x.text.includes("from the repository"))
        assert.deepStrictEqual([e?.level, e?.text], ["warning", "Copied 4 files and linked 2 folders from the repository (10 left out)"])
        const detail = (e?.detail ?? "").split("\n")
        for (const line of [
          "Read .worktreeinclude",
          "copied .env",
          "copied sub/.env",
          "copied config/dev.local.json",
          `linked node_modules -> ${f.repo}/node_modules`,
          "left out: leak: a symbolic link",
          "left out: 1 matching file git doesn't ignore (only ignored files are copied): notes.txt",
          "left out: README: tracked by git, not copied",
          "left out: missing.txt: not in the repository",
          "left out: ../escape: patterns are relative to the repository, without ..",
          "left out: missing-dir: not in the repository",
          "left out: .env: not a folder",
          "left out: out-dir: a symbolic link",
          "left out: README: not a folder",
          "left out: /etc: folders are relative to the repository",
        ]) {
          assert.include(detail, line)
        }
        // Before the setup script ran.
        const at = (text: string) => evs.findIndex((x) => x.text.startsWith(text))
        assert.isTrue(at("Copied") < at("Running setup script"))
        // Writing through a link changes the original (that's what linking is for).
        yield* write(`${wt}/node_modules/pkg/new.js`, "new")
        assert.strictEqual(yield* read(`${f.repo}/node_modules/pkg/new.js`), "new")
        // A second task adds no second exclude line.
        const second = yield* newTask(f, "Another")
        assert.isTrue(yield* isLink(`${second.wt}/node_modules`))
        assert.strictEqual((yield* read(`${f.repo}/.git/info/exclude`)).split("/node_modules\n").length - 1, 1)
      }),
    ),
  )

  it.live("removing a worktree removes its links, not what they lead to", () =>
    run(
      Effect.gen(function* () {
        const w = yield* Worktrees
        const f = yield* fixture(".env\n", "node_modules\ncache\n")
        // Plain teardown (git's own check, then `git worktree remove`).
        let { t, wt } = yield* newTask(f, "Plain")
        assert.isTrue(yield* isLink(`${wt}/node_modules`))
        yield* w.teardown(t.id, { force: false, deleteBranch: false })
        assert.isFalse(yield* exists(wt))
        yield* originalsIntact(f)
        // Forced teardown.
        ;({ t, wt } = yield* newTask(f, "Forced"))
        yield* write(`${wt}/uncommitted`, "u")
        yield* w.teardown(t.id, { force: true, deleteBranch: true })
        assert.isFalse(yield* exists(wt))
        yield* originalsIntact(f)
        // Removed by hand when git won't (a locked worktree).
        ;({ t, wt } = yield* newTask(f, "Locked"))
        yield* git(f.repo, ["worktree", "lock", wt])
        yield* w.teardown(t.id, { force: true, deleteBranch: false })
        assert.isFalse(yield* exists(wt))
        yield* originalsIntact(f)
        // Remove merged worktrees: copied files and links don't count as work that would be lost.
        ;({ t, wt } = yield* newTask(f, "Merged"))
        yield* write(`${wt}/a`, "a")
        yield* git(wt, ["add", "a"])
        yield* git(wt, ["commit", "-qm", "a"])
        yield* git(f.repo, ["merge", "-q", "--no-ff", "-m", "merge", t.branch ?? ""])
        yield* (yield* Tasks).change(t.id, () => ({ status: "done" }), Actor.board).pipe(Effect.orDie)
        const [result] = yield* w.removeMerged(f.project.id)
        assert.deepStrictEqual([result?.removed, result?.detail], [true, "merged into master"])
        assert.isFalse(yield* exists(wt))
        yield* originalsIntact(f)
        // And when merged on its own.
        ;({ t, wt } = yield* newTask(f, "Merged too"))
        yield* (yield* Tasks).change(t.id, () => ({ status: "done" }), Actor.board).pipe(Effect.orDie)
        assert.deepStrictEqual(yield* w.removeIfMerged(t.id, false), { _tag: "Removed", into: "master" })
        assert.isFalse(yield* exists(wt))
        yield* originalsIntact(f)
        assert.isFalse(yield* isLink(`${f.repo}/node_modules`))
      }),
    ),
  )

  it.live("never overwrites or writes through a symlink in the worktree", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture(".env\nbuild/\n", "node_modules\n")
        const { wt } = yield* newTask(f, "Do it")
        // Changed in the worktree, and the link replaced by a folder of its own.
        yield* write(`${wt}/.env`, "mine")
        yield* sh("rm", [`${wt}/node_modules`])
        yield* write(`${wt}/node_modules/own.js`, "own")
        // A symlink in the worktree where a copy would go.
        yield* sh("rm", ["-r", `${wt}/build`])
        yield* symlink(f.outside, `${wt}/build`)
        const report = yield* bringIn({ git: yield* Git, fs: yield* FileSystem.FileSystem }, f.project, wt)
        assert.strictEqual(yield* read(`${wt}/.env`), "mine")
        assert.isFalse(yield* isLink(`${wt}/node_modules`))
        assert.isFalse(yield* exists(`${f.outside}/out.txt`))
        assert.deepStrictEqual([report.copied, report.linked], [[], []])
        assert.deepStrictEqual(report.existing, [".env", "config/dev.local.json", "sub/.env", "node_modules"])
        assert.deepStrictEqual(report.skipped, ["build/out.txt: build in the worktree isn't a folder"])
      }),
    ),
  )

  it.live("a task branch that doesn't ignore a file doesn't get it", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture(".env\n", "")
        yield* git(f.repo, ["checkout", "-q", "-b", "old"])
        yield* write(`${f.repo}/.gitignore`, "node_modules/\n")
        yield* git(f.repo, ["commit", "-qam", "unignore"])
        yield* git(f.repo, ["checkout", "-q", "master"])
        const t = yield* (yield* Tasks).create({ project_id: f.project.id, title: "Old" }, Actor.user).pipe(Effect.orDie)
        yield* (yield* Tasks).update(t.id, { base_branch: "old" }, Actor.user).pipe(Effect.orDie)
        const wt = (yield* (yield* Worktrees).setup(t.id)).worktree_path ?? ""
        assert.isFalse(yield* exists(`${wt}/.env`))
        assert.strictEqual(yield* git(wt, ["status", "--porcelain"]), "")
      }),
    ),
  )

  it.live("a repository with nothing to bring in logs nothing", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture("", "")
        yield* sh("rm", [`${f.repo}/${INCLUDE_FILE}`])
        const { t } = yield* newTask(f, "Do it")
        assert.isFalse((yield* notices(t.id)).some((e) => e.text.includes("from the repository")))
      }),
    ),
  )

  it.effect("checks what the settings name", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(linkPath("./models/cache/"), { ok: "models/cache" })
      for (const bad of ["/etc", "~/x", "../x", "a/../../x", ".", ".git", "a/.git/hooks"]) assert.isTrue("err" in linkPath(bad), bad)
      assert.strictEqual(checkPattern("!/config/*.json"), null)
      assert.isTrue(checkPattern("a/../b") !== null && checkPattern("!../b") !== null)
      assert.strictEqual(yield* checkFileList("copy_files", ".env\n# ../comment\n"), ".env\n# ../comment")
      const bad = yield* Effect.flip(checkFileList("link_folders", "models\n/abs\n"))
      assert.include(bad.reason, "link_folders: /abs")
      assert.strictEqual((yield* Effect.flip(checkFileList("copy_files", "x\n".repeat(201))))._tag, "Invalid")
    }),
  )

  it("matches literal patterns as git would", () => {
    const m = literalMatches
    assert.isTrue(m(".env", ".env") && m(".env", "a/b/.env") && m("build/", "build/x") && m("build", "a/build/x"))
    assert.isTrue(m("/.env", ".env") && !m("/.env", "a/.env") && m("a/b", "a/b/c") && !m("a/b", "x/a/b"))
    assert.isTrue(!m(".env", ".env.local") && !m("build", "builder/x"))
  })

  it.live("relinks folders after the repository moves", () =>
    run(
      Effect.gen(function* () {
        const root = yield* tempDir
        const wt = `${root}/wt`
        yield* sh("mkdir", ["-p", `${wt}/a`])
        yield* symlink(`${root}/old/models`, `${wt}/models`)
        yield* symlink(`${root}/elsewhere`, `${wt}/a/b`)
        const old = `${root}/old`
        const map = (p: string) => (p === old || p.startsWith(`${old}/`) ? `${root}/new${p.slice(old.length)}` : null)
        yield* relink({ git: yield* Git, fs: yield* FileSystem.FileSystem }, wt, "models\na/b\n", map)
        assert.strictEqual(yield* readLink(`${wt}/models`), `${root}/new/models`)
        assert.strictEqual(yield* readLink(`${wt}/a/b`), `${root}/elsewhere`)
      }),
    ),
  )

  // HA-52 review: the git checks were of a symlink's own (ignored, untracked) path, while the copy or link led to
  // tracked files or the repository's .git.
  it.live("symlinks in the repository are neither copied nor linked", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture("alias-file\nvia/x.env\n", "alias-dir\ngit-alias\nvia/inner\n")
        yield* write(`${f.repo}/src/app.txt`, "tracked app")
        yield* write(`${f.repo}/src/inner/x.env`, "tracked env")
        yield* write(`${f.repo}/src/x.env`, "tracked env")
        yield* git(f.repo, ["add", "src"])
        yield* git(f.repo, ["commit", "-qm", "src"])
        for (const [name, to] of [
          ["alias-file", "src/app.txt"],
          ["alias-dir", "src"],
          ["git-alias", ".git"],
          ["via", "src"],
        ] as const) {
          yield* symlink(`${f.repo}/${to}`, `${f.repo}/${name}`)
        }
        yield* write(`${f.repo}/.git/info/exclude`, "alias-file\nalias-dir\ngit-alias\nvia\n")
        const { t, wt } = yield* newTask(f, "Do it")
        for (const name of ["alias-file", "alias-dir", "git-alias", "via"]) assert.isFalse(yield* there(`${wt}/${name}`), name)
        const detail = ((yield* notices(t.id)).find((e) => e.detail.includes("left out"))?.detail ?? "").split("\n")
        for (const line of [
          "left out: alias-file: a symbolic link",
          "left out: alias-dir: a symbolic link",
          "left out: git-alias: a symbolic link",
          "left out: via/inner: via is a symbolic link",
        ]) {
          assert.include(detail, line)
        }
        assert.strictEqual(yield* read(`${f.repo}/src/app.txt`), "tracked app")
      }),
    ),
  )

  it.live("a .worktreeinclude that is a symlink isn't read", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture("", "")
        yield* write(`${f.outside}/private`, "CANARY-SECRET\n")
        yield* sh("rm", [`${f.repo}/${INCLUDE_FILE}`])
        yield* symlink(`${f.outside}/private`, `${f.repo}/${INCLUDE_FILE}`)
        const { t, wt } = yield* newTask(f, "Do it")
        const evs = (yield* notices(t.id)).map((e) => `${e.text}\n${e.detail}`).join("\n")
        assert.notInclude(evs, "CANARY")
        assert.include(evs, "left out: .worktreeinclude: a symbolic link, not read")
        // Nor is it copied from the folder it leads to.
        assert.isFalse(yield* exists(`${wt}/config/dev.local.json`))
      }),
    ),
  )
})
