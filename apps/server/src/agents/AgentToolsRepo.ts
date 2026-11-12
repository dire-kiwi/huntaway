import { Context, Effect, Layer, Option, Schema } from "effect"
import { McpServerConfig, McpServerId, ProfileId, ProjectId, SeenTools, SkillId, SkillSourceId } from "@huntaway/contracts"
import type { McpServer, SkillSource, SwitchScope, TaskId, Timestamp } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Bit, JsonColumn, rowsOf, toJson } from "../platform/columns.ts"
import type { SkillRow } from "./agentTools/effective.ts"
import type { Found } from "./agentTools/files.ts"
import { renaming } from "./agentTools/sourcePlan.ts"
import type { SourcePlan } from "./agentTools/sourcePlan.ts"
import { frontmatter } from "./agentTools/validation.ts"

// The agent tools' rows (docs/plan/04-database.md; huntaway's agent/agent_tools.ts and sources.ts): `agent_skills`,
// `agent_mcp_servers` (`project_id` null for the host's global ones), `agent_tool_switches`, `project_agent_tools`,
// `skill_sources`, and a thread's own tools in `thread_tools`. Single statements and small groups, database only;
// `SqlError` and `SchemaError` are defects. JSON columns read leniently.

/** A project's lists of what it turns off from elsewhere, and what its runs had. */
export interface Overrides {
  readonly disabled_skills: ReadonlyArray<string>
  readonly disabled_mcp_servers: ReadonlyArray<string>
  readonly seen: Readonly<Record<string, SeenTools>>
}

export const noOverrides: Overrides = { disabled_skills: [], disabled_mcp_servers: [], seen: {} }

/** A thread's own tools: the board skills it has on top of its project's, and the servers it turns off. */
export interface ThreadTools {
  readonly skills: ReadonlyArray<string>
  readonly disabled_mcp_servers: ReadonlyArray<string>
}

const Strings = Schema.Array(Schema.String)

export const SkillRowSchema = Schema.Struct({
  id: SkillId,
  project_id: Schema.NullOr(ProjectId),
  name: Schema.String,
  content: Schema.String,
  enabled: Bit,
  source_id: Schema.NullOr(SkillSourceId),
  source_path: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
})
export const ServerRowSchema = Schema.Struct({
  id: McpServerId,
  project_id: Schema.NullOr(ProjectId),
  name: Schema.String,
  config: JsonColumn(McpServerConfig, {}),
  enabled: Bit,
  auto_allow: Bit,
  created_at: Schema.String,
  updated_at: Schema.String,
})
export const SourceRowSchema = Schema.Struct({
  id: SkillSourceId,
  url: Schema.String,
  git_ref: Schema.NullOr(Schema.String),
  subdir: Schema.NullOr(Schema.String),
  name: Schema.String,
  commit_sha: Schema.NullOr(Schema.String),
  synced_at: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  notes: JsonColumn(Strings, []),
  created_at: Schema.String,
})
export const SwitchRow = Schema.Struct({ scope_id: Schema.String, item_id: Schema.String, enabled: Bit })
export const OverridesRow = Schema.Struct({
  disabled_skills: JsonColumn(Strings, []),
  disabled_mcp_servers: JsonColumn(Strings, []),
  seen: JsonColumn(Schema.Record(Schema.String, Schema.Unknown), {}),
})
/** A thread's own tools' row as the repository reads it (the importer checks what it writes with it). */
export const ThreadToolsRow = Schema.Struct({ skills: JsonColumn(Strings, []), disabled_mcp_servers: JsonColumn(Strings, []) })
const IdRow = Schema.Struct({ id: Schema.String })

const skillRows = rowsOf(SkillRowSchema)
const serverRows = rowsOf(ServerRowSchema)
const sourceRows = rowsOf(SourceRowSchema)
const switchRows = rowsOf(SwitchRow)
const overrideRows = rowsOf(OverridesRow)
const threadRows = rowsOf(ThreadToolsRow)
const idRows = rowsOf(IdRow)
const decodeSeen = Schema.decodeUnknownOption(SeenTools)

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect)

const toSkill = (r: typeof SkillRowSchema.Type): SkillRow => ({
  id: r.id,
  project_id: r.project_id,
  name: r.name,
  description: frontmatter(r.content)?.description ?? "",
  content: r.content,
  enabled: r.enabled,
  source_id: r.source_id,
  source_path: r.source_path,
  created_at: r.created_at,
  updated_at: r.updated_at,
})

const toSource = (r: typeof SourceRowSchema.Type): SkillSource => ({
  id: r.id,
  url: r.url,
  ref: r.git_ref,
  subdir: r.subdir,
  name: r.name,
  commit: r.commit_sha,
  synced_at: r.synced_at,
  error: r.error,
  notes: r.notes,
  created_at: r.created_at,
})

