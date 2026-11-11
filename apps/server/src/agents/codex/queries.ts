import type { UsageLimit } from "@huntaway/contracts"
import { rfc3339 } from "../../profiles/usage/limits.ts"
import { field, strField } from "./items.ts"

// What the board reads from a short-lived `codex app-server` (huntaway's agent/codex/queries.ts; inventory 01 §2
// Housekeeping, inventory 02): a config's models (for the model picker and a run's effort), its skills (for the
// composer), its account's plan and rate limits (for the usage page, and from a run's `account/rateLimits/updated`), and
// the model a title is written with. Plain functions over the app-server's answers; `agents/CodexQueries` asks.

/** A model a Codex config can use, as `model/list` lists it. */
export interface CodexModel {
  readonly id: string
  readonly name: string
  /** What Codex says it's for ("Fast and affordable model for easier tasks"). */
  readonly description: string
  readonly is_default: boolean
  readonly efforts: ReadonlyArray<string>
  readonly default_effort: string | null
}

/** A skill a Codex config has in a folder, for the composer. */
export interface CodexSkill {
  readonly name: string
  readonly description: string
}

/** The models in a reply to `model/list`, hidden ones left out. */
export const parseModels = (reply: unknown): ReadonlyArray<CodexModel> => {
  const data = field(reply, "data")
  return (Array.isArray(data) ? data : []).flatMap((m: unknown): ReadonlyArray<CodexModel> => {
    if (field(m, "hidden") === true) return []
    const id = strField(m, "model") ?? strField(m, "id") ?? ""
    if (id === "") return []
    const efforts = field(m, "supportedReasoningEfforts")
    return [
      {
        id,
        name: strField(m, "displayName") ?? strField(m, "model") ?? "",
        description: strField(m, "description") ?? "",
        is_default: field(m, "isDefault") === true,
        efforts: (Array.isArray(efforts) ? efforts : []).flatMap((e: unknown) => {
          const effort = strField(e, "reasoningEffort")
          return effort === null ? [] : [effort]
        }),
        default_effort: strField(m, "defaultReasoningEffort"),
      },
    ]
  })
}

/** The enabled skills in a reply to `skills/list` (its short description, else its description). */
export const parseSkills = (reply: unknown): ReadonlyArray<CodexSkill> => {
  const data = field(reply, "data")
  return (Array.isArray(data) ? data : []).flatMap((entry: unknown) => {
    const skills = field(entry, "skills")
    return (Array.isArray(skills) ? skills : []).flatMap((s: unknown): ReadonlyArray<CodexSkill> => {
      if (field(s, "enabled") === false) return []
      const name = strField(s, "name")
      if (name === null) return []
      const short = strField(s, "shortDescription")
      return [{ name, description: short !== null && short !== "" ? short : (strField(s, "description") ?? "") }]
    })
  })
}

/** What a model's name or description says when it's a cheap one, and when it's been superseded. */
const CHEAP = /\b(?:mini|nano|lite|small|spark|fast|faster|affordable|efficient|cheap|cheaper|lightweight)\b/i
const OLD = /\b(?:older|legacy|deprecated|previous)\b/i

/**
 * The model and effort for a title, from a config's models: the first cheap one (by its id, name or description),
 * current ones before older ones and the default before the rest, or the config's default (null) if none is; at low
 * effort, or the least the model has if it can't do low.
 */
export const titleModel = (list: ReadonlyArray<CodexModel>): { readonly model: string | null; readonly effort: string } => {
  const text = (m: CodexModel) => `${m.id} ${m.name} ${m.description}`
  const rank = (m: CodexModel) => (OLD.test(text(m)) ? 2 : 0) + (m.is_default ? 0 : 1)
  const cheap = list.filter((m) => CHEAP.test(text(m))).toSorted((a, b) => rank(a) - rank(b))
  const m = cheap[0]
  const effort = m === undefined || m.efforts.length === 0 || m.efforts.includes("low") ? "low" : (m.efforts[0] ?? "low")
  return { model: m?.id ?? null, effort }
}

/**
 * Codex's windows, told apart by their length (`windowDurationMins`), as Codex's own status does: 5 hours is the
 * session one and a week the weekly one, whichever of `primary` and `secondary` has it (a weekly-only plan's `primary`
 * is weekly). Without a length, `primary` is the session and `secondary` the weekly one; another length is named by it.
 */
export const rateLimits = (rl: unknown): ReadonlyArray<UsageLimit> => {
  const out: Array<UsageLimit> = []
  for (const [key, fallback] of [
    ["primary", "session"],
    ["secondary", "weekly"],
  ] as const) {
    const w = field(rl, key)
    const used = field(w, "usedPercent")
    if (typeof used !== "number") continue
    const mins = field(w, "windowDurationMins")
    const m = typeof mins === "number" && Number.isInteger(mins) ? mins : null
    let id: string
    let label: string
    if (m === null) [id, label] = fallback === "session" ? ["session", "Session"] : ["weekly", "Weekly"]
    else if (m === 300) [id, label] = ["session", "Session"]
    else if (m === 10080) [id, label] = ["weekly", "Weekly"]
    else if (m % 1440 === 0) [id, label] = [`window:${m}`, `${m / 1440}-day`]
    else if (m % 60 === 0) [id, label] = [`window:${m}`, `${m / 60}-hour`]
    else [id, label] = [`window:${m}`, `${m}-minute`]
    if (out.some((l) => l.id === id)) continue
    const resets = field(w, "resetsAt")
    out.push({ id, label, percent: used, resets_at: typeof resets === "number" && Number.isInteger(resets) ? rfc3339(resets) : null })
  }
  return out
}

/** The plan a rate limits answer names (`planType`). */
export const planType = (rl: unknown): string | null => strField(rl, "planType")
