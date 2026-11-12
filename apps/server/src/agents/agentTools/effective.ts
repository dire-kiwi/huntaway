import type { McpServer, SeenTools, Skill, TaskSkill } from "@huntaway/contracts"
import { frontmatter, isBoardServer } from "./validation.ts"

// What is on where (huntaway's agent/agent_tools/runs.ts `effective*`, task_skills.ts' list rules, `record_seen`): plain
// functions over the rows `AgentToolsRepo` reads.

/** A skill's row: the wire's, with its folder in its source's clone ("" for the root). */
export interface SkillRow extends Skill {
  readonly source_path: string | null
}

/** Everything that decides what is on for a project's runs, or (`project` false) a profile's runs in no project. */
export interface Inventory {
  readonly project: boolean
  /** The project's own (none for a profile). */
  readonly ownSkills: ReadonlyArray<SkillRow>
  readonly ownServers: ReadonlyArray<McpServer>
  readonly globalSkills: ReadonlyArray<SkillRow>
  readonly globalServers: ReadonlyArray<McpServer>
  /** The profile's defaults, by item id (unset: off). */
  readonly profileSwitches: Readonly<Record<string, boolean>>
  /** The project's overrides, by item id (unset: the profile's). */
  readonly projectSwitches: Readonly<Record<string, boolean>>
}

export interface Effective {
  readonly skills: ReadonlyArray<SkillRow>
  readonly servers: ReadonlyArray<McpServer>
}

/** The global MCP server for the assistant's Google account (6.7): a project's agents never get it, whatever switches say. */
export const GOOGLE_SERVER = "google"

/** Whether a global item is on: the project's override, else the profile's default, else off. */
export const switchedOn = (inv: Pick<Inventory, "profileSwitches" | "projectSwitches">, id: string): boolean =>
  (Object.hasOwn(inv.projectSwitches, id) ? inv.projectSwitches[id] : Object.hasOwn(inv.profileSwitches, id) ? inv.profileSwitches[id] : false) === true

/**
 * What's on: a project's own enabled skills and servers, then the global ones switched on for it that don't share a name
 * with them (a project's own one takes the name while it's on), then the board's skills called `extra`, which a review
 * or summary thread has on top whether or not they're on for the project: a project's own one before a global one of
 * that name. A project's own skill switched off for its runs can still be picked for a thread; a global one that's
 * switched off (the item itself) can't.
 */
export const effective = (inv: Inventory, extra: ReadonlyArray<string> = []): Effective => {
  const skills: Array<SkillRow> = inv.ownSkills.filter((s) => s.enabled)
  const servers: Array<McpServer> = inv.ownServers.filter((s) => s.enabled)
  for (const g of inv.globalSkills) if (g.enabled && switchedOn(inv, g.id) && !skills.some((s) => s.name === g.name)) skills.push(g)
  for (const g of inv.globalServers) {
    if (inv.project && g.name === GOOGLE_SERVER) continue
    if (g.enabled && switchedOn(inv, g.id) && !servers.some((s) => s.name === g.name)) servers.push(g)
  }
  if (extra.length > 0) {
    const more: Array<SkillRow> = [...inv.ownSkills, ...inv.globalSkills]
    for (const name of extra) {
      const i = more.findIndex((s) => (s.enabled || s.project_id !== null) && s.name === name)
      const found = more[i]
      if (found === undefined) continue
      const at = skills.findIndex((s) => s.name === name)
      if (at >= 0 && skills[at]?.id === found.id) continue
      more.splice(i, 1)
      if (at >= 0) skills[at] = found
      else skills.push(found)
    }
  }
  return { skills, servers }
}

/** The board's own skills for a project that aren't on for it (`on`), by name. */
export const boardSkillsOff = (inv: Inventory, on: ReadonlyArray<SkillRow>): ReadonlyArray<string> =>
  [...inv.ownSkills, ...inv.globalSkills].map((s) => s.name).filter((n) => !on.some((s) => s.name === n))

