// Tasks made together from one prompt, each run by another agent (IA-227, see harnesses.ts): their cards say which
// model each ran with, and each one's details list the others to compare them.
import { clsx } from "clsx"
import { Cpu } from "lucide-react"
import { useShallow } from "../boardHelpers"
import { agentOf, taskKey, type HostAgentConfig as ClaudeConfig, type HostTask as Task } from "@huntaway/client"
import { openCompare } from "../../state/route"
import { taskConfig } from "../boardHelpers"
import { CARD_BADGE } from "../ui"
import { useBoard } from "../../state/board"

/** The tasks made from the same prompt as `task`, it among them, in the order they were made. */
export function useFanout(task: Task): Task[] {
  return useBoard(
    useShallow((s) =>
      task.fanout_id
        ? Object.values(s.tasks)
            .filter((t) => t.host_id === task.host_id && t.fanout_id === task.fanout_id)
            .toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number)
        : [],
    ),
  )
}

/** The config each task runs with (see taskConfig). */
export function useConfigsOf(tasks: Task[]): (ClaudeConfig | undefined)[] {
  return useBoard(useShallow((s) => tasks.map((t) => taskConfig(s, t))))
}

/** What tells each of them apart: its model, and its config when they don't all have the same. */
export function harnessLabels(tasks: Task[], configs: (ClaudeConfig | undefined)[]): string[] {
  const mixed = new Set(configs.map((c) => c?.id ?? "")).size > 1
  return tasks.map((t, i) => {
    const c = configs[i]
    const model = t.model || (c && agentOf(c) === "codex" ? "Codex's default" : "default model")
    return mixed && c ? `${model} · ${c.name}` : model
  })
}

/** On a card: the model a task made from one prompt with others runs with. Opens the compare view. */
export function FanoutBadge({ task }: { task: Task }) {
  const tasks = useFanout(task)
  const configs = useConfigsOf(tasks)
  // Comparing them (changes/Compare.tsx) is not yet on this server.
  const compares = false
  if (tasks.length < 2) return null
  const labels = harnessLabels(tasks, configs)
  const i = tasks.findIndex((t) => t.id === task.id)
  const others = tasks.filter((t) => t.id !== task.id).map((t) => `${taskKey(t)} (${labels[tasks.indexOf(t)]})`)
  const title = `Made from the same prompt as ${others.join(", ")}`
  const inner = (
    <>
      <Cpu size={11} className="shrink-0" /> <span className="truncate">{labels[i]}</span>
    </>
  )
  if (!compares)
    return (
      <span className={clsx(CARD_BADGE, "min-w-0 text-muted")} title={title}>
        {inner}
      </span>
    )
  return (
    <button
      className={clsx(CARD_BADGE, "min-w-0 text-muted hover:text-fg hover:underline")}
      title={`${title}\n\nClick to compare them.`}
      onClick={(e) => {
        e.stopPropagation()
        openCompare(task.id)
      }}
    >
      {inner}
    </button>
  )
}
