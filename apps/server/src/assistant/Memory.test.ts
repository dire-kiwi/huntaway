import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Layer, Result, Schema } from "effect"
import { TaskId } from "@huntaway/contracts"
import { TestPlatform } from "@huntaway/testing"
import { MEMORY_CAP, MEMORY_FILE, USER_FILE } from "../prompts/memory.ts"
import { MAX_COMMITTED, MAX_LISTED } from "./memory/text.ts"
import { gitDir, makeWorkspace } from "./memory/workspace.ts"
import { Proc } from "../platform/Proc.ts"
import { Memory } from "./Memory.ts"

/** JSON text, through a schema (the global `JSON` throws). */
const encodeJson = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))
const json = (v: unknown): string => Result.getOrElse(encodeJson(v), () => "")

// The assistant's memory on disk (the old agent/assistant/memory/tests.test.ts): the workspace's files, its history in
// a repository beside it, and the API's reads and writes, with real git in temp folders. The cases that need the
// assistant's task (its runs told their memory, its turns committed, a workspace that's a symlink, the API per profile,
// an import) are in Assistant.test.ts; the pure ones (cap, paths, the list's order, git's output) in memory/text.test.ts.
//
// Dropped, with why: the move of a workspace's own `.git` from before HA-160 (`the_move_keeps_only_the_history…`,
// `an_old_git_folder_that_points_elsewhere…`, `a_broken_old_history…`, `a_commit_that_fails_after_the_move…`, and the
// move's half of `the_board_runs_no_git_config…` and `a_repository_in_the_workspace…`): the old server moved every
// workspace it opened, and this one doesn't (docs/plan/14-dropped-and-open.md). `the_boards_git_leaves_no_maintenance…`
// is kept as the `-c` options' check in workspace.ts (`maintenance.autoDetach=false`), as reading GIT_TRACE would need
// the server's own environment changed.

const memoryLayer = Memory.layer.pipe(Layer.provideMerge(TestPlatform()))

/** A new folder for a workspace, with its git folder to be next to it. */
const ws = (name = "ws") => {
  const dir = `${mkdtempSync(`${tmpdir()}/huntaway-memory-`)}/${name}`
  mkdirSync(dir, { recursive: true })
  return dir
}

const write = (path: string, text: string) => {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true })
  writeFileSync(path, text)
}
const read = (p: string) => readFileSync(p, "utf8")

/** Plain git with no one's config: the board's repository beside `dir` (or, without it, as the assistant would run it). */
const plainGit = (dir: string, args: ReadonlyArray<string>, own = true) =>
  execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=x",
      "-c",
      "user.email=x@y",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "maintenance.autoDetach=false",
      "-c",
      "gc.autoDetach=false",
      ...args,
    ],
    {
      env: {
        PATH: process.env["PATH"] ?? "",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        ...(own ? { GIT_DIR: gitDir(dir), GIT_WORK_TREE: dir } : {}),
      },
      encoding: "utf8",
      stdio: "pipe",
    },
  )

/** The workspace's commits, newest first: author and message. */
const log = (dir: string) =>
  plainGit(dir, ["log", "--format=%an%x1f%s"])
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split("\x1f"))

const committed = (dir: string) =>
  plainGit(dir, ["ls-files"])
    .split("\n")
    .filter((l) => l !== "")

const workspace = Effect.gen(function* () {
  return makeWorkspace({ fs: yield* FileSystem.FileSystem, proc: yield* Proc })
})

/** A file of the user's committed as theirs, alone (the workspace's lock is the Memory API's to take). */
const commitFile = (dir: string, rel: string, message: string) => Effect.flatMap(workspace, (w) => w.commitFileLocked(dir, "User", rel, message))

/** A folder that stays empty unless the script runs, and the command that runs it (it notes what ran by its first argument). */
const evilScript = () => {
  const ran = mkdtempSync(`${tmpdir()}/huntaway-ran-`)
  const script = `${mkdtempSync(`${tmpdir()}/huntaway-evil-`)}/evil`
  writeFileSync(script, `#!/bin/sh\ntouch '${ran}'/"$1"\ncat "\${2:-/dev/stdin}"\n`, { mode: 0o755 })
  return { ran, evil: (what: string) => `${script} ${what}` }
}