/** Adds the board's own skills to a task's list, and takes out the ones the project turns off. Sorted, one of each name. */
export const withBoardSkills = (
  found: ReadonlyArray<TaskSkill>,
  board: ReadonlyArray<Skill>,
  isCodex: boolean,
  disabled: ReadonlyArray<string>,
): ReadonlyArray<TaskSkill> => {
  let skills: Array<TaskSkill> = found.map((s) => ({ name: s.name, description: s.description }))
  for (const b of board) {
    // Claude Code turns down `/name` for a skill that isn't `user-invocable`.
    if (!isCodex && frontmatter(b.content)?.user_invocable === false) {
      skills = skills.filter((s) => s.name !== b.name)
      continue
    }
    const at = skills.findIndex((s) => s.name === b.name)
    if (at >= 0) skills[at] = { name: b.name, description: b.description }
    else skills.push({ name: b.name, description: b.description })
  }
  skills = skills.filter((s) => !disabled.includes(s.name))
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return skills.filter((s, i) => i === 0 || skills[i - 1]?.name !== s.name)
}

/** The skills a project's last run with a config reported, rather than all those runs had lately. */
export const lastRunSkills = (seen: SeenTools | null | undefined): ReadonlyArray<string> =>
  seen === null || seen === undefined ? [] : seen.skills.filter((s) => s.at === seen.at).map((s) => s.name)

/**
 * The skills the last run reported less the board's own that aren't on any more: those it gave the run (turned off,
 * renamed or deleted since), and for runs recorded before the board noted those, the ones that are off now.
 */
export const reportedSkills = (seen: SeenTools | null | undefined, on: ReadonlyArray<Skill>, off: ReadonlyArray<string>): ReadonlyArray<string> => {
  const given = seen?.board_skills ?? []
  const gone = (n: string) => !on.some((s) => s.name === n) && (given.includes(n) || off.includes(n))
  return lastRunSkills(seen).filter((n) => !gone(n))
}

/** How long something a run had stays listed after runs stop reporting it. */
export const SEEN_DAYS = 14

/** What a run's `init` line lists, as read. */
export interface InitTools {
  readonly skills?: unknown
  readonly mcp_servers?: unknown
}

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null && !Array.isArray(v)
const strOrNull = (v: unknown) => (typeof v === "string" ? v : null)

/**
 * What a project's runs with a config had, after a run's `init` at `at` (an ISO time; `cutoff` is `SEEN_DAYS` before):
 * what it reports, and what earlier runs had that it doesn't, while recent, sorted by name. The board's servers are
 * left out; `board` is the board's own skills the run was given.
 */
export const mergeSeen = (before: SeenTools | undefined, init: InitTools, board: ReadonlyArray<string>, at: string, cutoff: string): SeenTools => {
  const merge = <T extends { readonly name: string | null; readonly at: string }>(fresh: ReadonlyArray<T>, old: ReadonlyArray<T>): Array<T> => {
    const all = [...fresh]
    for (const o of old) if (o.at > cutoff && !all.some((v) => v.name === o.name)) all.push(o)
    return all.toSorted((a, b) => (a.name === b.name ? 0 : a.name === null ? -1 : b.name === null ? 1 : a.name < b.name ? -1 : 1))
  }
  const skills = (Array.isArray(init.skills) ? init.skills : []).filter((s): s is string => typeof s === "string").map((name) => ({ name, at }))
  const servers = (Array.isArray(init.mcp_servers) ? init.mcp_servers : [])
    .filter((s) => !(isObject(s) && typeof s["name"] === "string" && isBoardServer(s["name"])))
    .map((s) => ({
      name: isObject(s) ? strOrNull(s["name"]) : null,
      status: isObject(s) ? strOrNull(s["status"]) : null,
      source: isObject(s) ? strOrNull(s["source"]) : null,
      at,
    }))
  return { skills: merge(skills, before?.skills ?? []), mcp_servers: merge(servers, before?.mcp_servers ?? []), board_skills: board, at }
}

/** `seen` with the skill `name` forgotten from every config's lists (a board skill renamed or deleted). */
export const forgetSkill = (seen: Readonly<Record<string, SeenTools>>, name: string): Record<string, SeenTools> =>
  Object.fromEntries(
    Object.entries(seen).map(([key, s]) => [
      key,
      {
        skills: s.skills.filter((v) => v.name !== name),
        mcp_servers: s.mcp_servers,
        ...(s.board_skills === undefined ? {} : { board_skills: s.board_skills.filter((n) => n !== name) }),
        at: s.at,
      },
    ]),
  )
