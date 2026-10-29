// What a thread's agent (Claude Code or Codex, from its config) offers to pick from.
import { useEffect, useState } from "react";
import { agentOf, api, EFFORTS, MODEL_ALIASES, type AgentModel, type ClaudeConfig } from "./api";

/** Claude's models, which Codex threads don't inherit from their project, profile or host. */
export const isClaudeModel = (m: string) => {
  const v = m.trim().toLowerCase();
  return MODEL_ALIASES.includes(v) || v === "default" || v === "opusplan" || v.startsWith("claude");
};

const cache = new Map<string, Promise<AgentModel[]>>();

/** The models a Codex config offers (fetched once per config); null for Claude configs or while loading. */
export function useAgentModels(config: ClaudeConfig | undefined): AgentModel[] | null {
  const codex = agentOf(config) === "codex";
  const key = config ? `${config.host_id}:${config.id}` : "";
  const [models, setModels] = useState<{ key: string; list: AgentModel[] } | null>(null);
  useEffect(() => {
    if (!codex || !config) return;
    let p = cache.get(key);
    if (!p) {
      p = api.claudeConfigModels(config.host_id, config.id);
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    let live = true;
    p.then((list) => live && setModels({ key, list })).catch(() => {});
    return () => {
      live = false;
    };
  }, [codex, key, config]);
  return codex && models?.key === key ? models.list : null;
}

/** The models each of several configs offers, by config id, as useAgentModels has them for one. */
export function useConfigsModels(configs: ClaudeConfig[]): Record<string, AgentModel[] | null> {
  const codex = configs.filter((c) => agentOf(c) === "codex");
  const keys = codex.map((c) => `${c.host_id}:${c.id}`).join(",");
  const [loaded, setLoaded] = useState<Record<string, AgentModel[]>>({});
  useEffect(() => {
    let live = true;
    for (const c of codex) {
      const key = `${c.host_id}:${c.id}`;
      let p = cache.get(key);
      if (!p) {
        p = api.claudeConfigModels(c.host_id, c.id);
        cache.set(key, p);
        p.catch(() => cache.delete(key));
      }
      p.then((list) => live && setLoaded((m) => (m[key] === list ? m : { ...m, [key]: list }))).catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [keys]); // eslint-disable-line react-hooks/exhaustive-deps
  return Object.fromEntries(configs.map((c) => [c.id, agentOf(c) === "codex" ? (loaded[`${c.host_id}:${c.id}`] ?? null) : null]));
}

/** The model options for a picker: Claude's aliases, or a Codex config's models. */
export function modelOptions(config: ClaudeConfig | undefined, models: AgentModel[] | null): { id: string; label: string }[] {
  if (agentOf(config) === "codex") return (models ?? []).map((m) => ({ id: m.id, label: m.name || m.id }));
  return MODEL_ALIASES.map((m) => ({ id: m, label: m[0].toUpperCase() + m.slice(1) }));
}

/** Efforts to offer: Claude's, or those the Codex model (or its default) supports. */
export function effortOptions(config: ClaudeConfig | undefined, models: AgentModel[] | null, model: string): string[] {
  if (agentOf(config) !== "codex" || !models?.length) return [...EFFORTS];
  const m = models.find((x) => x.id === model) ?? models.find((x) => x.is_default) ?? models[0];
  return m.efforts.length ? m.efforts : [...EFFORTS];
}

/** The model a thread inherits, as its agent sees it (Codex skips Claude's). */
export function inheritedModel(config: ClaudeConfig | undefined, models: AgentModel[] | null, ...candidates: (string | null | undefined)[]) {
  const codex = agentOf(config) === "codex";
  const found = candidates.find((m) => m?.trim() && !(codex && isClaudeModel(m)));
  if (found) return found;
  return codex ? models?.find((m) => m.is_default)?.id : undefined;
}
