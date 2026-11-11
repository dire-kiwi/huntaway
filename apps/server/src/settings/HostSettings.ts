import { Context, Effect, Layer, Option, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { HostEffort, Invalid, LinkId, PermissionMode, TerminalTool } from "@huntaway/contracts"
import type { HostSettings as Settings, HostSettingsPatch } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { SettingsRepo } from "./SettingsRepo.ts"
import { JsonColumn, toJson } from "./columns.ts"

// The host's settings (docs/plan/06-server.md, Settings): typed over the `settings` table, as the old `api/host.ts`
// get_settings / update_settings, without `thread_items` (threads are always items now).

/** The `settings` keys these settings are kept under (docs/plan/inventory/09-data-model.md, section 3d). */
const KEY = {
  default_model: "default_model",
  default_effort: "default_effort",
  default_permission_mode: "default_permission_mode",
  scratch_host: "scratch_host",
  terminal_tools: "terminal_tools",
  public_url: "public_url",
  release_prereleases: "release_prereleases",
  settings_sync: "settings_sync",
} as const

const TerminalTools = JsonColumn(Schema.Array(TerminalTool), [])

/** A tool id ends up in tmux session names. */
const validToolId = (id: string) => id.length > 0 && id.length <= 32 && /^[A-Za-z0-9_-]+$/.test(id)

/**
 * A new list of terminal tools, checked and tidied (the old `hosts/terminal.ts` parse_tools): a name and a command
 * each, trimmed; a tool without a usable id, or with one an earlier tool has, gets `newId()`.
 */
export const checkTerminalTools = (
  given: NonNullable<HostSettingsPatch["terminal_tools"]>,
  newId: Effect.Effect<string>,
): Effect.Effect<ReadonlyArray<TerminalTool>, Invalid> =>
  Effect.gen(function* () {
    const out: Array<TerminalTool> = []
    for (const tool of given) {
      const name = tool.name.trim()
      const command = tool.command.trim()
      if (name === "" || command === "") return yield* new Invalid({ field: "terminal_tools", reason: "each terminal tool needs a name and a command" })
      const asked = tool.id?.trim() ?? ""
      const id = validToolId(asked) && !out.some((t) => t.id === asked) ? asked : yield* newId
      out.push({ id, name, command })
    }
    return out
  })

/**
 * The public URL as stored: trimmed, without trailing slashes, http(s), no spaces, at most 500 bytes. Blank is none.
 */
export const checkPublicUrl = (given: string): Effect.Effect<string | null, Invalid> => {
  const url = given.trim().replace(/\/+$/, "")
  if (url === "") return Effect.succeed(null)
  if (!(url.startsWith("https://") || url.startsWith("http://")) || /\s/u.test(url) || new TextEncoder().encode(url).length > 500) {
    return Effect.fail(new Invalid({ field: "public_url", reason: "public_url must be an http(s) URL, like https://board.example.com" }))
  }
  return Effect.succeed(url)
}

const decodeOption = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.asSome,
    Effect.orElseSucceed(() => Option.none<S["Type"]>()),
  )

export interface HostSettingsShape {
  readonly get: Effect.Effect<Settings>
  /** Each field given is set; null or blank text clears it. Emits `settings_changed`. */
  readonly update: (patch: HostSettingsPatch) => Effect.Effect<Settings, Invalid>
}

/** The host's agent defaults and switches. */
export class HostSettings extends Context.Service<HostSettings, HostSettingsShape>()("huntaway-server/settings/HostSettings") {
  static readonly layer = Layer.effect(
    HostSettings,
    Effect.gen(function* () {
      const repo = yield* SettingsRepo
      const db = yield* Db
      const events = yield* Events
      const random = yield* SecureRandom.SecureRandom

      // Stored values are read leniently: one an older build or a hand edit left is ignored, not an error.
      const get = Effect.gen(function* () {
        const rows = yield* repo.all
        const text = (key: string) => rows.get(key) ?? null
        const pick = <S extends Schema.Codec<unknown, unknown>>(schema: S, key: string) =>
          Effect.map(decodeOption(schema, text(key)), (o) => Option.getOrNull(o))
        return {
          default_model: text(KEY.default_model),
          default_effort: yield* pick(HostEffort, KEY.default_effort),
          default_permission_mode: yield* pick(PermissionMode, KEY.default_permission_mode),
          scratch_host: yield* pick(LinkId, KEY.scratch_host),
          terminal_tools: yield* Schema.decodeEffect(TerminalTools)(text(KEY.terminal_tools)).pipe(Effect.orElseSucceed(() => [])),
          public_url: text(KEY.public_url),
          release_prereleases: text(KEY.release_prereleases) === "true",
          settings_sync: text(KEY.settings_sync) === "true",
        } satisfies Settings
      })

      const update = Effect.fn("HostSettings.update")(function* (patch: HostSettingsPatch) {
        // Checked before anything is written.
        // There are no linked hosts before M7 (docs/plan/13-milestones.md), so no value can name one.
        if (patch.scratch_host != null && patch.scratch_host.trim() !== "") {
          return yield* new Invalid({ field: "scratch_host", reason: "scratch_host must be a linked host, and this host has none" })
        }
        const publicUrl = patch.public_url == null ? patch.public_url : yield* checkPublicUrl(patch.public_url)
        const newId = Effect.map(random.uuidV4(), (id) => id.slice(0, 8)).pipe(Effect.orDie)
        const tools = patch.terminal_tools === undefined ? undefined : yield* checkTerminalTools(patch.terminal_tools, newId)
        const toolsText = tools === undefined ? undefined : tools.length === 0 ? null : yield* toJson(tools)
        return yield* db.tx(
          Effect.gen(function* () {
            const strings = {
              [KEY.default_model]: patch.default_model,
              [KEY.default_effort]: patch.default_effort,
              [KEY.default_permission_mode]: patch.default_permission_mode,
              [KEY.scratch_host]: patch.scratch_host,
              [KEY.public_url]: publicUrl,
              [KEY.terminal_tools]: toolsText,
            }
            for (const [key, value] of Object.entries(strings)) {
              if (value !== undefined) yield* repo.set(key, value)
            }
            if (patch.release_prereleases !== undefined) yield* repo.set(KEY.release_prereleases, patch.release_prereleases ? "true" : null)
            if (patch.settings_sync !== undefined) yield* repo.set(KEY.settings_sync, patch.settings_sync ? "true" : null)
            const settings = yield* get
            yield* events.emit({ type: "settings_changed", settings })
            return settings
          }),
        )
      })

      return HostSettings.of({ get, update })
    }),
  )
}
