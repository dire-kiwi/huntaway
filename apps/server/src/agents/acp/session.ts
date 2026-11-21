import { Predicate } from "effect"
import { configOptions, selectValues } from "./protocol.ts"
import type { ConfigOption, SessionResponse } from "./protocol.ts"

// What the adapter sets of a new (or resumed) ACP session, decided from the session's answer (plain functions): the
// model and the effort as select config options (or the older `session/set_model`), and the board's permission mode
// as one of the agent's session modes; and the models a config offers (`acp-run --list-models`).

/** A setting to make: a select config option's value, or the older `session/set_model`/`session/set_mode`. */
export type Choice =
  | { readonly _tag: "Config"; readonly configId: string; readonly value: string }
  | { readonly _tag: "SetModel"; readonly modelId: string }
  | { readonly _tag: "SetMode"; readonly modeId: string }
  /** Asked for, but the agent doesn't offer it: a warning. */
  | { readonly _tag: "Unavailable"; readonly what: string }
  /** Nothing to do. */
  | { readonly _tag: "None" }

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)

const none: Choice = { _tag: "None" }

const selects = (session: SessionResponse): ReadonlyArray<ConfigOption> =>
  configOptions(session.configOptions).filter((o) => o.type === undefined || o.type === null || o.type === "select")

const offers = (option: ConfigOption, value: string) => selectValues(option).some((v) => v.value === value)

/** The session's model config option: id `model`, else category `model`. */
export const modelOption = (session: SessionResponse): ConfigOption | undefined => {
  const all = selects(session)
  return all.find((o) => o.id === "model") ?? all.find((o) => o.category === "model")
}

/** The session's effort config option (category `thought_level`). */
export const effortOption = (session: SessionResponse): ConfigOption | undefined => selects(session).find((o) => o.category === "thought_level")

/** The session's mode config option (category `mode`). */
const modeOption = (session: SessionResponse): ConfigOption | undefined => selects(session).find((o) => o.category === "mode")

const current = (option: ConfigOption | undefined): string | null => (typeof option?.currentValue === "string" ? option.currentValue : null)

/** How to select model `wanted` (null: the agent's own). */
export const modelChoice = (session: SessionResponse, wanted: string | null): Choice => {
  if (wanted === null || wanted === "") return none
  const option = modelOption(session)
  if (option !== undefined) {
    if (current(option) === wanted) return none
    return offers(option, wanted) ? { _tag: "Config", configId: option.id, value: wanted } : { _tag: "Unavailable", what: `the model ${wanted}` }
  }
  const legacy = session.models
  if (legacy?.currentModelId === wanted) return none
  if ((legacy?.availableModels ?? []).some((m) => m.modelId === wanted)) return { _tag: "SetModel", modelId: wanted }
  return { _tag: "Unavailable", what: `the model ${wanted}` }
}

/** How to select effort `wanted` (null: the agent's own); an agent without a `thought_level` option has none to set. */
export const effortChoice = (session: SessionResponse, wanted: string | null): Choice => {
  if (wanted === null || wanted === "") return none
  const option = effortOption(session)
  if (option === undefined || current(option) === wanted) return none
  return offers(option, wanted) ? { _tag: "Config", configId: option.id, value: wanted } : { _tag: "Unavailable", what: `the effort ${wanted}` }
}

/**
 * The agent's mode ids for each of the board's permission modes, in order of preference. Every mode but "Bypass
 * permissions" ends with the agent's `default` (it asks), so a resumed session left in a mode that asks nothing (`yolo`,
 * from an earlier run) is always taken out of it.
 */
export const modeCandidates = (mode: string): ReadonlyArray<string> => {
  switch (mode) {
    // "Don't ask" denies what isn't allowed already: the agent asks (its default mode) and the board denies. ACP has no
    // sandbox to make a mode that asks nothing safe, as Codex's workspace-write sandbox does.
    case "bypassPermissions":
      return ["yolo", "bypassPermissions", "full-access", "full_access"]
    case "acceptEdits":
      return ["auto_edit", "acceptEdits", "accept-edits", "default"]
    case "plan":
      return ["plan", "default"]
    default:
      return ["default"]
  }
}

/** Whether the board's mode is one in which the agent asks nothing (its requests are allowed without the board). */
export const fullAccess = (mode: string): boolean => mode === "bypassPermissions"

/**
 * The agent's mode for the board's `mode`: the first of its candidates the agent offers. An agent with modes but none of
 * the candidates is a warning (it stays in the mode it's in); one with no modes has none to set.
 */
export const modeChoice = (session: SessionResponse, mode: string): Choice => {
  const option = modeOption(session)
  const wanted = modeCandidates(mode)
  const unavailable: Choice = { _tag: "Unavailable", what: `a mode for the board's ${mode}` }
  if (option !== undefined) {
    const id = wanted.find((w) => offers(option, w))
    if (id === undefined) return unavailable
    return current(option) === id ? none : { _tag: "Config", configId: option.id, value: id }
  }
  const modes = session.modes
  const available = modes?.availableModes ?? []
  if (available.length === 0) return none
  const id = wanted.find((w) => available.some((m) => m.id === w))
  if (id === undefined) return unavailable
  return modes?.currentModeId === id ? none : { _tag: "SetMode", modeId: id }
}

/** The model the session is on: its model option's value, else the older `models`' current one. */
export const currentModel = (session: SessionResponse): string | null => current(modelOption(session)) ?? session.models?.currentModelId ?? null

/** The session after its config options changed (`session/set_config_option` answers with all of them). */
export const withConfigOptions = (session: SessionResponse, options: unknown): SessionResponse =>
  Array.isArray(options) ? { ...session, configOptions: options } : session

/** After `session/set_config_option` answered with nothing: config option `configId` has `value`. */
export const withValue = (session: SessionResponse, configId: string, value: string): SessionResponse => {
  const options: Array<unknown> = []
  for (const o of session.configOptions ?? []) options.push(isRecord(o) && o["id"] === configId ? { ...o, currentValue: value } : o)
  return { ...session, configOptions: options }
}

/** After `session/set_model`/`session/set_mode`, which answer with nothing. */
export const withModel = (session: SessionResponse, modelId: string): SessionResponse =>
  session.models === undefined || session.models === null ? session : { ...session, models: { ...session.models, currentModelId: modelId } }

/** `acp-run --list-models`' line: the models a config offers, the one it's on, and its efforts. */
export interface ModelList {
  readonly models: ReadonlyArray<{ readonly id: string; readonly name: string; readonly description: string | null }>
  readonly current: string | null
  readonly efforts: ReadonlyArray<string>
  readonly default_effort: string | null
}

export const modelList = (session: SessionResponse): ModelList => {
  const option = modelOption(session)
  const models =
    option !== undefined
      ? selectValues(option).map((v) => ({ id: v.value, name: v.name ?? v.value, description: v.description ?? null }))
      : (session.models?.availableModels ?? []).map((m) => ({ id: m.modelId, name: m.name ?? m.modelId, description: m.description ?? null }))
  const effort = effortOption(session)
  return {
    models,
    current: currentModel(session),
    efforts: effort === undefined ? [] : selectValues(effort).map((v) => v.value),
    default_effort: current(effort),
  }
}
