import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Schema } from "effect"
import type { ProfileId, ProjectId, TaskId } from "@huntaway/contracts"
import { Timestamp } from "@huntaway/contracts"
import { CodexQueries } from "huntaway-server/src/agents/CodexQueries.ts"
import { TitleModel } from "huntaway-server/src/agents/TitleModel.ts"
import { WindowPrompt } from "huntaway-server/src/agents/WindowPrompt.ts"
import { Worktrees } from "huntaway-server/src/git/Worktrees.ts"
import { areasLayer, platformLayer } from "huntaway-server/src/Main.ts"
import { Actor } from "huntaway-server/src/platform/Changes.ts"
import { Db } from "huntaway-server/src/platform/Db.ts"
import { IMPORT_FILE, ImportRecordJson } from "huntaway-server/src/platform/ImportRecord.ts"
import type { ImportRecord } from "huntaway-server/src/platform/ImportRecord.ts"
import { ServerConfig } from "huntaway-server/src/platform/ServerConfig.ts"
import type { ServerConfigShape } from "huntaway-server/src/platform/ServerConfig.ts"
import { Profiles } from "huntaway-server/src/profiles/Profiles.ts"
import { Projects } from "huntaway-server/src/projects/Projects.ts"
import { Tasks } from "huntaway-server/src/tasks/Tasks.ts"
import { Threads } from "huntaway-server/src/threads/Threads.ts"
import { git, gitRepo } from "./git.ts"
import { makeLegacyBoard } from "./legacyBoard.ts"
import { tempDir } from "./TestBoard.ts"

// An imported folder for the guard's and the read-only server's tests (docs/plan/11-migration.md, The guard; Rehearsal):
// a board in a data folder of its own whose stored paths point at a real repository and at an "old folder" (an old
// board's, `makeLegacyBoard`), with `import.json` beside it.
//
// The seam: until the importer converts boards, the board is built with the server's own services on a file database
// and `import.json` is written by hand. Once it does, `importedFolder` runs `import-legacy --from <old folder>
// --data-dir <folder> [--rehearsal]` over an old board with the same rows instead, and its callers do not change.

/** The whole server's services on a file database in `dataDir` (`board.db`), as a server started there would have them. */
export const FileBoard = (dataDir: string, overrides: Partial<ServerConfigShape> = {}) =>
  areasLayer({ titles: TitleModel.layerScripted, window: WindowPrompt.layerNone, codex: CodexQueries.layerTest }).pipe(
    Layer.provideMerge(platformLayer(Db.layer)),
    Layer.provideMerge(ServerConfig.layerTest({ dataDir, ...overrides })),
    Layer.provideMerge(NodeServices.layer),
  )

export interface ImportedFolder {
  /** The new board's data folder: `board.db`, `import.json`, and the identity its server makes. */
  readonly dataDir: string
  /** The old board's folder, with its database (`huntaway-2.db`) and the task's worktree under `projects/`. */
  readonly oldDir: string
  /** The project's repository. */
  readonly repo: string
  /** The task's worktree, in the old folder, with a change that is not committed (`notes.txt`). */
  readonly worktree: string
  readonly profile: ProfileId
  readonly project: ProjectId
  /** The commit the worktree is on. */
  readonly head: string
  /** A task with a worktree and one notice in its thread. */
  readonly task: TaskId
  /** What `import.json` says. */
  readonly record: ImportRecord
  /** The board token the board was made with. */
  readonly token: string
}

const TOKEN = "test-token"

/** An imported folder, a rehearsal's (`rehearsal: true`) or a switch's; everything in temp folders for the scope. */
export const importedFolder = (options: { readonly rehearsal: boolean }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dataDir = yield* tempDir
    const oldDir = yield* tempDir
    // The old board's database, closed again before anything is started on the new one.
    yield* Effect.scoped(makeLegacyBoard(oldDir, { hostId: "old-host-1" }))
    // The board token is the folder's own file, as a server started there reads it.
    yield* fs.writeFileString(`${dataDir}/auth_token`, `${TOKEN}\n`, { mode: 0o600 }).pipe(Effect.orDie)
    const repo = yield* gitRepo
    yield* fs.writeFileString(`${repo}/readme.md`, "# A project\n").pipe(Effect.orDie)
    yield* git(repo, ["add", "readme.md"])
    yield* git(repo, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "readme"])
    const made = yield* Effect.gen(function* () {
      const profile = yield* (yield* Profiles).create({ name: "Imported" })
      const project = yield* (yield* Projects).create({
        profile_id: profile.id,
        name: "Imported project",
        key: "IMP",
        repo_path: repo,
        base_branch: "main",
      })
      // Where the old board kept its worktrees: the imported paths point there.
      yield* (yield* Projects).update(project.id, { worktrees_root: `${oldDir}/projects/imported/worktrees` })
      const task = yield* (yield* Tasks).create({ project_id: project.id, title: "Read the readme" }, Actor.user)
      yield* (yield* Threads).notice(task.id, "info", "Imported from the old board")
      const set = yield* (yield* Worktrees).setup(task.id)
      return { profile: profile.id, project: project.id, task: task.id, worktree: set.worktree_path ?? "" }
    }).pipe(Effect.orDie, Effect.scoped, Effect.provide(FileBoard(dataDir, { token: null })))
    yield* fs.writeFileString(`${made.worktree}/notes.txt`, "not committed\n").pipe(Effect.orDie)
    const head = yield* git(made.worktree, ["rev-parse", "HEAD"])
    const record: ImportRecord = {
      from: oldDir,
      at: Timestamp.make("2026-11-12T01:02:03.000Z"),
      old_host_id: options.rehearsal ? null : "old-host-1",
      rehearsal: options.rehearsal,
      database: "huntaway-2.db",
    }
    yield* fs.writeFileString(`${dataDir}/${IMPORT_FILE}`, yield* Schema.encodeEffect(ImportRecordJson)(record)).pipe(Effect.orDie)
    return { dataDir, oldDir, repo, record, head, token: TOKEN, ...made } satisfies ImportedFolder
  })
