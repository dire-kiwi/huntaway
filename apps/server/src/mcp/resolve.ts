import { Effect, Option } from "effect"
import { ProjectId } from "@huntaway/contracts"
import type { Profile, Project, Task } from "@huntaway/contracts"
import { asciiLower } from "@huntaway/shared"
import { Identity } from "../platform/Identity.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { TaskRefs } from "../tasks/TaskRefs.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { ToolError } from "./tool.ts"
import type { McpCaller } from "./tool.ts"

// Who a board call's agent is and what it may reach (docs/plan/07-agents.md, Who the caller is; docs/plan/inventory/
// 03-mcp.md 2.3; the old mcp/tools/resolve.ts, rule for rule). The boards it can use are its own profile's first, then
// those of the profiles that let its agents in (`agent_access`: its profile's name, or `*`). A `profile` argument or a
// `<profile>:` prefix picks one of them (`all`: every one); a project is named by id, key, name or a former key, a task
// by id or key (`KEY-n`, `G-n`, `S-n`, `A-n`). An unqualified key is the caller's own board's first, else the one other
// board's that has it, else ambiguous.
//
// What isn't found here fails with `ToolError.notFound`: the seam where M7 asks linked hosts (and the hub) before
// telling the agent it is not there. Anything else fails with `ToolError.other`.

/** Whether profile `p` lets the agents of profile `name` use its board. */
export const grants = (p: Pick<Profile, "name" | "agent_access">, name: string): boolean =>
  p.name === name || p.agent_access.some((n) => n === "*" || n === name)

const sameText = (a: string, b: string) => asciiLower(a) === asciiLower(b)

const isOwn = (caller: McpCaller, board: Profile) => board.id === caller.profile.id

/** One of the matches on the caller's boards: on its own board if it's there, else the only one. */
const pickOne = <A>(caller: McpCaller, what: string, found: ReadonlyArray<readonly [Profile, A]>, qualified: (b: Profile) => string) => {
  const own = found.find(([b]) => isOwn(caller, b))
  if (own !== undefined) return Effect.succeed(own[1])
  const [one, ...more] = found
  if (one === undefined) return Effect.fail(ToolError.notFound(what))
  if (more.length === 0) return Effect.succeed(one[1])
  return Effect.fail(
    ToolError.other(`${what} is on more than one profile's board: name one of ${found.map(([b]) => qualified(b)).join(", ")} (or pass profile)`),
  )
}

export interface Reach {
  /** The boards the caller can use on this host: its own profile's first, then those that let its agents in. */
  readonly boards: (caller: McpCaller) => Effect.Effect<ReadonlyArray<Profile>>
  /** The board a `profile` argument or prefix names (every usable one for none or `all`). */
  readonly pickBoards: (caller: McpCaller, profile: string | null) => Effect.Effect<ReadonlyArray<Profile>, ToolError>
  /** The boards a call without `profile` works on: the caller's own, if it can use it; else those `profile` picks. */
  readonly ownBoards: (caller: McpCaller, profile: string | null) => Effect.Effect<ReadonlyArray<Profile>, ToolError>
  /** A project named by an agent: its id, key, name or former key, optionally as `<profile>:<key>`. */
  readonly project: (caller: McpCaller, ref: string, profile: string | null) => Effect.Effect<Project, ToolError>
  /** A task named by an agent: its id or a key like `ABC-12`, optionally as `<profile>:ABC-12`. Only tasks, never threads under them. */
  readonly task: (caller: McpCaller, ref: string, profile: string | null) => Effect.Effect<Task, ToolError>
  /** The project an agent names, or (none named) the caller's own; "project_id is required" without either. */
  readonly projectOrOwn: (caller: McpCaller, ref: string | null, profile: string | null) => Effect.Effect<Project, ToolError>
  /** The profile a board is, by id (for labelling what is returned). */
  readonly profile: (id: Profile["id"]) => Effect.Effect<Profile | null>
  /** This host's name, which labels what the tools return. */
  readonly hostName: string
}

