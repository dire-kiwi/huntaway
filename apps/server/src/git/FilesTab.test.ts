import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import type { Scope } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { SqlClient } from "effect/sql"
import { git, tempDir, TestBoard } from "@huntaway/testing"
import type { TaskId } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import type { DataDir } from "../platform/DataDir.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { FilesTab, MAX_FILE, orderHits, parseGrep } from "./FilesTab.ts"
import type { Git } from "./Git.ts"
import { Worktrees } from "./Worktrees.ts"

// HE-79: the Code tab's reads, on the whole board's services with real repositories in temp folders and git with none
// of the machine's configuration.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

type Env = FilesTab | Worktrees | Tasks | Projects | Profiles | Git | DataDir | SqlClient.SqlClient
const run = <A, E>(effect: Effect.Effect<A, E, Env | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

const write = (path: string, text: string | Uint8Array) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    if (typeof text === "string") yield* fs.writeFileString(path, text)
    else yield* fs.writeFile(path, text)
  }).pipe(Effect.orDie)
const remove = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(path)).pipe(Effect.orDie)
const symlink = (target: string, path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.symlink(target, path)).pipe(Effect.orDie)

/** Why a call failed: `ChangesInvalid`'s field and reason. */
const fails = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (e) => ("field" in e && "reason" in e ? `${String(e.field)}: ${String(e.reason)}` : e._tag))

const newRepo = (dir: string) =>
  Effect.gen(function* () {
    yield* git(dir, ["init", "-q", "-b", "master"])
    yield* git(dir, ["config", "user.name", "t"])
    yield* git(dir, ["config", "user.email", "t@t"])
  })

const taskIn = (repo: string, more: { readonly use_worktrees?: boolean } = {}) =>
  Effect.gen(function* () {
    const profile = yield* (yield* Profiles).create({ name: "p" })
    const project = yield* (yield* Projects).create({ profile_id: profile.id, name: "x", key: "X", repo_path: repo, base_branch: "master", ...more })
    return (yield* (yield* Tasks).create({ project_id: project.id, title: "Do it" }, Actor.user)).id
  }).pipe(Effect.orDie)

const SOURCE = ["import { helper } from './util'", "", "export function parse(text: string) {", "  return helper(text)", "}", ""].join("\n")
const UTIL = ["export const helper = (s: string) => s.trim()", "// helper is used by parse", ""].join("\n")

/** A task with a worktree of a repository with `src/parse.ts`, `src/util.ts`, an ignored `dist/` and `README.md`. */
const taskRepo = Effect.gen(function* () {
  const repo = `${yield* tempDir}/repo`
  yield* write(`${repo}/src/parse.ts`, SOURCE)
  yield* write(`${repo}/src/util.ts`, UTIL)
  yield* write(`${repo}/README.md`, "# x\n")
  yield* write(`${repo}/.gitignore`, "dist/\n")
  yield* newRepo(repo)
  yield* git(repo, ["add", "."])
  yield* git(repo, ["commit", "-qm", "init"])
  const id = yield* taskIn(repo)
  const task = yield* (yield* Worktrees).setup(id).pipe(Effect.orDie)
  return { id, wt: task.worktree_path ?? "" }
})

const files = (id: TaskId) => Effect.flatMap(FilesTab, (c) => c.files(id)).pipe(Effect.orDie)