/** Skills or servers: the two tables kept alike. */
export type ToolTable = "agent_skills" | "agent_mcp_servers"

export interface NewSkill {
  readonly id: SkillId
  readonly project_id: ProjectId | null
  readonly name: string
  readonly content: string
  readonly enabled: boolean
}

export interface ServerFields {
  readonly name: string
  readonly config: McpServerConfig
  readonly enabled: boolean
  readonly auto_allow: boolean
}

export interface NewSource {
  readonly id: SkillSourceId
  readonly url: string
  readonly ref: string | null
  readonly subdir: string | null
  readonly name: string
  readonly commit: string
}

export interface AgentToolsRepoShape {
  readonly skills: (owner: ProjectId | null) => Effect.Effect<ReadonlyArray<SkillRow>>
  readonly skill: (owner: ProjectId | null, id: string) => Effect.Effect<SkillRow | null>
  readonly skillsOfSource: (source: string) => Effect.Effect<ReadonlyArray<SkillRow>>
  readonly servers: (owner: ProjectId | null) => Effect.Effect<ReadonlyArray<McpServer>>
  readonly server: (owner: ProjectId | null, id: string) => Effect.Effect<McpServer | null>
  /** Whether a skill or server other than `except` has `name` in the scope. */
  readonly nameTaken: (table: ToolTable, owner: ProjectId | null, name: string, except: string | null) => Effect.Effect<boolean>
  readonly insertSkill: (skill: NewSkill, at: Timestamp) => Effect.Effect<void>
  readonly updateSkill: (
    id: string,
    fields: { readonly name: string; readonly content: string; readonly enabled: boolean },
    at: Timestamp,
  ) => Effect.Effect<void>
  readonly insertServer: (id: McpServerId, owner: ProjectId | null, fields: ServerFields, at: Timestamp) => Effect.Effect<void>
  readonly updateServer: (id: string, fields: ServerFields, at: Timestamp) => Effect.Effect<void>
  /** Deletes one: whether it was there. Its switches go with it (triggers). */
  readonly remove: (table: ToolTable, owner: ProjectId | null, id: string) => Effect.Effect<boolean>
  /** A scope's switches, by item id. */
  readonly switches: (scope: SwitchScope, scopeId: string) => Effect.Effect<Record<string, boolean>>
  /** Every profile's switches, every profile listed. */
  readonly profileSwitches: Effect.Effect<Record<string, Record<string, boolean>>>
  /** Sets a switch, or (null) clears it. */
  readonly setSwitch: (scope: SwitchScope, scopeId: string, item: string, enabled: boolean | null) => Effect.Effect<void>
  readonly overrides: (project: ProjectId) => Effect.Effect<Overrides>
  readonly saveOverrides: (project: ProjectId, o: Overrides) => Effect.Effect<void>
  /** The projects with overrides saved (whose `seen` may name a skill). */
  readonly projectsWithOverrides: Effect.Effect<ReadonlyArray<ProjectId>>
  readonly threadTools: (thread: TaskId) => Effect.Effect<ThreadTools>
  readonly profileIds: Effect.Effect<ReadonlyArray<ProfileId>>
  readonly profileExists: (id: string) => Effect.Effect<boolean>
  readonly projectProfile: (id: string) => Effect.Effect<ProfileId | null>
  readonly sources: Effect.Effect<ReadonlyArray<SkillSource>>
  readonly source: (id: string) => Effect.Effect<SkillSource | null>
  readonly insertSource: (source: NewSource, at: Timestamp) => Effect.Effect<void>
  readonly sourceSynced: (id: string, fields: { readonly commit: string; readonly notes: ReadonlyArray<string> }, at: Timestamp) => Effect.Effect<void>
  readonly sourceNotes: (id: string, notes: ReadonlyArray<string>) => Effect.Effect<void>
  readonly sourceFailed: (id: string, error: string) => Effect.Effect<void>
  /** Deletes a source and (cascade) its skills. */
  readonly removeSource: (id: string) => Effect.Effect<void>
  /** Carries out a source's plan (`planSource`): call it in a transaction. */
  readonly applySource: (id: SkillSourceId, plan: SourcePlan, inserts: ReadonlyArray<readonly [SkillId, Found]>, at: Timestamp) => Effect.Effect<void>
}

