import { Effect } from "effect"
import { agentTools } from "../../src/cli/importLegacy/families/agentTools.ts"
import { automations } from "../../src/cli/importLegacy/families/automations.ts"
import { docs } from "../../src/cli/importLegacy/families/docs.ts"
import { hosts } from "../../src/cli/importLegacy/families/hosts.ts"
import { workflows } from "../../src/cli/importLegacy/families/workflows.ts"
import type { Family } from "../../src/cli/importLegacy/family.ts"

// The families the importer's family tests run (apps/server/src/cli/importLegacy/families/*.test.ts mock
// families/index.ts with this module): the ones under test, after a stand-in for the families that write the rows they
// point at, so that a family's tests do not depend on how the others convert their tables. Kept apart from
// importOld.ts, since importing run.ts from here would be a cycle.

const text = (v: unknown) => (typeof v === "string" ? v : null)

/**
 * A stand-in for the families that run first (profiles, projects, tasks): those rows with only the columns the new
 * tables need, so the rows a test writes point at something and are not dropped as dangling.
 */
const parents: Family = {
  name: "parents (test)",
  reads: ["profiles", "projects", "tasks"],
  writes: ["profiles", "projects", "tasks"],
  run: (io) =>
    Effect.gen(function* () {
      for (const p of yield* io.old.rows("profiles"))
        yield* io.exec(`INSERT INTO profiles (id, name, created_at) VALUES (?, ?, ?)`, [text(p["id"]), text(p["name"]), text(p["created_at"])])
      for (const p of yield* io.old.rows("projects"))
        yield* io.exec(
          `INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ["id", "profile_id", "name", "key", "repo_path", "scratch_path", "worktrees_root", "created_at"].map((c) => text(p[c])),
        )
      for (const t of yield* io.old.rows("tasks"))
        yield* io.exec(
          `INSERT INTO tasks (id, profile_id, project_id, title, last_activity_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ["id", "profile_id", "project_id", "title", "last_activity_at", "created_at", "updated_at"].map((c) => text(t[c])),
        )
    }),
}

export const FAMILIES: ReadonlyArray<Family> = [parents, agentTools, docs, automations, workflows, hosts]
