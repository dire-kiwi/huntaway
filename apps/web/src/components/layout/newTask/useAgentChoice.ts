import { useState } from "react";
import { agentOf, hostSupports, type Effort, type Task } from "../../../api";
import { inheritedModel, modelOptions, useConfigsModels } from "../../../agents";
import { useAvailableConfigs, useStore } from "../../../store";
import { configKey, effortKey, modelKey } from "./draft";
import type { Where } from "./useWhere";

export type AgentChoice = ReturnType<typeof useAgentChoice>;

/** The config, model and effort it runs with where it goes: those last picked there, which tokens override. */
export function useAgentChoice({ target, host, inProject, prefId }: Where, subproject: Task | undefined) {
  const profile = useStore((s) => s.profiles.find((p) => p.host_id === target.host_id && p.id === target.profile_id));
  const hostSettings = useStore((s) => s.hostSettings[target.host_id]);
  // The model, effort and config last picked where it goes, which tokens override.
  const [model, setModel] = useState(() => localStorage.getItem(modelKey(prefId)) ?? "");
  const [effort, setEffort] = useState(() => (localStorage.getItem(effortKey(prefId)) ?? "") as Effort | "");
  const efforts = hostSupports(host, 14);
  // A group or scratch task isn't in the project, so the project's own configs don't apply to it.
  const configs = useAvailableConfigs(target.host_id, target.profile_id, inProject);
  // A subproject's tasks start out with its config.
  const [configPref, setConfigPref] = useState(() => subproject?.claude_config_id ?? localStorage.getItem(configKey(prefId)) ?? "");
  const config = configs.some((c) => c.id === configPref) ? configPref : (configs[0]?.id ?? "");
  const pickConfig = configs.length > 1;
  const configObj = configs.find((c) => c.id === config);
  const codex = agentOf(configObj) === "codex";
  // Every config's models, as a `!` can send the task to any of them (IA-227).
  const discovery = useConfigsModels(configs);
  const configModels = discovery.models;
  const models = configObj ? configModels[configObj.id] : null;
  const modelList = modelOptions(configObj, models);
  // Models and efforts are the agent's own, so picking another agent starts them over.
  const setConfig = (id: string) => {
    if (agentOf(configs.find((c) => c.id === id)) !== agentOf(configObj)) {
      setModel("");
      setEffort("");
    }
    setConfigPref(id);
  };
  // The model it runs with on its default model, for what's offered and shown.
  const inherited = inheritedModel(configObj, models, inProject?.model, profile?.default_model, hostSettings?.default_model);
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
  };
}