export class AgentToolsRepo extends Context.Service<AgentToolsRepo, AgentToolsRepoShape>()("huntaway-server/agents/AgentToolsRepo") {
  static readonly layer = Layer.effect(
    AgentToolsRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db

      const skills = (owner: ProjectId | null) =>
        Effect.map(skillRows(sql`SELECT * FROM agent_skills WHERE project_id IS ${owner} ORDER BY name`), (rows) => rows.map(toSkill))
      const skill = (owner: ProjectId | null, id: string) =>
        Effect.map(skillRows(sql`SELECT * FROM agent_skills WHERE project_id IS ${owner} AND id = ${id}`), (rows) => {
          const r = rows[0]
          return r === undefined ? null : toSkill(r)
        })
      const servers = (owner: ProjectId | null) => serverRows(sql`SELECT * FROM agent_mcp_servers WHERE project_id IS ${owner} ORDER BY name`)
      const server = (owner: ProjectId | null, id: string) =>
        Effect.map(serverRows(sql`SELECT * FROM agent_mcp_servers WHERE project_id IS ${owner} AND id = ${id}`), (rows) => rows[0] ?? null)

      const switches = (scope: SwitchScope, scopeId: string) =>
        Effect.map(switchRows(sql`SELECT scope_id, item_id, enabled FROM agent_tool_switches WHERE scope = ${scope} AND scope_id = ${scopeId}`), (rows) =>
          Object.fromEntries(rows.map((r) => [r.item_id, r.enabled])),
        )

      const overrides = (project: ProjectId) =>
        Effect.map(
          overrideRows(sql`SELECT disabled_skills, disabled_mcp_servers, seen FROM project_agent_tools WHERE project_id = ${project}`),
          (rows): Overrides => {
            const r = rows[0]
            if (r === undefined) return noOverrides
            const seen: Record<string, SeenTools> = {}
            for (const [key, value] of Object.entries(r.seen)) {
              const decoded = decodeSeen(value)
              if (Option.isSome(decoded)) seen[key] = decoded.value
            }
            return { disabled_skills: r.disabled_skills, disabled_mcp_servers: r.disabled_mcp_servers, seen }
          },
        )

      const saveOverrides = (project: ProjectId, o: Overrides) =>
        Effect.gen(function* () {
          const skillsText = yield* toJson(o.disabled_skills)
          const serversText = yield* toJson(o.disabled_mcp_servers)
          const seenText = yield* toJson(o.seen)
          yield* sql`INSERT INTO project_agent_tools (project_id, disabled_skills, disabled_mcp_servers, seen)
            VALUES (${project}, ${skillsText}, ${serversText}, ${seenText})
            ON CONFLICT(project_id) DO UPDATE SET disabled_skills = excluded.disabled_skills,
              disabled_mcp_servers = excluded.disabled_mcp_servers, seen = excluded.seen`
        }).pipe(Effect.orDie)

      const insertFound = (source: SkillSourceId, id: SkillId, f: Found, at: Timestamp) =>
        sql`INSERT INTO agent_skills ${sql.insert({
          id,
          project_id: null,
          name: f.name,
          content: f.content,
          enabled: 1,
          source_id: source,
          source_path: f.path,
          created_at: at,
          updated_at: at,
        })}`

      return AgentToolsRepo.of({
        skills,
        skill,
        skillsOfSource: (source) =>
          Effect.map(skillRows(sql`SELECT * FROM agent_skills WHERE source_id = ${source} ORDER BY name`), (rows) => rows.map(toSkill)),
        servers,
        server,
        nameTaken: (table, owner, name, except) =>
          Effect.map(idRows(sql`SELECT id FROM ${sql(table)} WHERE project_id IS ${owner} AND name = ${name}`), (rows) => rows.some((r) => r.id !== except)),
        insertSkill: (s, at) =>
          run(
            sql`INSERT INTO agent_skills ${sql.insert({
              id: s.id,
              project_id: s.project_id,
              name: s.name,
              content: s.content,
              enabled: s.enabled ? 1 : 0,
              created_at: at,
              updated_at: at,
            })}`,
          ),
        updateSkill: (id, f, at) =>
          run(sql`UPDATE agent_skills SET name = ${f.name}, content = ${f.content}, enabled = ${f.enabled ? 1 : 0}, updated_at = ${at} WHERE id = ${id}`),
        insertServer: (id, owner, f, at) =>
          Effect.gen(function* () {
            const config = yield* toJson(f.config)
            yield* sql`INSERT INTO agent_mcp_servers ${sql.insert({
              id,
              project_id: owner,
              name: f.name,
              config,
              enabled: f.enabled ? 1 : 0,
              auto_allow: f.auto_allow ? 1 : 0,
              created_at: at,
              updated_at: at,
            })}`
          }).pipe(Effect.orDie),
        updateServer: (id, f, at) =>
          Effect.gen(function* () {
            const config = yield* toJson(f.config)
            yield* sql`UPDATE agent_mcp_servers SET name = ${f.name}, config = ${config}, enabled = ${f.enabled ? 1 : 0},
              auto_allow = ${f.auto_allow ? 1 : 0}, updated_at = ${at} WHERE id = ${id}`
          }).pipe(Effect.orDie),
        remove: (table, owner, id) =>
          Effect.map(idRows(sql`DELETE FROM ${sql(table)} WHERE project_id IS ${owner} AND id = ${id} RETURNING id`), (rows) => rows.length > 0),
        switches,
        profileSwitches: Effect.gen(function* () {
          const out: Record<string, Record<string, boolean>> = {}
          for (const r of yield* idRows(sql`SELECT id FROM profiles ORDER BY created_at, rowid`)) out[r.id] = {}
          for (const r of yield* switchRows(sql`SELECT scope_id, item_id, enabled FROM agent_tool_switches WHERE scope = 'profile'`)) {
            const of = out[r.scope_id]
            if (of !== undefined) of[r.item_id] = r.enabled
          }
          return out
        }),
        setSwitch: (scope, scopeId, item, enabled) =>
          run(
            enabled === null
              ? sql`DELETE FROM agent_tool_switches WHERE scope = ${scope} AND scope_id = ${scopeId} AND item_id = ${item}`
              : sql`INSERT INTO agent_tool_switches (scope, scope_id, item_id, enabled) VALUES (${scope}, ${scopeId}, ${item}, ${enabled ? 1 : 0})
                  ON CONFLICT(scope, scope_id, item_id) DO UPDATE SET enabled = excluded.enabled`,
          ),
        overrides,
        saveOverrides,
        projectsWithOverrides: Effect.map(idRows(sql`SELECT project_id AS id FROM project_agent_tools`), (rows) => rows.map((r) => ProjectId.make(r.id))),
        threadTools: (thread) =>
          Effect.map(
            threadRows(sql`SELECT skills, disabled_mcp_servers FROM thread_tools WHERE task_id = ${thread}`),
            (rows): ThreadTools => rows[0] ?? { skills: [], disabled_mcp_servers: [] },
          ),
        profileIds: Effect.map(idRows(sql`SELECT id FROM profiles`), (rows) => rows.map((r) => ProfileId.make(r.id))),
        profileExists: (id) => Effect.map(idRows(sql`SELECT id FROM profiles WHERE id = ${id}`), (rows) => rows.length > 0),
        projectProfile: (id) =>
          Effect.map(idRows(sql`SELECT profile_id AS id FROM projects WHERE id = ${id}`), (rows) =>
            rows[0] === undefined ? null : ProfileId.make(rows[0].id),
          ),
        sources: Effect.map(sourceRows(sql`SELECT * FROM skill_sources ORDER BY name, created_at`), (rows) => rows.map(toSource)),
        source: (id) =>
          Effect.map(sourceRows(sql`SELECT * FROM skill_sources WHERE id = ${id}`), (rows) => {
            const r = rows[0]
            return r === undefined ? null : toSource(r)
          }),
        insertSource: (s, at) =>
          run(
            sql`INSERT INTO skill_sources ${sql.insert({
              id: s.id,
              url: s.url,
              git_ref: s.ref,
              subdir: s.subdir,
              name: s.name,
              commit_sha: s.commit,
              synced_at: at,
              notes: "[]",
              created_at: at,
            })}`,
          ),
        sourceSynced: (id, f, at) =>
          Effect.gen(function* () {
            const notes = yield* toJson(f.notes)
            yield* sql`UPDATE skill_sources SET commit_sha = ${f.commit}, synced_at = ${at}, error = NULL, notes = ${notes} WHERE id = ${id}`
          }).pipe(Effect.orDie),
        sourceNotes: (id, notes) =>
          Effect.gen(function* () {
            const text = yield* toJson(notes)
            yield* sql`UPDATE skill_sources SET notes = ${text} WHERE id = ${id}`
          }).pipe(Effect.orDie),
        sourceFailed: (id, error) => run(sql`UPDATE skill_sources SET error = ${error} WHERE id = ${id}`),
        removeSource: (id) => run(sql`DELETE FROM skill_sources WHERE id = ${id}`),
        applySource: (id, plan, inserts, at) =>
          Effect.gen(function* () {
            for (const s of plan.remove) yield* sql`DELETE FROM agent_skills WHERE id = ${s}`
            // Renames in two steps, so that skills can swap names or pass them along.
            for (const s of plan.rename) yield* sql`UPDATE agent_skills SET name = ${renaming(s)} WHERE id = ${s}`
            for (const { id: s, found } of plan.update)
              yield* sql`UPDATE agent_skills SET name = ${found.name}, content = ${found.content}, source_path = ${found.path}, updated_at = ${at}
                WHERE id = ${s}`
            for (const [fresh, f] of inserts) yield* insertFound(id, fresh, f, at)
          }).pipe(Effect.orDie),
      })
    }),
  )
}
