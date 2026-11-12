import { Context, DateTime, Effect, FiberSet, FileSystem, Layer, Option, Result } from "effect"
import { Conflict, Invalid, NotFound, Unavailable } from "@huntaway/contracts"
import type { MemoryCommit, MemoryDiff, MemoryFileContent, MemoryOverview, MemoryWrite, Task, TaskId } from "@huntaway/contracts"
import { DataDir } from "../platform/DataDir.ts"
import { readImportRecord } from "../platform/ImportRecord.ts"
import type { ImportRecord } from "../platform/ImportRecord.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { Proc } from "../platform/Proc.ts"
import { memory as memoryPrompt, memoryNotLoaded, MEMORY_CAP, MEMORY_CAP_BYTES, MEMORY_FILE, USER_FILE } from "../prompts/memory.ts"
import { checkRev, dayIn, IMPORT_PROMPT, loaded, LOG_FORMAT, logName, MAX_FILE, memoryFile, parseLog, withWeekday } from "./memory/text.ts"
import { makeWorkspace } from "./memory/workspace.ts"

// The assistant's memory (docs/plan/06-server.md, Assistant; inventory 02, section 2.12; huntaway's
// agent/assistant/memory.ts and memory/*): files in its workspace (`assistants/<task id>` in the data folder) that the
// board loads into each run's instructions, so it works the same on Claude and Codex:
//
// - `USER.md`: who the user is and their preferences; `MEMORY.md`: lasting facts and decisions;
// - `memory/YYYY-MM-DD.md`: a log for each day, in the host's time zone.
//
// The workspace's history is a git repository beside it (`assistants/<task id>.git`), not in it, so the assistant can't
// set the config, hooks or filters the board's git runs with. The board commits after each of the assistant's turns that
// changed it (as the assistant) and when the user edits a file from the Memory tab (as the user). The workspace's
// folders are real ones, never symlinks (one could lead to another assistant's workspace), and its git work is under a
// lock per workspace (`KeyedLock` `["workspace", dir]`). A workspace from before the history moved out of it (HA-160) is
// the old server's to have moved: its `.git` isn't moved here (docs/plan/14-dropped-and-open.md).

/** What a file write is checked against: what the editor opened (null: that it wasn't there), or nothing (a restore). */
type Seen = { readonly _tag: "Opened"; readonly content: string | null } | { readonly _tag: "Any" }

/** A commit's id, checked. */
const rev = (r: string) => Effect.fromResult(Result.mapError(checkRev(r), (reason) => new Invalid({ field: "rev", reason })))

export interface MemoryShape {
  /** The assistant's workspace, made if it isn't there, once it's checked to be its own (real folders, no symlinks). */
  readonly checked: (assistant: Task) => Effect.Effect<string, Unavailable>
  /** The workspace seeded, with a repository and a first commit if it has none yet. */
  readonly ensure: (dir: string) => Effect.Effect<void, Unavailable>
  /** What the assistant `assistant` is told about its memory, its workspace made ready first (or why it isn't loaded). */
  readonly forRun: (assistant: Task) => Effect.Effect<string>
  /** One of the assistant's turns ended (or a run in its workspace did): what changed is committed, in the background. */
  readonly turnEnded: (assistant: Task) => Effect.Effect<void>
  /** Commit everything that changed (tests, and `turnEnded`'s work): the commit, if there was one. */
  readonly commitAll: (dir: string) => Effect.Effect<string | null, Unavailable>
  /** The workspace's files, and how much of each a run is told. */
  readonly overview: (task: TaskId, dir: string) => Effect.Effect<MemoryOverview, Unavailable>
  readonly read: (dir: string, rel: string, rev: string | null) => Effect.Effect<MemoryFileContent, NotFound | Invalid | Unavailable>
  readonly write: (
    dir: string,
    rel: string,
    content: string,
    expected: string | null,
    force: boolean,
  ) => Effect.Effect<MemoryWrite, NotFound | Invalid | Conflict | Unavailable>
  readonly history: (dir: string, rel: string | null) => Effect.Effect<ReadonlyArray<MemoryCommit>, Invalid | Unavailable>
  readonly diff: (dir: string, rev: string, rel: string | null) => Effect.Effect<MemoryDiff, NotFound | Invalid | Unavailable>
  readonly restore: (dir: string, rel: string, rev: string) => Effect.Effect<MemoryWrite, NotFound | Invalid | Conflict | Unavailable>
  /**
   * Changes file `rel` with `edit` (given what it says now, "" if it isn't there) and commits it as the user's, under the
   * workspace's lock from the read to the commit. What it says now is committed first, as the assistant's.
   */
  readonly change: (
    dir: string,
    rel: string,
    message: string,
    edit: (now: string) => string,
  ) => Effect.Effect<readonly [string, string | null], NotFound | Invalid | Unavailable>
  /** The host's date now (`YYYY-MM-DD`), in its time zone. */
  readonly today: Effect.Effect<string>
  /** Waits for the commits going on in the background (tests). */
  readonly idle: Effect.Effect<void>
}

