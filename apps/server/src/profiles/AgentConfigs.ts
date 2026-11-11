import { Context, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { AgentConfigId, Conflict, Invalid } from "@huntaway/contracts"
import type { AgentConfig, AgentConfigPatch, NewAgentConfig } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { nowTimestamp } from "../settings/columns.ts"
import { expandTilde } from "../settings/Folders.ts"
import { AgentConfigRepo } from "./AgentConfigRepo.ts"
import type { AgentConfigColumns, AgentConfigRow } from "./AgentConfigRepo.ts"
import { refuseWhileRunning } from "./checks.ts"
import { ProfileRepo } from "./ProfileRepo.ts"

export class AgentConfigNotFound extends Schema.TaggedError<AgentConfigNotFound, { readonly brand: unique symbol }>()("AgentConfigNotFound", {
  id: Schema.String,
}) {}

/** The proxy fields of a create or update. */
const PROXY_FIELDS = ["api_url", "api_key", "management_key"] as const

/**
 * The proxy fields given, checked (the old `proxy_fields`): trimmed, blank cleared (null), the URL http(s) without
 * trailing slashes. A field left out is left as it is (the keys are write-only).
 */
export const checkProxyFields = (given: Pick<NewAgentConfig, (typeof PROXY_FIELDS)[number]>): Effect.Effect<AgentConfigColumns, Invalid> =>
  Effect.gen(function* () {
    const out: { api_url?: string | null; api_key?: string | null; management_key?: string | null } = {}
    for (const key of PROXY_FIELDS) {
      const v = given[key]
      if (v === undefined) continue
      let text = v?.trim() ?? ""
      if (key === "api_url" && text !== "") {
        if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text) || !URL.canParse(text)) return yield* new Invalid({ field: key, reason: "api_url isn't a URL" })
        const url = new URL(text)
        if (!["http:", "https:"].includes(url.protocol) || url.hostname === "") {
          return yield* new Invalid({ field: key, reason: "api_url must be an http:// or https:// URL" })
        }
        text = text.replace(/\/+$/, "")
      }
      out[key] = text === "" ? null : text
    }
    return out
  })

/** The http(s) `env.ANTHROPIC_BASE_URL` of a settings.json's text, without trailing slashes, or null. */
const SettingsJson = Schema.fromJsonString(Schema.Struct({ env: Schema.optional(Schema.Struct({ ANTHROPIC_BASE_URL: Schema.optional(Schema.String) })) }))
export const settingsBaseUrl = (text: string): Effect.Effect<string | null> =>
  Schema.decodeEffect(SettingsJson)(text).pipe(
    Effect.map((v) => {
      const url = v.env?.ANTHROPIC_BASE_URL?.trim() ?? ""
      return /^https?:\/\/[^/]/i.test(url) ? url.replace(/\/+$/, "") : null
    }),
    Effect.orElseSucceed(() => null),
  )

/** A row as the wire has it, with what its folder's settings.json was last read to say. */
const toWire = (row: AgentConfigRow, known: ReadonlyMap<string, string | null>): AgentConfig => ({
  ...row,
  api_url: row.agent === "codex" ? null : row.api_url,
  settings_api_url: row.agent === "codex" ? null : (known.get(row.config_dir) ?? null),
})

export interface AgentConfigsShape {
  readonly list: Effect.Effect<ReadonlyArray<AgentConfig>>
  readonly create: (input: NewAgentConfig) => Effect.Effect<AgentConfig, Invalid>
  readonly update: (id: AgentConfigId, patch: AgentConfigPatch) => Effect.Effect<AgentConfig, AgentConfigNotFound | Invalid | Conflict>
  /** Refused while agents run with it. Takes it off every profile and project. */
  readonly delete: (id: AgentConfigId) => Effect.Effect<void, AgentConfigNotFound | Conflict>
  /**
   * Re-read the settings files of the configs' folders (and `dirs`), for the `settings_api_url` that `emitChanged`
   * sends. Outside a transaction: it reads files.
   */
  readonly refresh: (dirs?: ReadonlyArray<string>) => Effect.Effect<void>
  /** Inside a transaction: emit `profiles_changed` with every profile and config as they are now. */
  readonly emitChanged: Effect.Effect<void>
  /** Inside a transaction: the oldest Claude Code config on `dir`, made (named `name`) if there is none (the old `config_for_dir`). */
  readonly forDir: (name: string, dir: string) => Effect.Effect<AgentConfigId>
}

