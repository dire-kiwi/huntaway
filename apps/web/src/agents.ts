// What a thread's agent (Claude Code, Codex or an ACP agent, from its config) offers to pick from: Claude's aliases, or
// the models a Codex or ACP config lists (`configs.models`, `useAgentModels`, `useConfigsModels`).
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { agentOf, configModelsAtom, EFFORTS, listsModels, MODEL_ALIASES, type HostAgentConfig as ClaudeConfig } from "@huntaway/client"
import { Effort } from "@huntaway/contracts"
import { Schema } from "effect"

/** A model a Codex or ACP config offers (the old wire's `AgentModel`). */
export interface AgentModel {
  readonly id: string
  readonly name: string
  readonly description?: string | null
  readonly is_default: boolean
  readonly efforts: ReadonlyArray<string>
  readonly default_effort: string | null
}

/** Claude's models, which Codex and ACP threads don't inherit from their project, profile or host. */
export const isClaudeModel = (m: string): boolean => {
  const v = m.trim().toLowerCase()
  return MODEL_ALIASES.includes(v) || v === "default" || v === "opusplan" || v.startsWith("claude")
}

/**
 * The model a new task in a config that lists its own models (Codex, an ACP agent) runs with: the pick, unless it is
 * Claude's and the config doesn't list it (a pick left from a Claude config). Antigravity lists `claude-…` models.
 */
export const ownModelPick = (model: string, models: ReadonlyArray<AgentModel> | null): string =>
  isClaudeModel(model) && !(models ?? []).some((m) => m.id === model) ? "" : model

/** Whether a config's agent lists its own models (Codex, an ACP agent) rather than taking Claude's aliases. */
const listed = (config: ClaudeConfig | undefined): boolean => listsModels(agentOf(config))

/** The models each of several configs offers, by config id, as useAgentModels has them for one. */
export interface ConfigsModels {
  readonly models: Record<string, ReadonlyArray<AgentModel> | null>
  /** The Codex and ACP configs whose models are still being fetched. */
  readonly loading: ReadonlyArray<ClaudeConfig>
  /** Those whose models couldn't be fetched, and why. */
  readonly failed: ReadonlyArray<{ readonly config: ClaudeConfig; readonly error: string }>
}

/** The models each of several configs (on one host) offers, by config id: a Codex or ACP config's from its host, a Claude config's none. */
export function useConfigsModels(host: string, configs: ReadonlyArray<ClaudeConfig>): ConfigsModels {
  const asked = configs.filter(listed)
  const result = useAtomValue(
    configModelsAtom(
      host,
      asked.map((c) => c.id),
    ),
  )
  const value = AsyncResult.isSuccess(result) ? result.value : null
  return {
    models: Object.fromEntries(configs.map((c) => [c.id, listed(c) ? (value?.models[c.id] ?? null) : null])),
    loading: value === null && asked.length > 0 ? asked : [],
    failed: asked.flatMap((c) => {
      const error = value?.failed[c.id]
      return error === undefined ? [] : [{ config: c, error }]
    }),
  }
}

/** The models one config offers (null while they're being listed, or for a Claude config). */
export function useAgentModels(host: string, config: ClaudeConfig | undefined): ReadonlyArray<AgentModel> | null {
  const all = useConfigsModels(host, config === undefined ? [] : [config])
  return config === undefined ? null : (all.models[config.id] ?? null)
}

/** The model options for a picker: Claude's aliases, or a Codex or ACP config's models (none while they're listed or when they couldn't be: its default). */
export function modelOptions(config: ClaudeConfig | undefined, models: ReadonlyArray<AgentModel> | null): Array<{ id: string; label: string }> {
  if (listed(config)) return (models ?? []).map((m) => ({ id: m.id, label: m.name || m.id }))
  return MODEL_ALIASES.map((m) => ({ id: m, label: m.charAt(0).toUpperCase() + m.slice(1) }))
}

/** What a picker's "Specific model…" field shows while it's blank: Claude's (the picker's own) unless the agent lists its models. */
export function modelPlaceholder(config: ClaudeConfig | undefined): string | undefined {
  const agent = agentOf(config)
  return agent === "codex" ? "model id, e.g. gpt-6.1-sol" : agent === "acp" ? "model id, as the agent lists it" : undefined
}

const isEffort = Schema.is(Effort)

/**
 * Efforts to offer: Claude's, or those the Codex or ACP model (or its default) supports, in its order. Only the board's
 * own (`Effort`) are kept, as a task can't carry another (an ACP agent's `thought_level` may be "none" or
 * "extra-high"); a model that lists only others offers none, its default effort.
 */
export function effortOptions(config: ClaudeConfig | undefined, models: ReadonlyArray<AgentModel> | null, model: string): Array<string> {
  if (!listed(config) || !models?.length) return [...EFFORTS]
  const m = models.find((x) => x.id === model) ?? models.find((x) => x.is_default) ?? models[0]
  return m?.efforts.length ? m.efforts.filter(isEffort) : [...EFFORTS]
}

/** The model a thread inherits, as its agent sees it (Codex and ACP agents skip Claude's). */
export function inheritedModel(
  config: ClaudeConfig | undefined,
  models: ReadonlyArray<AgentModel> | null,
  ...candidates: Array<string | null | undefined>
): string | undefined {
  const own = listed(config)
  const found = candidates.find((m) => m?.trim() && !(own && isClaudeModel(m)))
  if (found) return found
  return own ? models?.find((m) => m.is_default)?.id : undefined
}