export class Memory extends Context.Service<Memory, MemoryShape>()("huntaway-server/assistant/Memory") {
  static readonly layer = Layer.effect(
    Memory,
    Effect.gen(function* () {
      const dataDir = yield* DataDir
      const locks = yield* KeyedLock
      const ws = makeWorkspace({ fs: yield* FileSystem.FileSystem, proc: yield* Proc })
      const background = yield* FiberSet.make()
      // The host's zone; a test gives its own (`DateTime.CurrentTimeZone`).
      const zone = Option.getOrElse(yield* Effect.serviceOption(DateTime.CurrentTimeZone), DateTime.zoneMakeLocal)
      const today = Effect.map(DateTime.now, (now) => dayIn(now, zone))

      const locked = (dir: string) => locks.withLock(["workspace", dir])
      // An imported board's assistants keep their workspaces in the old folder, where their sessions ran (docs/plan/
      // 11-migration.md: worktrees and work folders stay where they are): the one other place a workspace may be. Not on
      // a rehearsal, which changes nothing outside its own folder: opening a workspace makes and seeds it, and the old
      // folder there is the live board's.
      const imported = yield* readImportRecord(dataDir.root).pipe(Effect.orElseSucceed(() => Option.none<ImportRecord>()))
      const importedFrom = Option.map(imported, (record) => record.from)
      const rehearsal = Option.isSome(imported) && imported.value.rehearsal

      const checked = Effect.fn("Memory.checked")(function* (assistant: Task) {
        if (assistant.kind !== "task" || assistant.task_type !== "assistant") {
          return yield* new Unavailable({ what: "assistant workspace", reason: `${assistant.id} isn't an assistant` })
        }
        const own = `assistants/${assistant.id}`
        const inOldFolder = Option.isSome(importedFrom) && assistant.work_dir === `${importedFrom.value}/${own}`
        if (inOldFolder && rehearsal) {
          return yield* new Unavailable({
            what: "assistant workspace",
            reason: "the assistant's workspace is in the old board's folder, which a rehearsal leaves alone",
          })
        }
        if (assistant.work_dir !== own && assistant.work_dir !== `${dataDir.root}/${own}` && !inOldFolder) {
          return yield* new Unavailable({
            what: "assistant workspace",
            reason: `the assistant's folder isn't its own workspace ("${assistant.work_dir ?? ""}")`,
          })
        }
        // The data folder itself may be a symlink; the folders under it may not.
        let dir = inOldFolder ? importedFrom.value : dataDir.root
        for (const part of ["assistants", assistant.id]) {
          dir = `${dir}/${part}`
          yield* ws.realDir(dir)
        }
        return dir
      })

      const ensure = Effect.fn("Memory.ensure")(function* (dir: string) {
        yield* ws
          .seed(dir)
          .pipe(Effect.mapError((e) => new Unavailable({ what: "assistant memory", reason: `making the memory files in ${dir}: ${e.message}` })))
        if (yield* ws.isRepo(dir)) return yield* Effect.void
        // A symlink or a file there would point git at another repository: left for the user to look at.
        if (Option.isSome(yield* ws.lstat(`${dir}.git`))) {
          return yield* new Unavailable({ what: "assistant memory", reason: `${dir}.git isn't a folder of its own, so the workspace has no history` })
        }
        return yield* Effect.gen(function* () {
          if (yield* ws.isRepo(dir)) return
          yield* ws.gitOk(dir, "Assistant", ["init", "-q"])
          yield* ws.commitAllLocked(dir, "Assistant", "Start the assistant's memory")
        }).pipe(locked(dir))
      })

      const forRun = Effect.fn("Memory.forRun")(function* (assistant: Task) {
        const dir = yield* Effect.result(checked(assistant))
        if (Result.isFailure(dir)) {
          yield* Effect.logWarning(`task=${assistant.id} the assistant's memory: ${dir.failure.reason}`)
          return memoryNotLoaded(dir.failure.reason)
        }
        yield* ensure(dir.success).pipe(Effect.catch((e) => Effect.logWarning(`task=${assistant.id} setting up the assistant's memory: ${e.reason}`)))
        const day = yield* today
        const [, , y, t] = loaded(day)
        const read = (rel: string, tail: boolean) =>
          Effect.map(ws.readForPrompt(dir.success, rel), (text) => memoryFile(text, tail, MEMORY_CAP, MEMORY_CAP_BYTES))
        return memoryPrompt({
          dir: dir.success,
          today: withWeekday(day),
          user: yield* read(USER_FILE, false),
          memory: yield* read(MEMORY_FILE, false),
          yesterdayLog: { rel: y, file: yield* read(y, true) },
          todayLog: { rel: t, file: yield* read(t, true) },
        })
      })

      const commitAll = Effect.fn("Memory.commitAll")(function* (dir: string) {
        if (!(yield* ws.isRepo(dir))) return null
        return yield* ws.commitAllLocked(dir, "Assistant", null).pipe(locked(dir))
      })

      const turnEnded = Effect.fn("Memory.turnEnded")(function* (assistant: Task) {
        const dir = yield* Effect.result(checked(assistant))
        if (Result.isFailure(dir)) return yield* Effect.logWarning(`task=${assistant.id} not committing the assistant's memory: ${dir.failure.reason}`)
        return yield* FiberSet.run(
          background,
          commitAll(dir.success).pipe(Effect.catch((e) => Effect.logWarning(`task=${assistant.id} committing the assistant's memory: ${e.reason}`))),
        ).pipe(Effect.asVoid)
      })

      const overview = Effect.fn("Memory.overview")(function* (task: TaskId, dir: string) {
        const day = yield* today
        const out: MemoryOverview = {
          task_id: task,
          dir,
          cap: MEMORY_CAP,
          cap_bytes: MEMORY_CAP_BYTES,
          today: logName(day),
          history: yield* ws.isRepo(dir),
          files: yield* ws.list(dir, day),
          import_prompt: IMPORT_PROMPT,
        }
        return out
      })

      /** The file `rel` as it was in commit `r`. */
      const atRev = Effect.fnUntraced(function* (dir: string, r: string, rel: string) {
        const o = yield* ws.git(dir, "User", ["show", "--no-textconv", `${r}:${rel}`])
        if (!o.ok) return yield* new NotFound({ what: "file", id: `${rel} in ${r}` })
        return o.stdout
      })

      const read = Effect.fn("Memory.read")(function* (dir: string, rel: string, at: string | null) {
        const path = yield* ws.resolve(dir, rel)
        const content = at !== null && at !== "" ? yield* atRev(dir, yield* rev(at), rel) : yield* ws.readText(path, rel)
        const out: MemoryFileContent = { path: rel, content, rev: at === "" ? null : at }
        return out
      })

      /**
       * Write `content` to `rel` and commit it as the user's, under the lock from the check to the commit. What the file
       * says now, if that isn't committed (the assistant's edit since its last turn), is committed first as the
       * assistant's, so a restore or an overwrite never loses it. One the history leaves out (`.gitignore`) is only
       * written over when it's what the user saw, forced or not.
       */
      const put = (dir: string, path: string, rel: string, content: string, seen: Seen, force: boolean, message: string) =>
        Effect.gen(function* () {
          const there = Option.isSome(yield* ws.lstat(path))
          const now = there ? yield* ws.readText(path, rel) : null
          const sawNow = seen._tag === "Opened" && seen.content === now
          if (!force && seen._tag === "Opened" && !sawNow)
            return yield* new Conflict({ reason: "changed_meanwhile", detail: `${rel} changed since you opened it` })
          if (now !== null && now !== content) {
            yield* ws.commitFileLocked(dir, "Assistant", rel, `Update ${rel}`)
            if ((yield* ws.isRepo(dir)) && !(yield* ws.inHistory(dir, rel)) && !sawNow) {
              return yield* new Conflict({
                reason: "changed_meanwhile",
                detail:
                  `${rel} isn't kept in the memory's history (its .gitignore leaves it out), so what it says now couldn't be ` +
                  "restored, and that isn't what you opened: load it again first",
              })
            }
          }
          yield* ws.writeFile(dir, path, rel, content)
          return yield* ws.commitFileLocked(dir, "User", rel, message)
        }).pipe(locked(dir))

      const write = Effect.fn("Memory.write")(function* (dir: string, rel: string, content: string, expected: string | null, force: boolean) {
        const path = yield* ws.resolve(dir, rel)
        if (new TextEncoder().encode(content).length > MAX_FILE) return yield* new Invalid({ field: "content", reason: "that's too big for a memory file" })
        const commit = yield* put(dir, path, rel, content, { _tag: "Opened", content: expected }, force, `Edit ${rel}`)
        const out: MemoryWrite = { path: rel, content, commit }
        return out
      })

      const history = Effect.fn("Memory.history")(function* (dir: string, rel: string | null) {
        const args = ["log", "-n", "200", "--no-textconv", "--no-ext-diff", LOG_FORMAT, "--name-only"]
        if (rel !== null && rel !== "") {
          yield* ws.resolve(dir, rel)
          args.push("--follow", "--", rel)
        }
        const o = yield* ws.git(dir, "User", args)
        // A repository with no commits yet has no history.
        return parseLog(o.ok ? o.stdout : "")
      })

      const diff = Effect.fn("Memory.diff")(function* (dir: string, r: string, rel: string | null) {
        const checkedRev = yield* rev(r)
        const args = ["show", "--format=", "--no-color", "--no-ext-diff", "--no-textconv", checkedRev]
        if (rel !== null && rel !== "") {
          yield* ws.resolve(dir, rel)
          args.push("--", rel)
        }
        const o = yield* ws.git(dir, "User", args)
        if (!o.ok) return yield* new NotFound({ what: "commit", id: checkedRev })
        const out: MemoryDiff = { rev: checkedRev, diff: o.stdout }
        return out
      })

      const restore = Effect.fn("Memory.restore")(function* (dir: string, rel: string, r: string) {
        const path = yield* ws.resolve(dir, rel)
        const checkedRev = yield* rev(r)
        const content = yield* atRev(dir, checkedRev, rel)
        const commit = yield* put(dir, path, rel, content, { _tag: "Any" }, true, `Restore ${rel} as it was in ${checkedRev.slice(0, 7)}`)
        const out: MemoryWrite = { path: rel, content, commit }
        return out
      })

      const change = Effect.fn("Memory.change")(function* (dir: string, rel: string, message: string, edit: (now: string) => string) {
        const path = yield* ws.resolve(dir, rel)
        return yield* Effect.gen(function* () {
          const there = Option.isSome(yield* ws.lstat(path))
          const now = there ? yield* ws.readText(path, rel) : null
          if (now !== null) yield* ws.commitFileLocked(dir, "Assistant", rel, `Update ${rel}`)
          const content = edit(now ?? "")
          yield* ws.writeFile(dir, path, rel, content)
          const commit = yield* ws.commitFileLocked(dir, "User", rel, message)
          return [content, commit] as const
        }).pipe(locked(dir))
      })

      return Memory.of({
        checked,
        ensure,
        forRun,
        turnEnded,
        commitAll,
        overview,
        read,
        write,
        history,
        diff,
        restore,
        change,
        today,
        idle: FiberSet.awaitEmpty(background),
      })
    }),
  )
}
