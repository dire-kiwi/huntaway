import { Effect, Option, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { AgentConfigId, ProfileId, Reviewer } from "@huntaway/contracts"
import type { Profile } from "@huntaway/contracts"
import { AgentToolsRepo } from "../../agents/AgentToolsRepo.ts"
import { nowTimestamp } from "../../platform/columns.ts"
import { AgentConfigRepo } from "../../profiles/AgentConfigRepo.ts"
import type { AgentConfigRow } from "../../profiles/AgentConfigRepo.ts"
import { checkTint, reviewersValue } from "../../profiles/checks.ts"
import { ProfileRepo } from "../../profiles/ProfileRepo.ts"
import type { ProfileColumns } from "../../profiles/ProfileRepo.ts"

// What else of the board is the same on every host (HE-46; docs/plan/08-hosts.md, The mesh): settings sync as an
// eventually consistent store of the board's settings, whichever host a client is on. A profile itself (it exists or not,
// by name), the rest of its settings that don't belong to one machine, its skill and MCP switches, and an agent config's
// options. Ids differ from host to host, so whatever names a config, skill or server does it by name; a value that names
// one this host doesn't have isn't taken whole, and is taken again once it has it (settings sync keeps trying a value it
// couldn't take, and doesn't send this host's back as a change). Paths, logins, tokens and keys stay on their machine.

/** A field as settings sync takes it: read, written (or refused, with why), and what its change announces. */
export interface BoardField {
  readonly name: string
  readonly read: Effect.Effect<unknown>
  readonly write: (value: unknown) => Effect.Effect<void, string>
  readonly event: "profiles" | "tools"
  /** A value of null with no entry is something this host lacks, not something it removed: no entry is made for it. */
  readonly absentUnknown: boolean
}

export const profilePrefix = (name: string) => `profile/${encodeURIComponent(name)}/`
/** A profile's own field: it exists on the board (true) or was removed (null). */
export const EXISTS = "exists"
/** An agent config's fields go by its name. */
export const configPrefix = (name: string) => `config/${encodeURIComponent(name)}/`

/** The names `prefix` and `suffix` enclose among `known`. */
const namesBetween = (known: Iterable<string>, prefix: string, suffix: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const n of known) {
    if (!n.startsWith(prefix) || !n.endsWith(suffix) || n.length <= prefix.length + suffix.length) continue
    const part = n.slice(prefix.length, n.length - suffix.length)
    // A name is encoded: a `/` in it is a field further down (`profile/<name>/config/<config>`), not this one.
    if (part.includes("/")) continue
    try {
      out.push(decodeURIComponent(part))
    } catch {
      // One encoded wrong is no profile's.
    }
  }
  return out
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const bool = (v: unknown): Effect.Effect<boolean, string> => (typeof v === "boolean" ? Effect.succeed(v) : Effect.fail("must be true or false"))
/** A reviewer as it syncs: its config by name. */
const SyncedReviewer = Schema.Struct({ ...Reviewer.fields, claude_config_id: Schema.NullOr(Schema.String) })
const decodeReviewers = Schema.decodeUnknownEffect(Schema.NullOr(Schema.Array(SyncedReviewer)))
const decodeRenamed = Schema.decodeUnknownEffect(Schema.Struct({ renamed_to: Schema.String }))
const decodeSwitches = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Boolean))

/** `list` with each one's config `as` says. */
const withConfigs = <C>(list: ReadonlyArray<Reviewer | typeof SyncedReviewer.Type>, as: (id: string | null) => C) => {
  const out: Array<Omit<Reviewer, "claude_config_id"> & { readonly claude_config_id: C }> = []
  for (const r of list) {
    out.push({
      claude_config_id: as(r.claude_config_id),
      model: r.model,
      effort: r.effort,
      ...(r.name === undefined ? {} : { name: r.name }),
      ...(r.skills === undefined ? {} : { skills: r.skills }),
      ...(r.prompt === undefined ? {} : { prompt: r.prompt }),
    })
  }
  return out
}