describe("FilesTab", () => {
  it("reads git grep's lines, cutting long ones around the name", () => {
    const long = `${"x".repeat(1000)} parse(${"y".repeat(1000)}`
    const hits = parseGrep(`a.ts\x003\x00export function parse() {\nb c.ts\x0010\x00  parse()\nmin.js\x001\x00${long}\nbroken\n`, "parse")
    assert.deepStrictEqual(
      hits.map((h) => [h.path, h.line, h.column, h.definition]),
      [
        ["a.ts", 3, 16, true],
        ["b c.ts", 10, 2, false],
        ["min.js", 1, 100, false],
      ],
    )
    assert.strictEqual(hits[2]?.text.slice(100, 105), "parse")
    assert.strictEqual(hits[2]?.text.length, 400)
    // Definitions first, the file it was looked up from first in each.
    const order = orderHits(
      [
        { path: "b", line: 1, column: 0, text: "", definition: false },
        { path: "a", line: 1, column: 0, text: "", definition: true },
        { path: "c", line: 2, column: 0, text: "", definition: false },
        { path: "c", line: 1, column: 0, text: "", definition: true },
      ],
      "c",
    )
    assert.deepStrictEqual(
      order.map((h) => `${h.path}${h.line}`),
      ["c1", "a1", "c2", "b1"],
    )
  })

  it.live("lists the working tree's files, untracked ones but not ignored or deleted ones", () =>
    run(
      Effect.gen(function* () {
        const { id, wt } = yield* taskRepo
        yield* write(`${wt}/src/new.ts`, "export const x = 1\n")
        yield* write(`${wt}/dist/out.js`, "built\n")
        yield* remove(`${wt}/README.md`)
        const tree = yield* files(id)
        assert.deepStrictEqual(tree, { available: true, folder: null, files: [".gitignore", "src/new.ts", "src/parse.ts", "src/util.ts"], truncated: false })
      }),
    ),
  )

  it.live("lists what git ignores when asked, an ignored folder's contents once it's opened", () =>
    run(
      Effect.gen(function* () {
        const { id, wt } = yield* taskRepo
        const c = yield* FilesTab
        yield* write(`${wt}/.gitignore`, "dist/\n.env\nout\n")
        yield* write(`${wt}/.env`, "SECRET=1\n")
        yield* write(`${wt}/dist/out.js`, "built\n")
        yield* write(`${wt}/dist/sub/deep.js`, "deep\n")
        yield* write(`${wt}/dist/.git/config`, "not shown\n")
        const outside = yield* tempDir
        yield* write(`${outside}/secret.txt`, "secret\n")
        yield* symlink(outside, `${wt}/out`)
        const ignored = (open: ReadonlyArray<string>) => c.files(id, { ignored: true, open }).pipe(Effect.orDie)
        const closed = yield* ignored([])
        assert.deepStrictEqual(closed.files, [".gitignore", "README.md", "src/parse.ts", "src/util.ts"])
        assert.deepStrictEqual(closed.ignored, [".env", "dist/", "out"])
        // Open: its files and folders, one level; a folder git doesn't ignore, or a link out, adds nothing.
        assert.deepStrictEqual((yield* ignored(["dist", "src", "out", "../x"])).ignored, [".env", "dist/", "dist/out.js", "dist/sub/", "out"])
        assert.deepStrictEqual((yield* ignored(["dist", "dist/sub"])).ignored, [".env", "dist/", "dist/out.js", "dist/sub/", "dist/sub/deep.js", "out"])
        // Not asked: as before.
        assert.isUndefined((yield* files(id)).ignored)
      }),
    ),
  )

  it.live("reads a file, but nothing outside the working tree, in .git or through a link out", () =>
    run(
      Effect.gen(function* () {
        const { id, wt } = yield* taskRepo
        const c = yield* FilesTab
        assert.deepStrictEqual(yield* c.read(id, "src/util.ts").pipe(Effect.orDie), { path: "src/util.ts", size: UTIL.length, text: UTIL })
        // Binary, too large, not UTF-8.
        yield* write(`${wt}/bin.dat`, new Uint8Array([1, 2, 0, 3]))
        assert.deepStrictEqual(yield* c.read(id, "bin.dat").pipe(Effect.orDie), { path: "bin.dat", size: 4, binary: true })
        yield* write(`${wt}/big.txt`, "x".repeat(MAX_FILE + 1))
        assert.deepStrictEqual(yield* c.read(id, "big.txt").pipe(Effect.orDie), { path: "big.txt", size: MAX_FILE + 1, too_large: true })
        yield* write(`${wt}/latin1.txt`, new Uint8Array([0x63, 0x61, 0x66, 0xe9]))
        const latin = yield* c.read(id, "latin1.txt").pipe(Effect.orDie)
        assert.deepStrictEqual([latin.text, latin.not_utf8], ["caf�", true])
        // A link in the repository is followed; one out of it isn't.
        const outside = `${yield* tempDir}/secret.txt`
        yield* write(outside, "secret\n")
        yield* symlink(outside, `${wt}/out.txt`)
        yield* symlink("src/util.ts", `${wt}/in.ts`)
        assert.strictEqual((yield* c.read(id, "in.ts").pipe(Effect.orDie)).text, UTIL)
        assert.strictEqual(yield* fails(c.read(id, "out.txt")), "path: out.txt is a link out of the repository")
        // Nor through a link into the repository's own .git (its config may hold a remote's token).
        yield* git(wt, ["config", "remote.origin.url", "https://token@example.com/x.git"])
        const gitDir = (yield* git(wt, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
        yield* symlink(`${gitDir}/config`, `${wt}/cfg`)
        assert.match(yield* fails(c.read(id, "cfg")), /^path: cfg is a link out of the /)
        for (const bad of ["../x", "/etc/passwd", "", ".git/config", "src/.git/x", ".GIT/config", "src/.Git/x"])
          assert.match(yield* fails(c.read(id, bad)), /^path: not a /, bad)
        assert.strictEqual(yield* fails(c.read(id, "src")), "path: src isn't a file")
        assert.strictEqual(yield* fails(c.read(id, "nope.ts")), "path: no such file: nope.ts")
      }),
    ),
  )

  it.live("finds where a symbol is defined and used, untracked files too", () =>
    run(
      Effect.gen(function* () {
        const { id, wt } = yield* taskRepo
        const c = yield* FilesTab
        yield* write(`${wt}/src/more.ts`, "helper('x')\nconst helpers = 1\n")
        const found = yield* c.symbol(id, "helper", "src/parse.ts").pipe(Effect.orDie)
        assert.deepStrictEqual(
          found.hits.map((h) => [h.path, h.line, h.column, h.definition]),
          [
            ["src/util.ts", 1, 13, true],
            ["src/parse.ts", 1, 9, false],
            ["src/parse.ts", 4, 9, false],
            ["src/more.ts", 1, 0, false],
            ["src/util.ts", 2, 3, false],
          ],
        )
        assert.isFalse(found.truncated)
        assert.deepStrictEqual((yield* c.symbol(id, "nowhere", undefined).pipe(Effect.orDie)).hits, [])
        // Not as the user's settings would have it: `submodule.recurse` refuses `--untracked`, `grep.column` adds a field.
        yield* git(wt, ["config", "submodule.recurse", "true"])
        yield* git(wt, ["config", "grep.column", "true"])
        const configured = yield* c.symbol(id, "helper", "src/parse.ts").pipe(Effect.orDie)
        assert.deepStrictEqual(configured, found)
        yield* git(wt, ["config", "--unset", "submodule.recurse"])
        yield* git(wt, ["config", "--unset", "grep.column"])
        for (const bad of ["-e", "a b", "1x", "x".repeat(201)]) assert.match(yield* fails(c.symbol(id, bad, undefined)), /^name: not a symbol's name/, bad)
        // A keyword in some language is a name in another (`Option.match`, a field `type`): looked up all the same.
        yield* write(`${wt}/src/opt.ts`, "export const match = 1\nOption.match(x)\n")
        assert.deepStrictEqual(
          (yield* c.symbol(id, "match", undefined).pipe(Effect.orDie)).hits.map((h) => [h.line, h.definition]),
          [
            [1, true],
            [2, false],
          ],
        )
      }),
    ),
  )

  it.live("in a folder inside a bigger repository, only the folder's files", () =>
    run(
      Effect.gen(function* () {
        const home = `${yield* tempDir}/home`
        yield* write(`${home}/.bashrc`, "helper=1\n")
        yield* write(`${home}/proj/a.sh`, "helper() { :; }\n")
        yield* newRepo(home)
        yield* git(home, ["add", "."])
        yield* git(home, ["commit", "-qm", "dotfiles"])
        const id = yield* taskIn(`${home}/proj`, { use_worktrees: false })
        const c = yield* FilesTab
        assert.deepStrictEqual(yield* files(id), { available: true, folder: "proj/", files: ["proj/a.sh"], truncated: false })
        assert.strictEqual((yield* c.read(id, "proj/a.sh").pipe(Effect.orDie)).text, "helper() { :; }\n")
        assert.strictEqual(yield* fails(c.read(id, ".bashrc")), "path: .bashrc isn't in the project's folder (proj/)")
        // Nor through a link: out of the folder, or into .git.
        yield* symlink("../.bashrc", `${home}/proj/rc`)
        yield* symlink("../.git", `${home}/proj/g`)
        assert.strictEqual(yield* fails(c.read(id, "proj/rc")), "path: proj/rc is a link out of the project's files")
        assert.strictEqual(yield* fails(c.read(id, "proj/g/config")), "path: proj/g/config is a link out of the project's files")
        assert.deepStrictEqual(
          (yield* c.symbol(id, "helper", undefined).pipe(Effect.orDie)).hits.map((h) => h.path),
          ["proj/a.sh"],
        )
      }),
    ),
  )

  it.live("leaves out a submodule and an untracked repository of its own, which aren't files", () =>
    run(
      Effect.gen(function* () {
        const { id, wt } = yield* taskRepo
        const lib = `${yield* tempDir}/lib`
        yield* write(`${lib}/lib.ts`, "export const x = 1\n")
        yield* newRepo(lib)
        yield* git(lib, ["add", "."])
        yield* git(lib, ["commit", "-qm", "lib"])
        yield* git(wt, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib"])
        const nested = `${wt}/nested`
        yield* write(`${nested}/n.ts`, "n\n")
        yield* newRepo(nested)
        const tree = yield* files(id)
        assert.deepStrictEqual(tree.files, [".gitignore", ".gitmodules", "README.md", "src/parse.ts", "src/util.ts"])
      }),
    ),
  )

  it.live("a folder that isn't a repository", () =>
    run(
      Effect.gen(function* () {
        const dir = `${yield* tempDir}/plain`
        yield* write(`${dir}/a.txt`, "a\n")
        const id = yield* taskIn(dir, { use_worktrees: false })
        assert.deepStrictEqual(yield* files(id), { available: false, reason: "not a git repository", files: [], truncated: false })
        assert.strictEqual(yield* fails(Effect.flatMap(FilesTab, (c) => c.read(id, "a.txt"))), "repository: not a git repository")
      }),
    ),
  )
})
