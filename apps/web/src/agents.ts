// What a thread's agent (Claude Code or Codex, from its config) offers to pick from: Claude's aliases, or a Codex
// config's models (`configs.models`, `useAgentModels`, `useConfigsModels`).
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { agentOf, configModelsAtom, EFFORTS, MODEL_ALIASES, type HostAgentConfig as ClaudeConfig } from "@huntaway/client"

/** A model a Codex config offers (the old wire's `AgentModel`). */
export interface AgentModel {
  readonly id: string
  readonly name: string
  readonly description?: string | null
  readonly is_default: boolean
  readonly efforts: ReadonlyArray<string>
  readonly default_effort: string | null
}

/** Claude's models, which Codex threads don't inherit from their project, profile or host. */
export const isClaudeModel = (m: string): boolean => {
  const v = m.trim().toLowerCase()
  return MODEL_ALIASES.includes(v) || v === "default" || v === "opusplan" || v.startsWith("claude")
}

/** The models each of several configs offers, by config id, as useAgentModels has them for one. */
export interface ConfigsModels {
  readonly models: Record<string, ReadonlyArray<AgentModel> | null>
  /** The Codex configs whose models are still being fetched. */
  readonly loading: ReadonlyArray<ClaudeConfig>
  /** Those whose models couldn't be fetched, and why. */
  readonly failed: ReadonlyArray<{ readonly config: ClaudeConfig; readonly error: string }>
}

/** The models each of several configs (on one host) offers, by config id: a Codex config's from its host, a Claude config's none. */
export function useConfigsModels(host: string, configs: ReadonlyArray<ClaudeConfig>): ConfigsModels {
  const codex = configs.filter((c) => agentOf(c) === "codex")
  const result = useAtomValue(
    configModelsAtom(
      host,
      codex.map((c) => c.id),
    ),
  )
  const value = AsyncResult.isSuccess(result) ? result.value : null
  return {
    models: Object.fromEntries(configs.map((c) => [c.id, agentOf(c) === "codex" ? (value?.models[c.id] ?? null) : null])),
    loading: value === null && codex.length > 0 ? codex : [],
    failed: codex.flatMap((c) => {
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

/** The model options for a picker: Claude's aliases, or a Codex config's models. */
export function modelOptions(config: ClaudeConfig | undefined, models: ReadonlyArray<AgentModel> | null): Array<{ id: string; label: string }> {
  if (agentOf(config) === "codex") return (models ?? []).map((m) => ({ id: m.id, label: m.name || m.id }))
  return MODEL_ALIASES.map((m) => ({ id: m, label: m.charAt(0).toUpperCase() + m.slice(1) }))
}

/** Efforts to offer: Claude's, or those the Codex model (or its default) supports. */
export function effortOptions(config: ClaudeConfig | undefined, models: ReadonlyArray<AgentModel> | null, model: string): Array<string> {
  if (agentOf(config) !== "codex" || !models?.length) return [...EFFORTS]
  const m = models.find((x) => x.id === model) ?? models.find((x) => x.is_default) ?? models[0]
  return m?.efforts.length ? [...m.efforts] : [...EFFORTS]
}

/** The model a thread inherits, as its agent sees it (Codex skips Claude's). */
export function inheritedModel(
  config: ClaudeConfig | undefined,
  models: ReadonlyArray<AgentModel> | null,
  ...candidates: Array<string | null | undefined>
): string | undefined {
  const codex = agentOf(config) === "codex"
  const found = candidates.find((m) => m?.trim() && !(codex && isClaudeModel(m)))
  if (found) return found
  return codex ? models?.find((m) => m.is_default)?.id : undefined
}
