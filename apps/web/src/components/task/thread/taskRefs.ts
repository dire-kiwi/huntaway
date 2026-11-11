// Task keys in markdown (`HA-12`, or `work:SD-3` for another profile's, as the board's MCP tools take them) are links
// that open the task in the side panel (HA-307, see TaskRef.tsx). The remark plugin marks every word shaped like a key, outside code and
// links; whether it's a task is only known when it's shown, from the tasks loaded, so one that isn't stays text.

import { keyPrefix, type HostTask as Task } from "@huntaway/client"
import type { Nodes, PhrasingContent, Root, Text } from "mdast"
import type { State } from "../../boardHelpers"

/** A key, with a profile's name (or id) before it maybe, not in a word, path or URL (`/t/HA-12`, `a.HA-1`, `HA-12-x`). */
export const TASK_REF = /(?<![\w./:#@-])(?:([\w.-]*\w):)?([A-Z][A-Z0-9]*-\d+)(?![\w-]|\.\w)/g

export const TASK_REF_TAG = "task-ref"

function splitText(node: Text): PhrasingContent[] | null {
  const out: PhrasingContent[] = []
  let last = 0
  for (const m of node.value.matchAll(TASK_REF)) {
    if (m.index > last) out.push({ type: "text", value: node.value.slice(last, m.index) })
    out.push({
      type: "text",
      value: m[0],
      data: { hName: TASK_REF_TAG, hProperties: { taskKey: m[2], profile: m[1] ?? "" }, hChildren: [{ type: "text", value: m[0] }] },
    })
    last = m.index + m[0].length
  }
  if (!out.length) return null
  if (last < node.value.length) out.push({ type: "text", value: node.value.slice(last) })
  return out
}

function visit(node: Nodes) {
  if (node.type === "link" || node.type === "linkReference" || node.type === "code" || node.type === "inlineCode" || node.type === "html") return
  if (!("children" in node)) return
  const children: ReadonlyArray<Nodes> = node.children
  // Set as the tree has it: a text's parent takes the phrasing the key's marks are.
  Reflect.set(
    node,
    "children",
    children.flatMap((c): Nodes[] => (c.type === "text" ? (splitText(c) ?? [c]) : (visit(c), [c]))),
  )
}

/** The remark plugin: marks the keys in the text for `TaskRef` to show. */
export const remarkTaskRefs = () => (tree: Root) => visit(tree)

type Index = Map<string, Task[]>
let cached: { tasks: Readonly<Record<string, Task>>; projects: unknown; index: Index } | null = null

/** The loaded tasks by key (a project's former keys too), built again only when the tasks or projects change. */
function taskIndex(tasks: Readonly<Record<string, Task>>, projects: ReadonlyArray<{ id: string; key: string; former_keys?: ReadonlyArray<string> }>): Index {
  if (cached?.tasks === tasks && cached.projects === projects) return cached.index
  const byId = new Map(projects.map((p) => [p.id, p]))
  const index: Index = new Map()
  const add = (key: string, t: Task) => {
    const list = index.get(key)
    if (list) list.push(t)
    else index.set(key, [t])
  }
  for (const t of Object.values(tasks)) {
    if (t.kind === "review") continue
    const p = t.project_id ? byId.get(t.project_id) : undefined
    add(`${keyPrefix(t, p)}-${t.number}`, t)
    for (const k of p?.former_keys ?? []) add(`${k}-${t.number}`, t)
  }
  cached = { tasks, projects, index }
  return index
}

/**
 * The task `key` names: in profile `profile` when it's given (by name), otherwise the one on the same host and profile
 * as the task open (`near`), or in the profile the sidebar lists, before any other.
 */
export function resolveTaskRef(
  s: Pick<State, "tasks" | "projects" | "profiles">,
  key: string,
  profile: string,
  near: Task | undefined,
  active: string | null,
): { task: Task; qualified: boolean } | null {
  const found = taskIndex(s.tasks, s.projects).get(key.toUpperCase())
  if (!found?.length) return null
  const profileOf = (t: Task) => s.profiles.find((p) => p.host_id === t.host_id && p.id === t.profile_id)?.name
  if (profile) {
    // By its name, or its id, which `@` completion puts when the name has spaces (refCompletion.ts).
    const inProfile = found.filter((t) => profileOf(t)?.toLowerCase() === profile.toLowerCase() || t.profile_id === profile)
    const first = inProfile.find((t) => t.host_id === near?.host_id) ?? inProfile[0]
    if (first) return { task: first, qualified: true }
  }
  const task =
    found.find((t) => t.host_id === near?.host_id && t.profile_id === near?.profile_id) ??
    (active === null ? undefined : found.find((t) => profileOf(t) === active)) ??
    found[0]
  return task ? { task, qualified: false } : null
}
