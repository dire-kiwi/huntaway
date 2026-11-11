import { useState } from "react"
import { agentOf } from "@huntaway/client"
import { inheritedModel, modelOptions, useConfigsModels, type ConfigsModels } from "../../../agents"
import { useAvailableConfigs } from "../../boardHelpers"
import { asEffort, configKey, effortKey, modelKey } from "./draft"
import type { Where } from "./useWhere"
import { useBoard } from "../../../state/board"

export type AgentChoice = ReturnType<typeof useAgentChoice>

/** The config, model and effort it runs with where it goes: those last picked there, which tokens override. */
export function useAgentChoice({ target, inProject, prefId }: Where) {
  const profile = useBoard((s) => s.profiles.find((p) => p.host_id === target.host_id && p.id === target.profile_id))
  const hostSettings = useBoard((s) => s.hostSettings[target.host_id])
  // The model, effort and config last picked where it goes, which tokens override.
  const [model, setModel] = useState(() => localStorage.getItem(modelKey(prefId)) ?? "")
  const [effort, setEffort] = useState(() => asEffort(localStorage.getItem(effortKey(prefId))))
  const efforts = true
  // A group or scratch task isn't in the project, so the project's own configs don't apply to it.
  const configs = useAvailableConfigs(target.host_id, target.profile_id, inProject)
  const [configPref, setConfigPref] = useState(() => localStorage.getItem(configKey(prefId)) ?? "")
  const config = configs.some((c) => c.id === configPref) ? configPref : (configs[0]?.id ?? "")
  const pickConfig = configs.length > 1
  const configObj = configs.find((c) => c.id === config)
  const codex = agentOf(configObj) === "codex"
  // Every config's models, as a `!` can send the task to any of them (IA-227): a Codex config's are its host's
  // (`configs.models`), a Claude config offers Claude's aliases.
  const discovery: ConfigsModels = useConfigsModels(target.host_id, configs)
  const configModels = discovery.models
  const models = configObj ? (configModels[configObj.id] ?? null) : null
  const modelList = modelOptions(configObj, models)
  // Models and efforts are the agent's own, so picking another agent starts them over.
  const setConfig = (id: string) => {
    if (agentOf(configs.find((c) => c.id === id)) !== agentOf(configObj)) {
      setModel("")
      setEffort("")
    }
    setConfigPref(id)
  }
  // The model it runs with on its default model, for what's offered and shown.
  const inherited = inheritedModel(configObj, models, inProject?.model, profile?.default_model, hostSettings?.default_model)
  return {
    profile,
    hostSettings,
    model,
    setModel,
    effort,
    setEffort,
    efforts,
    configs,
    setConfigPref,
    config,
    pickConfig,
    configObj,
    codex,
    discovery,
    configModels,
    modelList,
    setConfig,
    inherited,
  }
}