layer(memoryLayer)("Memory", (it) => {
  it.effect("seeding leaves what is there", () =>
    Effect.gen(function* () {
      const memory = yield* Memory
      const dir = ws()
      yield* memory.ensure(dir)
      assert.isTrue(read(`${dir}/${USER_FILE}`).startsWith("# About the user"))
      assert.isTrue(read(`${dir}/${MEMORY_FILE}`).startsWith("# Memory"))
      assert.isTrue(lstatSync(`${dir}/memory`).isDirectory())
      writeFileSync(`${dir}/${USER_FILE}`, "mine")
      unlinkSync(`${dir}/${MEMORY_FILE}`)
      yield* memory.ensure(dir)
      assert.strictEqual(read(`${dir}/${USER_FILE}`), "mine")
      assert.isTrue(existsSync(`${dir}/${MEMORY_FILE}`))
      // A dangling symlink isn't written through.
      const target = `${ws("t")}/made`
      unlinkSync(`${dir}/${MEMORY_FILE}`)
      symlinkSync(target, `${dir}/${MEMORY_FILE}`)
      yield* memory.ensure(dir)
      assert.isFalse(existsSync(target))
      // A seeded .gitignore the user changed stays.
      writeFileSync(`${dir}/.gitignore`, "mine\n")
      yield* memory.ensure(dir)
      assert.strictEqual(read(`${dir}/.gitignore`), "mine\n")
    }),
  )

  it.effect("the workspace is committed only when it changed", () =>
    Effect.gen(function* () {
      const memory = yield* Memory
      const dir = ws()
      yield* memory.ensure(dir)
      assert.isTrue(lstatSync(gitDir(dir)).isDirectory() && !existsSync(`${dir}/.git`))
      assert.strictEqual(gitDir(dir), `${dir}.git`)
      assert.deepStrictEqual(log(dir), [["Assistant", "Start the assistant's memory"]])
      yield* memory.ensure(dir)
      assert.isNull(yield* memory.commitAll(dir))
      write(`${dir}/${MEMORY_FILE}`, "# Memory\n- a fact\n")
      write(`${dir}/memory/2026-11-04.md`, "- a log\n")
      assert.strictEqual((yield* memory.commitAll(dir))?.length, 40)
      assert.deepStrictEqual(log(dir)[0], ["Assistant", "Update MEMORY.md, memory/2026-11-04.md"])
      assert.isNull(yield* memory.commitAll(dir))
      // A removed file is a change too.
      unlinkSync(`${dir}/memory/2026-11-04.md`)
      assert.isNotNull(yield* memory.commitAll(dir))
      // One file of the user's is committed alone, leaving the rest for the assistant's next commit.
      write(`${dir}/${USER_FILE}`, "user's edit")
      write(`${dir}/notes.md`, "assistant's note")
      assert.isNotNull(yield* commitFile(dir, USER_FILE, "Edit USER.md"))
      assert.isNull(yield* commitFile(dir, USER_FILE, "Edit USER.md"))
      assert.deepStrictEqual(log(dir)[0], ["You", "Edit USER.md"])
      assert.strictEqual(log(dir).length, 4)
      assert.isNotNull(yield* memory.commitAll(dir))
      assert.strictEqual(log(dir)[0]?.[1], "Update notes.md")
    }),
  )

  it.effect("a workspace in another repository gets its own", () =>
    Effect.gen(function* () {
      const memory = yield* Memory
      // A data folder inside a repository (a checkout, say) doesn't have the workspace committed there.
      const outer = ws("outer")
      plainGit(outer, ["init", "-q"], false)
      const dir = `${outer}/assistants/t1`
      mkdirSync(dir, { recursive: true })
      // Without a history of its own, nothing is committed (not even to the repository around it).
      assert.isNull(yield* memory.commitAll(dir))
      yield* memory.ensure(dir)
      assert.strictEqual(log(dir).length, 1)
      assert.throws(() => plainGit(outer, ["rev-parse", "HEAD"], false))
    }),
  )

  it.effect("what .gitignore lists and big files aren't committed", () =>
    Effect.gen(function* () {
      const memory = yield* Memory
      const dir = ws()
      yield* memory.ensure(dir)
      assert.deepStrictEqual(committed(dir), [".gitignore", "MEMORY.md", "USER.md"])
      write(`${dir}/.env`, "TOKEN=secret")
      write(`${dir}/downloads/report.pdf`, "pdf")
      write(`${dir}/node_modules/x/index.js`, "js")
      write(`${dir}/big.bin`, "x".repeat(MAX_COMMITTED + 1))
      write(`${dir}/notes.md`, "notes")
      // The brief's files are the assistant's documents, not memory.
      write(`${dir}/brief.html`, "<p>brief</p>")
      write(`${dir}/brief.json`, "[]")
      assert.isNotNull(yield* memory.commitAll(dir))
      assert.deepStrictEqual(committed(dir), [".gitignore", "MEMORY.md", "USER.md", "notes.md"])
      // A name that isn't UTF-8 doesn't stop the rest being committed.
      writeFileSync(Buffer.concat([Buffer.from(`${dir}/bad`), Buffer.from([0xff]), Buffer.from(".md")]), "x")
      write(`${dir}/notes2.md`, "notes")
      assert.isNotNull(yield* memory.commitAll(dir))
      assert.include(committed(dir), "notes2.md")
      // Only big files: nothing to commit (not everything).
      write(`${dir}/big2.bin`, "x".repeat(MAX_COMMITTED + 1))
      assert.isNull(yield* memory.commitAll(dir))
      // A file that grew too big keeps its last version, and one removed is removed.
      write(`${dir}/notes.md`, "y".repeat(MAX_COMMITTED + 1))
      unlinkSync(`${dir}/${MEMORY_FILE}`)
      assert.isNotNull(yield* memory.commitAll(dir))
      assert.deepStrictEqual(committed(dir), [".gitignore", "USER.md", "notes.md", "notes2.md"])
      assert.strictEqual(plainGit(dir, ["show", "HEAD:notes.md"]), "notes")
      // The Memory tab's write of an ignored file writes it, with no commit.
      assert.isNull(yield* commitFile(dir, ".env", "Edit .env"))
    }),
  )

  it.effect("git stays in the workspace's own repository", () =>
    Effect.gen(function* () {
      const memory = yield* Memory
      // A symlink to another repository in place of its git folder: no history, and nothing committed there.
      const other = ws("other")
      yield* memory.ensure(other)
      let dir = ws()
      symlinkSync(gitDir(other), gitDir(dir))
      assert.strictEqual((yield* Effect.flip(memory.ensure(dir)))._tag, "Unavailable")
      assert.isNull(yield* memory.commitAll(dir))
      assert.strictEqual(log(other).length, 1)
      // A `.git` in the workspace that leads there isn't used either: the workspace gets its own.
      unlinkSync(gitDir(dir))
      symlinkSync(gitDir(other), `${dir}/.git`)
      yield* memory.ensure(dir)
      assert.strictEqual(log(dir).length, 1)
      assert.strictEqual(log(other).length, 1)

      // Its config can't point git at another work tree.
      dir = ws("ws2")
      yield* memory.ensure(dir)
      writeFileSync(`${other}/theirs.md`, "THEIRS")
      plainGit(dir, ["config", "core.worktree", other])
      write(`${dir}/mine.md`, "mine")
      yield* memory.commitAll(dir)
      assert.strictEqual(log(dir)[0]?.[1], "Update mine.md")
      assert.throws(() => plainGit(dir, ["show", "HEAD:theirs.md"]))

      // A path is a name, not a pattern: `*.md` commits the file called that, not every .md.
      write(`${dir}/*.md`, "star")
      write(`${dir}/${USER_FILE}`, "changed")
      assert.isNotNull(yield* commitFile(dir, "*.md", "Edit *.md"))
      assert.strictEqual(plainGit(dir, ["show", "--name-only", "--format=", "HEAD"]).trim(), "*.md")
    }),
  )

  it.effect("the board runs no git config the assistant can write", () =>
    Effect.gen(function* () {
      const memory = yield* Memory
      const dir = ws()
      yield* memory.ensure(dir)
      const { ran, evil } = evilScript()
      // A filter, a textconv and an fsmonitor in a `.git/config` the assistant wrote in its workspace aren't git's.
      write(
        `${dir}/.git/config`,
        `[filter "evil"]\n\tclean = ${evil("clean")}\n[diff "evil"]\n\ttextconv = ${evil("textconv")}\n[core]\n\tfsmonitor = ${evil("fsmonitor")}\n`,
      )
      write(`${dir}/.gitattributes`, "* filter=evil diff=evil\n")
      write(`${dir}/${MEMORY_FILE}`, "- a fact\n")
      const sha = (yield* memory.commitAll(dir)) ?? assert.fail("nothing committed")
      // Nor do the Memory tab's reads run anything.
      assert.strictEqual((yield* memory.read(dir, MEMORY_FILE, sha)).content, "- a fact\n")
      assert.include((yield* memory.diff(dir, sha, null)).diff, "+- a fact")
      yield* memory.history(dir, MEMORY_FILE)
      assert.deepStrictEqual(readdirSync(ran), [])
    }),
  )

  it.effect("a repository in the workspace never runs its config as the board", () =>
    Effect.gen(function* () {
      const memory = yield* Memory
      // An approved `git clone` in the workspace isn't committed as a gitlink, nor are its files.
      const dir = ws()
      yield* memory.ensure(dir)
      const { ran, evil } = evilScript()
      const clone = `${dir}/clone`
      mkdirSync(clone)
      plainGit(clone, ["init", "-q"], false)
      writeFileSync(`${clone}/a.txt`, "a\n")
      plainGit(clone, ["add", "-A"], false)
      plainGit(clone, ["commit", "-q", "-m", "c1"], false)
      write(`${dir}/notes.md`, "notes")
      assert.isNotNull(yield* memory.commitAll(dir))
      assert.strictEqual(log(dir)[0]?.[1], "Update notes.md")
      const gitlinks = () =>
        [...plainGit(dir, ["ls-files", "-s"]).split("\n"), ...plainGit(dir, ["ls-tree", "-r", "HEAD"]).split("\n")].filter((l) => l.startsWith("160000"))
      assert.deepStrictEqual(gitlinks(), [])
      // A filter in its config, for all its files, one of them rewritten, and its HEAD moved.
      writeFileSync(`${clone}/.git/config`, `${read(`${clone}/.git/config`)}[filter "evil"]\n\tclean = ${evil("clean")}\n`)
      writeFileSync(`${clone}/.gitattributes`, "* filter=evil\n")
      writeFileSync(`${clone}/a.txt`, "b\n")
      writeFileSync(`${clone}/.git/HEAD`, `${"1".padStart(40, "0")}\n`)
      write(`${dir}/${MEMORY_FILE}`, "- a fact\n")
      assert.isNotNull(yield* memory.commitAll(dir))
      assert.isNull(yield* commitFile(dir, "clone/a.txt", "Edit clone/a.txt"))
      assert.deepStrictEqual(readdirSync(ran), [], "the filter ran")
      assert.deepStrictEqual(gitlinks(), [])
    }),
  )

  it.effect("the memory API reads, writes and restores files", () =>
    Effect.gen(function* () {
      const memory = yield* Memory
      const dir = ws()
      yield* memory.ensure(dir)
      const seeded = (yield* memory.read(dir, USER_FILE, null)).content
      assert.isTrue(seeded.startsWith("# About the user"))
      // A save from an editor that opened what's there.
      const w = yield* memory.write(dir, USER_FILE, "# Me\n- Ivan\n", seeded, false)
      assert.isString(w.commit)
      assert.strictEqual(read(`${dir}/${USER_FILE}`), "# Me\n- Ivan\n")
      // One from an editor that opened an older version is refused, unless forced.
      const stale = yield* Effect.flip(memory.write(dir, USER_FILE, "stale", seeded, false))
      assert.deepStrictEqual([stale._tag, stale._tag === "Conflict" ? stale.reason : null], ["Conflict", "changed_meanwhile"])
      // A new file: expected is none. Its folders are made.
      const today = "memory/2026-11-04.md"
      yield* memory.write(dir, today, "- a log\n", null, false)
      assert.strictEqual((yield* Effect.flip(memory.write(dir, today, "x", null, false)))._tag, "Conflict")
      // The same content again makes no commit.
      assert.isNull((yield* memory.write(dir, today, "- a log\n", null, true)).commit)

      const commits = yield* memory.history(dir, USER_FILE)
      assert.strictEqual(commits.length, 2)
      assert.deepStrictEqual([commits[0]?.author, commits[0]?.message, commits[0]?.files], ["You", "Edit USER.md", ["USER.md"]])
      assert.strictEqual(commits[1]?.author, "Assistant")
      const all = yield* memory.history(dir, null)
      assert.strictEqual(all.length, 3)
      assert.deepStrictEqual(all[2]?.files, [".gitignore", "MEMORY.md", "USER.md"])
      const first = commits[1]?.sha ?? ""
      const latest = commits[0]?.sha ?? ""
      assert.include((yield* memory.diff(dir, latest, USER_FILE)).diff, "+- Ivan")
      assert.strictEqual((yield* memory.read(dir, USER_FILE, first)).content, seeded)
      // Restoring the first version.
      yield* memory.restore(dir, USER_FILE, first)
      assert.strictEqual(read(`${dir}/${USER_FILE}`), seeded)
      assert.isTrue((yield* memory.history(dir, USER_FILE))[0]?.message.startsWith("Restore USER.md as it was in "))
      // A commit that isn't one, or an option in its place.
      for (const rev of ["--output=/tmp/x", "HEAD", "HEAD~1", "abc", "0000000000"]) {
        const e = yield* Effect.flip(memory.diff(dir, rev, null))
        assert.isTrue(e._tag === "Invalid" || e._tag === "NotFound", `${rev}: ${e._tag}`)
      }
      assert.strictEqual((yield* Effect.flip(memory.restore(dir, "nope.md", first)))._tag, "NotFound")
      // The overview: the memory files first, today's log counted in characters.
      const o = yield* memory.overview(TaskId.make("t"), dir)
      assert.deepStrictEqual(
        o.files.map((f) => f.path),
        ["USER.md", "MEMORY.md", today, ".gitignore"],
      )
      assert.strictEqual(o.cap, MEMORY_CAP)
      assert.isTrue(o.history)
    }),
  )

  it.effect("paths out of the workspace are refused", () =>
    Effect.gen(function* () {
      const memory = yield* Memory
      const dir = ws()
      yield* memory.ensure(dir)
      const outside = ws("outside")
      writeFileSync(`${outside}/secret`, "SECRET")
      symlinkSync(`${outside}/secret`, `${dir}/link.md`)
      symlinkSync(outside, `${dir}/out`)
      assert.strictEqual((yield* memory.read(dir, "./MEMORY.md", null)).path, "./MEMORY.md")
      for (const bad of ["", "../x", "/etc/passwd", "memory/../../x", ".git/config", ".git", "link.md", "out/secret", "out/new.md", "a\\..\\b", "a\0b"]) {
        assert.strictEqual((yield* Effect.flip(memory.read(dir, bad, null)))._tag, "Invalid", json(bad))
        assert.strictEqual((yield* Effect.flip(memory.write(dir, bad, "x", null, true)))._tag, "Invalid", json(bad))
      }
      assert.strictEqual(read(`${outside}/secret`), "SECRET")
      assert.isFalse(existsSync(`${outside}/new.md`))
    }),
  )

  it.effect("the list keeps the memory files and latest logs first", () =>
    Effect.gen(function* () {
      const memory = yield* Memory
      const dir = ws()
      yield* memory.ensure(dir)
      for (let i = 0; i < MAX_LISTED + 20; i++) write(`${dir}/aaa/${String(i).padStart(4, "0")}.md`, "x")
      write(`${dir}/memory/2026-11-04.md`, "today")
      write(`${dir}/memory/2026-11-03.md`, "yesterday")
      const w = yield* workspace
      const files = yield* w.list(dir, "2026-11-04")
      const p = files.map((f) => f.path)
      assert.strictEqual(p.length, MAX_LISTED)
      assert.deepStrictEqual(p.slice(0, 4), ["USER.md", "MEMORY.md", "memory/2026-11-04.md", "memory/2026-11-03.md"])
      assert.deepStrictEqual(p.slice(4, 6), [".gitignore", "aaa/0000.md"])
      // Only the files a run is told are read for their length.
      assert.strictEqual(files[2]?.chars, 5)
      assert.deepStrictEqual([files[5]?.chars, files[5]?.size], [null, 1])
    }),
  )

  it.effect("restore and overwrite keep an edit not committed yet; saves at once, one wins", () =>
    Effect.gen(function* () {
      const memory = yield* Memory
      const dir = ws()
      yield* memory.ensure(dir)
      const first = plainGit(dir, ["rev-parse", "HEAD"]).trim()
      const shas = Effect.map(memory.history(dir, MEMORY_FILE), (h) => h.map((c) => [c.sha, c.author] as const))
      // The assistant writes MEMORY.md, and its turn hasn't ended (so it isn't committed) when the user restores it.
      write(`${dir}/${MEMORY_FILE}`, "- the assistant's edit\n")
      yield* memory.restore(dir, MEMORY_FILE, first)
      let h = yield* shas
      assert.deepStrictEqual(
        h.map((c) => c[1]),
        ["You", "Assistant", "Assistant"],
      )
      assert.strictEqual((yield* memory.read(dir, MEMORY_FILE, h[1]?.[0] ?? null)).content, "- the assistant's edit\n")
      // The same for a save that overwrites it.
      write(`${dir}/${MEMORY_FILE}`, "- another edit\n")
      yield* memory.write(dir, MEMORY_FILE, "mine", "stale", true)
      h = yield* shas
      assert.strictEqual(h.length, 5)
      assert.strictEqual((yield* memory.read(dir, MEMORY_FILE, h[1]?.[0] ?? null)).content, "- another edit\n")
      assert.strictEqual(read(`${dir}/${MEMORY_FILE}`), "mine")
      // Saves at once: one of them is written, the rest refused, rather than all checking and then all writing.
      const results = yield* Effect.forEach([0, 1, 2, 3], (i) => Effect.result(memory.write(dir, MEMORY_FILE, `save ${i}`, "mine", false)), {
        concurrency: 4,
      })
      assert.deepStrictEqual(results.map((r) => r._tag).toSorted(), ["Failure", "Failure", "Failure", "Success"])
    }),
  )

  it.effect("a save over a file left out of the history needs what was opened", () =>
    Effect.gen(function* () {
      const memory = yield* Memory
      const dir = ws()
      yield* memory.ensure(dir)
      // `.env` is in the seeded .gitignore, and the assistant wrote it after the user opened it.
      write(`${dir}/.env`, "TOKEN=the assistant's\n")
      for (const force of [false, true]) {
        const e = yield* Effect.flip(memory.write(dir, ".env", "TOKEN=mine\n", "TOKEN=old\n", force))
        assert.strictEqual(e._tag, "Conflict", `force ${force}`)
        if (force) assert.include(e._tag === "Conflict" ? e.detail : "", "history")
        assert.strictEqual(read(`${dir}/.env`), "TOKEN=the assistant's\n")
      }
      // Once it's what the user opened, it's written (with no commit, as the history leaves it out).
      assert.isNull((yield* memory.write(dir, ".env", "TOKEN=mine\n", "TOKEN=the assistant's\n", true)).commit)
      assert.strictEqual(read(`${dir}/.env`), "TOKEN=mine\n")
      // A file the history keeps is still overwritten when forced: what it said is committed first.
      write(`${dir}/notes.md`, "the assistant's notes\n")
      yield* memory.write(dir, "notes.md", "mine", "old", true)
      assert.strictEqual(plainGit(dir, ["show", "HEAD~1:notes.md"]), "the assistant's notes\n")
    }),
  )

  it.effect("a file that can't be read is refused, not committed", () =>
    Effect.gen(function* () {
      const memory = yield* Memory
      const dir = ws()
      yield* memory.ensure(dir)
      write(`${dir}/locked.md`, "secret\n")
      chmodSync(`${dir}/locked.md`, 0o000)
      // git can't add it: the commit fails, and says why.
      const e = yield* Effect.flip(memory.commitAll(dir))
      chmodSync(`${dir}/locked.md`, 0o644)
      assert.include(e.reason, "git add failed")
      assert.isNotNull(yield* memory.commitAll(dir))
    }),
  )
})