/** The resolver, over the board's services: built once where a tool area's handlers are. */
export const makeReach = Effect.gen(function* () {
  const profiles = yield* ProfileRepo
  const projects = yield* ProjectRepo
  const refs = yield* TaskRefs
  const tasks = yield* TaskRepo
  const { hostName } = yield* Identity

  const boards = (caller: McpCaller) =>
    Effect.map(profiles.list, (all) => {
      const usable = all.filter((p) => isOwn(caller, p) || grants(p, caller.profile.name))
      return [...usable.filter((p) => isOwn(caller, p)), ...usable.filter((p) => !isOwn(caller, p))]
    })

  const pickBoards = Effect.fnUntraced(function* (caller: McpCaller, profile: string | null) {
    const all = yield* boards(caller)
    if (profile === null || profile === "all") return all
    const named = (p: Profile) => sameText(p.name, profile) || p.id === profile
    const found = all.find(named)
    if (found !== undefined) return [found]
    // Not found here, so that linked hosts are tried too.
    const exists = (yield* profiles.list).some(named)
    return yield* ToolError.notFound(
      exists
        ? `profile ${profile}'s board on ${hostName} doesn't let agents in profile ${caller.profile.name} use it. Ask the user: they can allow it in Settings → Profiles (edit ${profile}, "Agents from other profiles")`
        : `profile ${profile}`,
    )
  })

  const ownBoards = Effect.fnUntraced(function* (caller: McpCaller, profile: string | null) {
    const all = yield* pickBoards(caller, profile)
    return profile === null && all.some((b) => isOwn(caller, b)) ? all.filter((b) => isOwn(caller, b)) : all
  })

  /**
   * `work:SD-3` → `["work", "SD-3"]`, if a profile here is named `work` (or it's `all`). Ids and keys have no colons, but
   * a project's name may: "Ops: infra" is a name unless there's a profile `Ops`. Any profile here counts, not only those
   * that let the caller in, so `pickBoards` can say it doesn't.
   */
  const splitRef = Effect.fnUntraced(function* (ref: string) {
    const colon = ref.indexOf(":")
    if (colon <= 0) return [null, ref] as const
    const prefix = ref.slice(0, colon)
    const isProfile = prefix === "all" || (yield* profiles.list).some((p) => sameText(p.name, prefix) || p.id === prefix)
    return isProfile ? ([prefix, ref.slice(colon + 1)] as const) : ([null, ref] as const)
  })

  const projectsOf = (board: Profile) => projects.list(board.id)

  const project = Effect.fnUntraced(function* (caller: McpCaller, ref: string, profile: string | null) {
    // A name with a colon ("Ops: infra") is a project's on the caller's boards before it's a key on profile Ops's,
    // which they may not even reach.
    if (ref.includes(":")) {
      const picked = yield* Effect.option(pickBoards(caller, profile))
      if (Option.isSome(picked)) {
        const found: Array<readonly [Profile, Project]> = []
        for (const b of picked.value) {
          const named = (yield* projectsOf(b)).find((p) => sameText(p.name, ref))
          if (named !== undefined) found.push([b, named])
        }
        if (found.length > 0) return yield* pickOne(caller, `project ${ref}`, found, (b) => `${b.name}:${ref}`)
      }
    }
    const [prefix, key] = yield* splitRef(ref)
    const bs = yield* pickBoards(caller, prefix ?? profile)
    const byId = yield* projects.get(ProjectId.make(key))
    if (Option.isSome(byId) && bs.some((b) => b.id === byId.value.profile_id)) return byId.value
    const found: Array<readonly [Profile, Project]> = []
    for (const b of bs) {
      const list = yield* projectsOf(b)
      const p = list.find((x) => sameText(x.key, key) || sameText(x.name, key)) ?? list.find((x) => x.former_keys.some((f) => sameText(f, key)))
      if (p !== undefined) found.push([b, p])
    }
    return yield* pickOne(caller, `project ${ref}`, found, (b) => `${b.name}:${key}`)
  })

  const task = Effect.fnUntraced(function* (caller: McpCaller, ref: string, profile: string | null) {
    const [prefix, rest] = yield* splitRef(ref)
    const bs = yield* pickBoards(caller, prefix ?? profile)
    return yield* refs.resolve(rest, { own: caller.profile.id ?? undefined, profiles: bs.map((b) => b.id) }).pipe(
      Effect.catchTags({
        TaskNotFound: () => Effect.fail(ToolError.notFound(`task ${ref}`)),
        TaskRefAmbiguous: (e) =>
          Effect.gen(function* () {
            // On several boards: `<profile>:<key>` names each.
            if (e.candidates.every((c) => c.includes(":"))) {
              return yield* ToolError.other(`task ${ref} is on more than one profile's board: name one of ${e.candidates.join(", ")} (or pass profile)`)
            }
            // Two projects that shared a key before keys were checked: named by id instead.
            const named: Array<string> = []
            for (const id of e.candidates) {
              const t = yield* tasks.get(id)
              const p = t?.project_id == null ? Option.none<Project>() : yield* projects.get(t.project_id)
              named.push(`${t?.title ?? "?"} (id ${id}, in ${Option.match(p, { onNone: () => "?", onSome: (x) => x.name })})`)
            }
            return yield* ToolError.other(`task ${ref} could be more than one task: ${named.join(", ")}; name it by its id`)
          }),
      }),
    )
  })

  const projectOrOwn = Effect.fnUntraced(function* (caller: McpCaller, ref: string | null, profile: string | null) {
    if (ref !== null) return yield* project(caller, ref, profile)
    const own = profile === null ? (caller.task?.project_id ?? null) : null
    if (own === null) return yield* ToolError.other("project_id is required (use list_projects)")
    const found = yield* projects.get(own)
    if (Option.isNone(found)) return yield* ToolError.notFound(`project ${own}`)
    return found.value
  })

  const profile = (id: Profile["id"]) => Effect.map(profiles.get(id), Option.getOrNull)

  const reach: Reach = { boards, pickBoards, ownBoards, project, task, projectOrOwn, profile, hostName }
  return reach
})
