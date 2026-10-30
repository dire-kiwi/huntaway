// Tasks made together from one prompt, each run by another agent (IA-227, see harnesses.ts): their cards say which
// model each ran with, and each one's details list the others to compare them.
import clsx from "clsx";
import { Cpu } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { agentOf, type ClaudeConfig, type Task } from "../api";
import { availableConfigs, taskKey, useStore } from "../store";
import { CARD_BADGE } from "./ui";

/** The tasks made from the same prompt as `task`, it among them, in the order they were made. */
export function useFanout(task: Task): Task[] {
  return useStore(
    useShallow((s) =>
      task.fanout_id
        ? Object.values(s.tasks)
            .filter((t) => t.host_id === task.host_id && t.fanout_id === task.fanout_id)
            .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number)
        : [],
    ),
  );
}

/** The config each task runs with: its own, or the first its project (or profile) offers. */
export function useConfigsOf(tasks: Task[]): (ClaudeConfig | undefined)[] {
  return useStore(
    useShallow((s) =>
      tasks.map(
        (t) =>
          s.claudeConfigs.find((c) => c.host_id === t.host_id && c.id === t.claude_config_id) ??
          availableConfigs(s, t.host_id, t.profile_id, s.projects.find((p) => p.host_id === t.host_id && p.id === t.project_id))[0],
      ),
    ),
  );
}

/** What tells each of them apart: its model, and its config when they don't all have the same. */
export function harnessLabels(tasks: Task[], configs: (ClaudeConfig | undefined)[]): string[] {
  const mixed = new Set(configs.map((c) => c?.id ?? "")).size > 1;
  return tasks.map((t, i) => {
    const c = configs[i];
    const model = t.model || (c && agentOf(c) === "codex" ? "Codex's default" : "default model");
    return mixed && c ? `${model} · ${c.name}` : model;
  });
}

/** On a card: the model a task made from one prompt with others runs with. */
export function FanoutBadge({ task }: { task: Task }) {
  const tasks = useFanout(task);
  const projects = useStore((s) => s.projects);
  const configs = useConfigsOf(tasks);
  if (tasks.length < 2) return null;
  const labels = harnessLabels(tasks, configs);
  const i = tasks.findIndex((t) => t.id === task.id);
  const others = tasks.filter((t) => t.id !== task.id).map((t) => `${taskKey(t, projects)} (${labels[tasks.indexOf(t)]})`);
  return (
    <span className={clsx(CARD_BADGE, "min-w-0 text-muted")} title={`Made from the same prompt as ${others.join(", ")}`}>
      <Cpu size={11} className="shrink-0" /> <span className="truncate">{labels[i]}</span>
    </span>
  );
}
