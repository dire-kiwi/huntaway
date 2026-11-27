// Sets of tasks across repositories (HE-117, HE-120; docs/plan/07-agents.md, Work across repositories): one task per
// repository, made together, the first the set's lead. Their cards say which of the set each is ("1 of 3", the lead
// marked), and each one's details list the others.
import { clsx } from "clsx"
import { Crown, Layers } from "lucide-react"
import { taskKey, type Board, type HostTask as Task } from "@huntaway/client"
import { useShallow } from "../boardHelpers"
import { useBoard } from "../../state/board"
import { CARD_BADGE, Wide } from "../ui"

/** The board's sets by their lead's id (with its host): worked out again only when the tasks change. */
const setsOf = (() => {
  let tasks: Board["tasks"] | undefined
  let last: ReadonlyMap<string, Task[]> = new Map()
  return (s: Board): ReadonlyMap<string, Task[]> => {
    if (s.tasks === tasks) return last
    tasks = s.tasks
    const followers = new Map<string, Task[]>()
    for (const t of Object.values(tasks)) {
      if (!t.lead_id) continue
      const key = `${t.host_id} ${t.lead_id}`
      followers.set(key, [...(followers.get(key) ?? []), t])
    }
    // Tasks are kept by bare id: a lead of another host's id isn't this set's.
    const by = new Map<string, Task[]>()
    for (const [key, theirs] of followers) {
      const first = theirs[0]
      const lead = first?.lead_id ? tasks[first.lead_id] : undefined
      // Made together they're made at once, so by key after that: the same order on every client.
      const rest = theirs.toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.key.localeCompare(b.key))
      by.set(key, lead && lead.host_id === first?.host_id ? [lead, ...rest] : rest)
    }
    last = by
    return last
  }
})()

const none: Task[] = []

/** The set `task` is in, it among them: the lead first, then the others in the order they were made (by key, made at once). Empty when it's in none. */
export function useSet(task: Task): Task[] {
  return useBoard(useShallow((s) => setsOf(s).get(`${task.host_id} ${task.lead_id ?? task.id}`) ?? none))
}

/** A task of a set as its card's tooltip and the Set section name it: its key and its project's name. */
export function useProjectNames(tasks: Task[]): (string | undefined)[] {
  return useBoard(useShallow((s) => tasks.map((t) => s.projects.find((p) => p.host_id === t.host_id && p.id === t.project_id)?.name)))
}

/** On a card: its place in its set and the set's size ("1 of 3"), the lead's with a crown. */
export function SetBadge({ task, compact }: { task: Task; compact?: boolean | undefined }) {
  const set = useSet(task)
  const names = useProjectNames(set)
  if (set.length < 2) return null
  const lead = !task.lead_id
  const place = `${set.findIndex((t) => t.id === task.id) + 1} of ${set.length}`
  const others = set.map((t, i) => `${taskKey(t)}${names[i] ? ` (${names[i]})` : ""}${t.lead_id ? "" : ", the lead"}`)
  const title = `${lead ? "The lead of a set" : "In a set"} of tasks across repositories, on one branch: ${others.join(", ")}`
  const Icon = lead ? Crown : Layers
  return (
    <span className={clsx(compact ? CARD_BADGE : "flex items-center gap-1", lead ? "text-accent" : "text-muted")} title={title} data-set={place}>
      <Icon size={11} className="shrink-0" /> {place}
      {lead && (compact ? <Wide>lead</Wide> : " lead")}
    </span>
  )
}
