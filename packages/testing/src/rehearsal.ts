import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Option } from "effect"
import { ProfileId, ProjectId, TaskId } from "@huntaway/contracts"
import { CodexQueries } from "huntaway-server/src/agents/CodexQueries.ts"
import { TitleModel } from "huntaway-server/src/agents/TitleModel.ts"
import { WindowPrompt } from "huntaway-server/src/agents/WindowPrompt.ts"
import { areasLayer, platformLayer } from "huntaway-server/src/Main.ts"
import { Db } from "huntaway-server/src/platform/Db.ts"
import { importLegacy } from "huntaway-server/src/cli/importLegacy/run.ts"
import { readImportRecord } from "huntaway-server/src/platform/ImportRecord.ts"
import type { ImportRecord } from "huntaway-server/src/platform/ImportRecord.ts"
import { ServerConfig } from "huntaway-server/src/platform/ServerConfig.ts"
import type { ServerConfigShape } from "huntaway-server/src/platform/ServerConfig.ts"
import { git, gitRepo } from "./git.ts"
import { makeLegacyBoard } from "./legacyBoard.ts"
import { tempDir } from "./TestBoard.ts"

// An imported folder for the guard's and the read-only server's tests (docs/plan/11-migration.md, The guard; Rehearsal):
// an old board (`makeLegacyBoard`, the old schema) whose stored paths point at a real repository and at a worktree in
// the old folder, imported with `import-legacy --from <old folder> --data-dir <folder> [--rehearsal]` as a host would
// import it, so its tests run on what the importer writes.

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

/** The rehearsal's board token (its own, written before the import); a switch keeps the old board's. */
const TOKEN = "test-token"
const OLD_TOKEN = "old-board-token"
const AT = "2026-11-12T01:02:03.000Z"

/** An imported folder, a rehearsal's (`rehearsal: true`) or a switch's; everything in temp folders for the scope. */
export const importedFolder = (options: { readonly rehearsal: boolean }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dataDir = yield* tempDir
    const oldDir = yield* tempDir
    const repo = yield* gitRepo
    yield* fs.writeFileString(`${repo}/readme.md`, "# A project\n").pipe(Effect.orDie)
    yield* git(repo, ["add", "readme.md"])
    yield* git(repo, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "readme"])
    const profile = ProfileId.make("p-imported")
    const project = ProjectId.make("j-imported")
    const task = TaskId.make("t-imported")
    // The old board's worktree of the task, in the old folder, as the old server set it up.
    const worktree = `${oldDir}/projects/${project}/worktrees/1-read-the-readme`
    yield* git(repo, ["worktree", "add", "-q", "-b", "ia/imp-1-read-the-readme", worktree, "main"])
    yield* fs.writeFileString(`${worktree}/notes.txt`, "not committed\n").pipe(Effect.orDie)
    const head = yield* git(worktree, ["rev-parse", "HEAD"])
    // The old board's rows, closed again before the import (which refuses a database a process has open).
    yield* Effect.scoped(
      Effect.gen(function* () {
        const old = yield* makeLegacyBoard(oldDir, { hostId: "old-host-1" })
        yield* old.insert("profiles", { id: profile, name: "Imported", created_at: AT })
        yield* old.insert("projects", {
          id: project,
          profile_id: profile,
          name: "Imported project",
          key: "IMP",
          repo_path: repo,
          base_branch: "main",
          scratch_path: `${oldDir}/projects/${project}/scratch`,
          worktrees_root: `${oldDir}/projects/${project}/worktrees`,
          next_number: 2,
          created_at: AT,
        })
        yield* old.insert("tasks", {
          id: task,
          profile_id: profile,
          project_id: project,
          number: 1,
          title: "Read the readme",
          use_worktree: 1,
          worktree_path: worktree,
          branch: "ia/imp-1-read-the-readme",
          base_branch: "main",
          worktree_state: "ready",
          thread_source: "items",
          thread_items: 1,
          last_activity_at: AT,
          created_at: AT,
          updated_at: AT,
        })
        yield* old.insert("threads", { task_id: task, seq: 1, created_at: AT })
        yield* old.insert("thread_items", {
          task_id: task,
          id: "legacy:1",
          pos: 0,
          type: "notice",
          data: `{"id":"legacy:1","type":"notice","level":"info","text":"Imported from the old board","created_at":"${AT}"}`,
          created_at: AT,
          updated_at: AT,
        })
      }),
    )
    // A rehearsal's folder has a token of its own (it copies none of the old host's); a switch takes the old board's.
    yield* fs.writeFileString(`${dataDir}/auth_token`, `${TOKEN}\n`, { mode: 0o600 }).pipe(Effect.orDie)
    const result = yield* importLegacy({
      from: oldDir,
      dataDir,
      check: true,
      force: false,
      rehearsal: options.rehearsal,
      database: Option.none(),
    }).pipe(Effect.orDie)
    if (!result.passes) return yield* Effect.die(`the import's report has failures: ${result.reportFile}`)
    const record = Option.getOrThrow(yield* readImportRecord(dataDir).pipe(Effect.orDie))
    return {
      dataDir,
      oldDir,
      repo,
      record,
      head,
      token: options.rehearsal ? TOKEN : OLD_TOKEN,
      profile,
      project,
      task,
      worktree,
    } satisfies ImportedFolder
  })
