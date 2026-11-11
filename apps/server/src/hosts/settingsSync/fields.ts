import { Effect, Option, Schema } from "effect"
import { ApprovalRule, HostEffort, PermissionMode, TerminalTool } from "@huntaway/contracts"
import type { Profile, ProfileId } from "@huntaway/contracts"
import { ApprovalRules } from "../../agents/ApprovalRules.ts"
import { ApprovalRulesRepo } from "../../agents/ApprovalRulesRepo.ts"
import { checkRules } from "../../agents/rules.ts"
import { Events } from "../../platform/Events.ts"
import { AgentConfigs } from "../../profiles/AgentConfigs.ts"
import { checkAgentAccess, parseGithubAccount } from "../../profiles/checks.ts"
import { ProfileRepo } from "../../profiles/ProfileRepo.ts"
import type { ProfileColumns } from "../../profiles/ProfileRepo.ts"
import { HostSettings } from "../../settings/HostSettings.ts"
import { SettingsRepo } from "../../settings/SettingsRepo.ts"

// The fields settings sync keeps the same on the hosts that switch it on (inventory 05 §3.3, the synced fields): a fixed
// list, each under a name that doesn't depend on the host. A profile has a different id on each host, so its fields go
// by its name. Paths, config folders, tokens and everything else that belongs to one machine never sync.

/** A value this host can't take (one from a newer host, say): the field stays as it is here. */
export class Refused extends Schema.TaggedError<Refused, { readonly brand: unique symbol }>()("Refused", { reason: Schema.String }) {}

/** The event that tells the board a field changed: the host's settings, its profiles, or a profile's approval rules. */
export type FieldEvent = { readonly _tag: "settings" } | { readonly _tag: "profiles" } | { readonly _tag: "rules"; readonly profile: ProfileId }

/** A setting that syncs, as it is on this host. */
export interface Field {
  readonly name: string
  /** Its value here. */
  readonly read: Effect.Effect<unknown>
  /** Sets it here, or `Refused` for a value this host can't take. */
  readonly write: (value: unknown) => Effect.Effect<void, Refused>
  readonly event: FieldEvent
}

/** The setting that switches sync on for this host ("true"). It doesn't sync itself. */
export const SETTING = "settings_sync"
/** When this host began to sync, which goes when sync is switched off. */
export const SINCE = "settings_sync_since"

export const profilePrefix = (name: string) => `profile/${encodeURIComponent(name)}/`

const refuse = (reason: string) => Effect.fail(new Refused({ reason }))

const stringOrNull = (v: unknown): Effect.Effect<string | null, Refused> =>
  v === null || typeof v === "string" ? Effect.succeed(v) : refuse("must be a string or null")

const oneOf =
  (list: ReadonlyArray<string>) =>
  (v: unknown): Effect.Effect<string | null, Refused> =>
    v === null || (typeof v === "string" && list.includes(v)) ? Effect.succeed(v) : refuse(`must be one of ${list.join(", ")}`)

const bool = (v: unknown): Effect.Effect<boolean, Refused> => (typeof v === "boolean" ? Effect.succeed(v) : refuse("must be true or false"))

const decodeTools = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(TerminalTool)))
const decodeRules = Schema.decodeUnknownEffect(Schema.Struct({ rules: Schema.Array(ApprovalRule), expiry_minutes: Schema.Int }))

/** Host-wide settings that sync (`settings` rows, as their text), with what a value has to be. */
const GLOBAL: ReadonlyArray<readonly [string, (v: unknown) => Effect.Effect<string | null, Refused>]> = [
  ["default_model", stringOrNull],
  ["default_effort", oneOf(HostEffort.literals)],
  ["default_permission_mode", oneOf(PermissionMode.literals)],
  ["release_prereleases", oneOf(["true"])],
  [
    "terminal_tools",
    (v) =>
      v === null
        ? Effect.succeed(null)
        : typeof v === "string"
          ? Effect.as(
              Effect.mapError(decodeTools(v), () => new Refused({ reason: "must be a JSON list of {id, name, command}" })),
              v,
            )
          : refuse("must be a JSON list or null"),
  ],
]

/** A profile column that syncs: how it reads, and what a value has to be before it is written (`name` is the profile's). */
interface ProfileField {
  readonly read: (p: Profile) => unknown
  readonly columns: (v: unknown, name: string) => Effect.Effect<ProfileColumns, Refused>
}

const flag = (read: (p: Profile) => boolean, columns: (value: boolean) => ProfileColumns): ProfileField => ({
  read,
  columns: (v) => Effect.map(bool(v), columns),
})