/** Agent configs: an agent's config folder on this host, Claude Code's or Codex's, and its proxy. */
export class AgentConfigs extends Context.Service<AgentConfigs, AgentConfigsShape>()("huntaway-server/profiles/AgentConfigs") {
  static readonly layer = Layer.effect(
    AgentConfigs,
    Effect.gen(function* () {
      const repo = yield* AgentConfigRepo
      const profiles = yield* ProfileRepo
      const db = yield* Db
      const events = yield* Events
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const config = yield* ServerConfig
      const random = yield* SecureRandom.SecureRandom
      /** `settings_api_url` by config folder, as last read. */
      const urls = yield* Ref.make<ReadonlyMap<string, string | null>>(new Map())

      const readUrl = (dir: string) => {
        const file = path.join(expandTilde(dir.trim() === "" ? "~/.claude" : dir, config.home), "settings.json")
        return fs.readFileString(file).pipe(
          Effect.flatMap(settingsBaseUrl),
          Effect.orElseSucceed(() => null),
        )
      }
      const refresh = Effect.fn("AgentConfigs.refresh")(function* (dirs: ReadonlyArray<string> = []) {
        const all = [...new Set([...(yield* repo.list).map((c) => c.config_dir), ...dirs])]
        const read = yield* Effect.forEach(all, (dir) => Effect.map(readUrl(dir), (url) => [dir, url] as const), { concurrency: 8 })
        yield* Ref.set(urls, new Map(read))
      })
      const wire = (row: AgentConfigRow) => Effect.map(Ref.get(urls), (known) => toWire(row, known))
      const listWire = Effect.gen(function* () {
        const known = yield* Ref.get(urls)
        return (yield* repo.list).map((row) => toWire(row, known))
      })
      const emitChanged = Effect.gen(function* () {
        yield* events.emit({ type: "profiles_changed", profiles: yield* profiles.list, configs: yield* listWire })
      })
      const newId = Effect.map(random.uuidV4(), (id) => AgentConfigId.make(id)).pipe(Effect.orDie)
      const insert = (columns: AgentConfigColumns) =>
        Effect.gen(function* () {
          const id = yield* newId
          yield* repo.insert(id, yield* nowTimestamp, columns)
          return id
        })
      const getRow = (id: AgentConfigId) =>
        Effect.flatMap(repo.get(id), Option.match({ onNone: () => Effect.fail(new AgentConfigNotFound({ id })), onSome: Effect.succeed }))

      const create = Effect.fn("AgentConfigs.create")(function* (input: NewAgentConfig) {
        const name = input.name.trim()
        if (name === "") return yield* new Invalid({ field: "name", reason: "name is required" })
        const agent = input.agent ?? "claude"
        const proxy = yield* checkProxyFields(input)
        if (agent === "codex" && Object.values(proxy).some((v) => v !== null)) {
          return yield* new Invalid({ field: "api_url", reason: "a proxy is for Claude Code configs" })
        }
        const configDir = input.config_dir?.trim() ?? ""
        yield* refresh([configDir])
        return yield* db.tx(
          Effect.gen(function* () {
            const id = yield* insert({ name, config_dir: configDir, agent, ...proxy })
            yield* emitChanged
            return yield* wire(yield* getRow(id).pipe(Effect.orDie))
          }),
        )
      })

      const update = Effect.fn("AgentConfigs.update")(function* (id: AgentConfigId, patch: AgentConfigPatch) {
        const columns: AgentConfigColumns = {
          ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
          ...(patch.config_dir === undefined ? {} : { config_dir: patch.config_dir.trim() }),
          ...(patch.agent === undefined ? {} : { agent: patch.agent }),
          ...(patch.show_usage === undefined ? {} : { show_usage: patch.show_usage }),
          ...(patch.restart_window === undefined ? {} : { restart_window: patch.restart_window }),
          ...(yield* checkProxyFields(patch)),
        }
        if (columns.name === "") return yield* new Invalid({ field: "name", reason: "name is required" })
        yield* refresh(columns.config_dir === undefined ? [] : [columns.config_dir])
        return yield* db.tx(
          Effect.gen(function* () {
            const current = yield* getRow(id)
            // A Codex config can't have a proxy, nor can one that has a proxy become a Codex config.
            const agent = columns.agent ?? current.agent
            const url = columns.api_url === undefined ? current.api_url : columns.api_url
            if (agent === "codex" && url !== null) {
              return yield* new Invalid({ field: "agent", reason: "a proxy is for Claude Code configs; clear api_url first" })
            }
            if (agent !== current.agent && (yield* repo.sessions(id)) > 0) {
              return yield* new Conflict({ reason: "has_session", detail: "threads have conversations in this config; add another config for the other agent" })
            }
            yield* repo.update(id, columns)
            yield* emitChanged
            return yield* wire(yield* getRow(id))
          }),
        )
      })

      const remove = Effect.fn("AgentConfigs.delete")(function* (id: AgentConfigId) {
        yield* refresh()
        yield* db.tx(
          Effect.gen(function* () {
            yield* getRow(id)
            yield* refuseWhileRunning(yield* repo.running(id), () => "agents are running with this config; stop them first")
            yield* repo.delete(id)
            yield* emitChanged
          }),
        )
      })

      const forDir = (name: string, dir: string) =>
        Effect.flatMap(repo.byDir(dir), Option.match({ onSome: Effect.succeed, onNone: () => insert({ name, config_dir: dir.trim(), agent: "claude" }) }))

      return AgentConfigs.of({
        list: Effect.andThen(refresh(), listWire),
        create,
        update,
        delete: remove,
        refresh,
        emitChanged,
        forDir,
      })
    }),
  )
}
