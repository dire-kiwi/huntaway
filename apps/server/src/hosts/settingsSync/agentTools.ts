import { Effect, Result, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { McpServerId, SkillId } from "@huntaway/contracts"
import { AgentToolsRepo } from "../../agents/AgentToolsRepo.ts"
import { checkServerConfig, checkServerName, checkSkill } from "../../agents/agentTools/validation.ts"
import { nowTimestamp } from "../../platform/columns.ts"

// The host's global skills and MCP servers as settings that sync (HE-46; docs/plan/08-hosts.md, The mesh): one field
// each, by name, so that adding a skill on one host and a server on another don't conflict, and a skill or server
// removed is a field whose value is null. A skill a skill source brought, and anything of a project's, stays on its
// host: a source is a clone the host makes itself, and a project lives on one host. Database only, as every field.

/** A skill's field is `skill/<name>`; a server's `mcp_server/<name>`. */
export const SKILL = "skill/"
export const SERVER = "mcp_server/"

/** A field's value as `sync` gives it: read, written, refused. */
export interface ToolField {
  readonly name: string
  readonly read: Effect.Effect<unknown>
  readonly write: (value: unknown) => Effect.Effect<void, string>
}

const SkillValue = Schema.Struct({ content: Schema.String, enabled: Schema.Boolean })
const ServerValue = Schema.Struct({ config: Schema.Unknown, enabled: Schema.Boolean, auto_allow: Schema.Boolean })
const decodeSkill = Schema.decodeUnknownEffect(SkillValue)
const decodeServer = Schema.decodeUnknownEffect(ServerValue)

/** A name as a field has it, or none for one that isn't encoded right (from a host that got it wrong). */
const decodeName = (encoded: string): string => {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return ""
  }
}

/** The names after `prefix` among `known` (fields other hosts sent), and those here. */
const namesOf = (prefix: string, known: Iterable<string>, here: ReadonlyArray<string>): ReadonlyArray<string> => {
  const out = new Set(here)
  for (const n of known) {
    if (!n.startsWith(prefix)) continue
    const name = decodeName(n.slice(prefix.length))
    if (name !== "") out.add(name)
  }
  return [...out].toSorted()
}

/** The fields of this host's global skills and servers, and of those `known` names that it doesn't have. */
export const makeToolFields = Effect.gen(function* () {
  const repo = yield* AgentToolsRepo
  const random = yield* SecureRandom.SecureRandom
  const newId = Effect.orDie(random.uuidV4())

  /** The host's own global skill named `name` (not a source's), if it has one. */
  const ownSkill = (name: string) => Effect.map(repo.skills(null), (all) => all.find((s) => s.name === name && s.source_id === null))
  const server = (name: string) => Effect.map(repo.servers(null), (all) => all.find((s) => s.name === name))

  const skillField = (name: string): ToolField => ({
    name: SKILL + encodeURIComponent(name),
    read: Effect.map(ownSkill(name), (s) => (s === undefined ? null : { content: s.content, enabled: s.enabled })),
    write: (value) =>
      Effect.gen(function* () {
        const had = yield* ownSkill(name)
        const at = yield* nowTimestamp
        if (value === null) return yield* had === undefined ? Effect.void : Effect.asVoid(repo.remove("agent_skills", null, had.id))
        const v = yield* decodeSkill(value).pipe(Effect.mapError(() => "must be {content, enabled}"))
        const checked = checkSkill(v.content)
        if (Result.isFailure(checked)) return yield* Effect.fail(checked.failure.reason)
        if (checked.success.name !== name) return yield* Effect.fail(`names the skill ${checked.success.name}, not ${name}`)
        if (had !== undefined) return yield* repo.updateSkill(had.id, { name, content: v.content, enabled: v.enabled }, at)
        if (yield* repo.nameTaken("agent_skills", null, name, null)) return yield* Effect.fail("a skill source on this host has a skill of that name")
        return yield* repo.insertSkill({ id: SkillId.make(yield* newId), project_id: null, name, content: v.content, enabled: v.enabled }, at)
      }),
  })

  const serverField = (name: string): ToolField => ({
    name: SERVER + encodeURIComponent(name),
    read: Effect.map(server(name), (s) => (s === undefined ? null : { config: s.config, enabled: s.enabled, auto_allow: s.auto_allow })),
    write: (value) =>
      Effect.gen(function* () {
        const had = yield* server(name)
        const at = yield* nowTimestamp
        if (value === null) return yield* had === undefined ? Effect.void : Effect.asVoid(repo.remove("agent_mcp_servers", null, had.id))
        const v = yield* decodeServer(value).pipe(Effect.mapError(() => "must be {config, enabled, auto_allow}"))
        const named = checkServerName(name)
        if (Result.isFailure(named)) return yield* Effect.fail(named.failure.reason)
        const config = checkServerConfig(v.config)
        if (Result.isFailure(config)) return yield* Effect.fail(config.failure.reason)
        const fields = { name, config: config.success, enabled: v.enabled, auto_allow: v.auto_allow }
        if (had !== undefined) return yield* repo.updateServer(had.id, fields, at)
        return yield* repo.insertServer(McpServerId.make(yield* newId), null, fields, at)
      }),
  })

  /** The fields: every global skill and server here, and those `known` (entries other hosts sent) that this host lacks. */
  const fields = (known: Iterable<string>) =>
    Effect.gen(function* () {
      const skills = (yield* repo.skills(null)).filter((s) => s.source_id === null).map((s) => s.name)
      const servers = (yield* repo.servers(null)).map((s) => s.name)
      return [...namesOf(SKILL, known, skills).map(skillField), ...namesOf(SERVER, known, servers).map(serverField)]
    })

  return { fields }
})