export const makeBoardFields = Effect.gen(function* () {
  const profiles = yield* ProfileRepo
  const configs = yield* AgentConfigRepo
  const tools = yield* AgentToolsRepo
  const random = yield* SecureRandom.SecureRandom
  const newId = Effect.map(Effect.orDie(random.uuidV4()), (id) => ProfileId.make(id))

  const byName = (name: string) => Effect.map(profiles.list, (all) => all.find((p) => p.name === name))

  /** Config ids as names, and back: a name this host has no config of is left out (and the value isn't whole). */
  const configNames = Effect.map(configs.list, (all) => {
    const nameOf = new Map(all.map((c) => [String(c.id), c.name]))
    const idOf = new Map<string, AgentConfigRow>()
    for (const c of all) if (!idOf.has(c.name)) idOf.set(c.name, c)
    return {
      name: (id: string | null) => (id === null ? null : (nameOf.get(id) ?? null)),
      id: (name: string | null) => (name === null ? null : (idOf.get(name)?.id ?? null)),
      ids: new Set(all.map((c) => String(c.id))),
    }
  })

  /** A profile's field over its row: `read` it, and the columns for a value. */
  const column = (
    p: Profile,
    key: string,
    read: (row: Profile) => Effect.Effect<unknown>,
    columns: (v: unknown, row: Profile) => Effect.Effect<ProfileColumns, string>,
  ): BoardField => {
    const current = Effect.map(profiles.get(p.id), Option.getOrNull)
    return {
      name: profilePrefix(p.name) + key,
      read: Effect.flatMap(current, (row) => (row === null ? Effect.succeed(null) : read(row))),
      write: (v) =>
        Effect.gen(function* () {
          const row = yield* current
          if (row === null) return
          yield* profiles.update(row.id, yield* columns(v, row))
        }),
      event: "profiles",
      absentUnknown: false,
    }
  }
  const flag = (p: Profile, key: "asana_enabled" | "telemetry" | "telemetry_titles") =>
    column(
      p,
      key,
      (row) => Effect.succeed(row[key]),
      (v) => Effect.map(bool(v), (b) => ({ [key]: b })),
    )

  /** Reviewers or summarizers, their configs by name. */
  const reviewers = (p: Profile, key: "reviewers" | "summarizers") =>
    column(
      p,
      key,
      (row) =>
        Effect.map(configNames, (c) => {
          const list = row[key]
          return list === null ? null : withConfigs(list, c.name)
        }),
      (v, row) =>
        Effect.gen(function* () {
          const given = yield* decodeReviewers(v).pipe(Effect.mapError(() => "must be a list of reviewers"))
          const c = yield* configNames
          const list =
            given === null
              ? null
              : withConfigs(given, (name) => {
                  const id = c.id(name)
                  return id === null ? null : AgentConfigId.make(id)
                })
          const options = { saved: row[key] ?? [], configs: c.ids, summarizers: key === "summarizers", defaultsToo: true }
          return { [key]: yield* reviewersValue(list, options).pipe(Effect.mapError((e) => e.reason)) }
        }),
    )

  /**
   * Whether the profile has the config of that name (true, or null once taken off): one field each, so a host keeps the
   * configs of its own that another host has none of, and a config taken off on one host goes from the others. One this
   * host has no config of the name is waited for. Taken off, the assistant's and threads' config go back to the default
   * if it was theirs, as `Profiles.update` does.
   */
  const configOn = (p: Profile, config: string): BoardField => {
    const current = Effect.map(profiles.get(p.id), Option.getOrNull)
    return {
      name: `${profilePrefix(p.name)}config/${encodeURIComponent(config)}`,
      read: Effect.gen(function* () {
        const row = yield* current
        if (row === null) return null
        const c = yield* configNames
        return row.claude_config_ids.some((id) => c.name(id) === config) ? true : null
      }),
      write: (v) =>
        Effect.gen(function* () {
          const row = yield* current
          if (row === null) return yield* Effect.void
          const c = yield* configNames
          const has = row.claude_config_ids
          if (v === true) {
            const id = c.id(config)
            if (id === null) return yield* Effect.fail(`there's no config ${config} on this host`)
            if (has.includes(AgentConfigId.make(id))) return yield* Effect.void
            return yield* profiles.update(row.id, { claude_config_ids: [...has, AgentConfigId.make(id)] })
          }
          if (v !== null) return yield* Effect.fail("must be true or null")
          const left = has.filter((id) => c.name(id) !== config)
          if (left.length === has.length) return yield* Effect.void
          const stays = (id: AgentConfigId | null) => id === null || left.includes(id)
          return yield* profiles.update(row.id, {
            claude_config_ids: left,
            ...(stays(row.assistant_config_id) ? {} : { assistant_config_id: null }),
            ...(stays(row.threads_config_id) ? {} : { threads_config_id: null }),
          })
        }),
      event: "profiles",
      absentUnknown: true,
    }
  }
  /** The configs named for profile `p` here and in `known`'s entries. */
  const configsOf = (p: Profile, known: Iterable<string>) =>
    Effect.map(configNames, (c) => {
      const out = new Set(p.claude_config_ids.flatMap((id) => c.name(id) ?? []))
      for (const name of namesBetween(known, `${profilePrefix(p.name)}config/`, "")) out.add(name)
      return [...out].toSorted()
    })
  const configOf = (p: Profile, key: "assistant_config_id" | "threads_config_id") =>
    column(
      p,
      key,
      (row) => Effect.map(configNames, (c) => c.name(row[key])),
      (v, row) =>
        Effect.gen(function* () {
          if (v !== null && typeof v !== "string") return yield* Effect.fail("must be a config's name or null")
          const id = (yield* configNames).id(v)
          if (v !== null && id === null) return yield* Effect.fail(`there's no config ${v} on this host`)
          if (id !== null && !row.claude_config_ids.includes(AgentConfigId.make(id))) return yield* Effect.fail(`${v} isn't one of the profile's configs here`)
          return { [key]: id === null ? null : AgentConfigId.make(id) }
        }),
    )

  /** The profile's switches for global skills and servers (its defaults), by `skill:<name>` and `mcp:<name>`. */
  const switches = (p: Profile): BoardField => {
    const items = Effect.gen(function* () {
      const skills = (yield* tools.skills(null)).map((s) => [String(s.id), `skill:${s.name}`] as const)
      const servers = (yield* tools.servers(null)).map((s) => [String(s.id), `mcp:${s.name}`] as const)
      return new Map([...skills, ...servers])
    })
    return {
      name: profilePrefix(p.name) + "tool_switches",
      read: Effect.gen(function* () {
        const row = Option.getOrNull(yield* profiles.get(p.id))
        if (row === null) return null
        const named = yield* items
        const out: Record<string, boolean> = {}
        for (const [id, on] of Object.entries(yield* tools.switches("profile", row.id))) {
          const name = named.get(id)
          if (name !== undefined) out[name] = on
        }
        return out
      }),
      write: (v) =>
        Effect.gen(function* () {
          const want = yield* decodeSwitches(v ?? {}).pipe(Effect.mapError(() => "must be {skill:<name> or mcp:<name>: on}"))
          const named = yield* items
          const have = yield* tools.switches("profile", p.id)
          for (const [id, name] of named) {
            const on = want[name]
            if (on === undefined ? have[id] !== undefined : have[id] !== on) yield* tools.setSwitch("profile", p.id, id, on ?? null)
          }
        }),
      event: "tools",
      absentUnknown: false,
    }
  }

  /**
   * Whether a profile of that name is on the board: true, null once removed, or `{ renamed_to }` once renamed (its former
   * names are kept, `ProfileRepo.renamed`). One another host made is made here (no configs but those its other fields
   * name, once they are applied). One renamed elsewhere is renamed here, in place of an empty one of the new name sync may
   * have made first. One removed elsewhere is removed here only while it has no projects and no tasks here: sync never
   * deletes work, and the profile stays until it holds none.
   */
  const exists = (name: string): BoardField => ({
    name: profilePrefix(name) + EXISTS,
    read: Effect.gen(function* () {
      if ((yield* byName(name)) !== undefined) return true
      const id = yield* profiles.formerly(name)
      const now = id === null ? null : Option.getOrNull(yield* profiles.get(id))
      return now === null ? null : { renamed_to: now.name }
    }),
    write: (v) =>
      Effect.gen(function* () {
        const p = yield* byName(name)
        if (v === true) {
          if (p !== undefined) return yield* Effect.void
          if ((yield* profiles.list).some((o) => sameName(o.name, name))) return yield* Effect.fail("a profile of that name in another case is here")
          return yield* profiles.insert(yield* newId, yield* nowTimestamp, { name, claude_config_ids: [] })
        }
        if (v !== null) {
          const to = yield* decodeRenamed(v).pipe(Effect.mapError(() => "must be true, null or {renamed_to}"))
          if (p === undefined) return yield* Effect.void
          const there = yield* byName(to.renamed_to)
          if (there !== undefined) {
            if ((yield* profiles.holds(there.id)) > 0) return yield* Effect.fail(`a profile ${to.renamed_to} with projects or tasks is here too`)
            yield* profiles.delete(there.id)
          } else if ((yield* profiles.list).some((o) => sameName(o.name, to.renamed_to))) {
            return yield* Effect.fail(`a profile ${to.renamed_to} in another case is here`)
          }
          yield* profiles.update(p.id, { name: to.renamed_to })
          return yield* profiles.renamed(p.id, name)
        }
        if (p === undefined) return yield* Effect.void
        if ((yield* profiles.holds(p.id)) > 0) return yield* Effect.fail("it has projects or tasks on this host, which aren't deleted by sync")
        return yield* Effect.asVoid(profiles.delete(p.id))
      }),
    event: "profiles",
    absentUnknown: true,
  })

  /** An agent config's options that mean the same on every host, by its name (its folder and keys stay here). */
  const configField = (c: AgentConfigRow, key: "show_usage" | "restart_window" | "api_url"): BoardField => ({
    name: configPrefix(c.name) + key,
    read: Effect.map(configs.get(c.id), (o) => (Option.isNone(o) ? null : o.value[key])),
    write: (v) =>
      Effect.gen(function* () {
        if (key === "api_url") {
          if (v !== null && (typeof v !== "string" || !/^https?:\/\/\S+$/.test(v))) return yield* Effect.fail("must be an http(s) URL or null")
          return yield* configs.update(c.id, { api_url: v })
        }
        return yield* configs.update(c.id, { [key]: yield* bool(v) })
      }),
    event: "profiles",
    absentUnknown: false,
  })

  /** The fields: each profile's here and each one `known` names, and each config's here. */
  const fields = (given: Iterable<string>) =>
    Effect.gen(function* () {
      const names = [...given]
      const out: Array<BoardField> = []
      const here = yield* profiles.list
      const seen = new Set<string>()
      for (const p of here) {
        if (seen.has(p.name)) continue
        seen.add(p.name)
        out.push(
          exists(p.name),
          flag(p, "asana_enabled"),
          flag(p, "telemetry"),
          flag(p, "telemetry_titles"),
          column(
            p,
            "tint",
            (row) => Effect.succeed(row.tint),
            (v) =>
              v === null || typeof v === "string"
                ? Effect.map(
                    Effect.mapError(checkTint(v), (e) => e.reason),
                    (tint) => ({ tint }),
                  )
                : Effect.fail("must be a colour or null"),
          ),
          reviewers(p, "reviewers"),
          reviewers(p, "summarizers"),
          configOf(p, "assistant_config_id"),
          configOf(p, "threads_config_id"),
          switches(p),
        )
        for (const config of yield* configsOf(p, names)) out.push(configOn(p, config))
      }
      for (const name of namesBetween(names, "profile/", `/${EXISTS}`)) if (!seen.has(name)) out.push(exists(name))
      const configNamesSeen = new Set<string>()
      for (const c of yield* configs.list) {
        if (configNamesSeen.has(c.name)) continue
        configNamesSeen.add(c.name)
        out.push(configField(c, "show_usage"), configField(c, "restart_window"), configField(c, "api_url"))
      }
      return out
    })

  return { fields }
})