/** Profile columns that sync. */
const PROFILE: ReadonlyArray<readonly [string, ProfileField]> = [
  ["default_model", { read: (p) => p.default_model, columns: (v) => Effect.map(stringOrNull(v), (s) => ({ default_model: s?.trim() ? s.trim() : null })) }],
  [
    "github_account",
    {
      read: (p) => p.github_account,
      columns: (v) =>
        Effect.flatMap(stringOrNull(v), (s) => {
          const account = s?.trim() || null
          return account !== null && parseGithubAccount(account) === null ? refuse("must be a GitHub login") : Effect.succeed({ github_account: account })
        }),
    },
  ],
  [
    "limit_wait",
    flag(
      (p) => p.limit_wait,
      (limit_wait) => ({ limit_wait }),
    ),
  ],
  [
    "limit_switch",
    flag(
      (p) => p.limit_switch,
      (limit_switch) => ({ limit_switch }),
    ),
  ],
  [
    "merge_approval",
    flag(
      (p) => p.merge_approval,
      (merge_approval) => ({ merge_approval }),
    ),
  ],
  [
    "require_pr_approval",
    flag(
      (p) => p.require_pr_approval,
      (require_pr_approval) => ({ require_pr_approval }),
    ),
  ],
  [
    "agent_access",
    {
      read: (p) => p.agent_access,
      columns: (v, name) =>
        Array.isArray(v) && v.every((x) => typeof x === "string")
          ? Effect.succeed({ agent_access: checkAgentAccess(name, v) })
          : refuse("must be a list of profile names"),
    },
  ],
]

/** A profile's rules for what its assistant may do without asking: null for the defaults. */
const APPROVAL_RULES = "approval_rules"

/** The fields and how to announce their changes, over this host's services. */
export const makeFields = Effect.gen(function* () {
  const settings = yield* SettingsRepo
  const hostSettings = yield* HostSettings
  const profiles = yield* ProfileRepo
  const rulesRepo = yield* ApprovalRulesRepo
  const approvalRules = yield* ApprovalRules
  const configs = yield* AgentConfigs
  const events = yield* Events

  /** The fields that sync, for the profiles this host has. */
  const fields = Effect.gen(function* () {
    const out: Array<Field> = []
    for (const [key, check] of GLOBAL) {
      out.push({
        name: `global/${key}`,
        read: settings.get(key),
        write: (v) => Effect.flatMap(check(v), (value) => settings.set(key, value)),
        event: { _tag: "settings" },
      })
    }
    const names = new Set<string>()
    for (const p of yield* profiles.list) {
      // Two profiles of one name (allowed before HA-37, in different cases only): the oldest is the one that syncs.
      if (names.has(p.name)) continue
      names.add(p.name)
      const prefix = profilePrefix(p.name)
      const current = profiles.get(p.id)
      for (const [key, field] of PROFILE) {
        out.push({
          name: prefix + key,
          read: Effect.map(current, Option.match({ onNone: () => null, onSome: (row) => field.read(row) ?? null })),
          write: (v) => Effect.flatMap(field.columns(v, p.name), (columns) => profiles.update(p.id, columns)),
          event: { _tag: "profiles" },
        })
      }
      out.push({
        name: prefix + APPROVAL_RULES,
        read: rulesRepo.saved(p.id),
        write: (v) =>
          v === null
            ? rulesRepo.save(p.id, null)
            : decodeRules(v).pipe(
                Effect.mapError(() => new Refused({ reason: "must be {rules, expiry_minutes}" })),
                Effect.flatMap((rules) => Effect.mapError(checkRules(rules), (e) => new Refused({ reason: e.reason }))),
                Effect.flatMap((rules) => rulesRepo.save(p.id, rules)),
              ),
        event: { _tag: "rules", profile: p.id },
      })
    }
    return out
  })

  /** Tells the board about fields that changed here, inside the transaction that changed them (sent once it commits). */
  const announce = (changed: ReadonlyArray<FieldEvent>) =>
    Effect.gen(function* () {
      if (changed.some((e) => e._tag === "settings")) yield* events.emit({ type: "settings_changed", settings: yield* hostSettings.get })
      if (changed.some((e) => e._tag === "profiles")) yield* configs.emitChanged
      const rulesOf = new Set(changed.flatMap((e) => (e._tag === "rules" ? [e.profile] : [])))
      for (const profile of rulesOf) {
        const view = yield* approvalRules.get(profile).pipe(Effect.option)
        if (Option.isSome(view)) yield* events.emit({ type: "approval_rules", profile_id: profile, rules: view.value })
      }
    })

  return { fields, announce }
})
