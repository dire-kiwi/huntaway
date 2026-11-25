import { Effect } from "effect"
import type { FileSystem } from "effect"
import type { Project, Profile, Task, TaskSkill } from "@huntaway/contracts"
import { BUILT_IN_OUTPUT_STYLES } from "@huntaway/shared"
import { frontmatter } from "./validation.ts"

// A Claude task's output styles (HE-102; docs/plan/07-agents.md, Output styles), for the composer's `/output-style`
// menu: those Claude Code listed when the task's last run started (the `initialize` answer's
// `available_output_styles`: its built-in ones, the user's, the project's and the plugins'), or before any run has, its
// built-in ones and the user's and the project's files. Descriptions come from the files' frontmatter.

/** The built-in styles of Claude Code 2.1, with their descriptions: what a task has before any run lists them. */
export const BUILT_IN_STYLES: ReadonlyArray<TaskSkill> = BUILT_IN_OUTPUT_STYLES

/** What a run's `initialize` answer said of output styles. */
export interface ReportedStyles {
  /** The style its settings gave it. */
  readonly current: string | null
  readonly available: ReadonlyArray<string>
}

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

/** The output styles in Claude Code's answer to the board's `initialize`, if it lists them. */
export const reportedStyles = (response: unknown): ReportedStyles | null => {
  if (!isRecord(response)) return null
  const list = response["available_output_styles"]
  if (!Array.isArray(list)) return null
  const current = response["output_style"]
  return { current: typeof current === "string" ? current : null, available: list.filter((s): s is string => typeof s === "string" && s !== "") }
}

/**
 * The styles in `dirs`' `*.md` files (a config folder's `output-styles`, a project's `.claude/output-styles`), named by
 * their frontmatter's `name` or else the file's name; a later folder's replaces an earlier's of the same name, as in
 * Claude Code.
 */
export const fileStyles = (fs: FileSystem.FileSystem, dirs: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<TaskSkill>> =>
  Effect.gen(function* () {
    const out = new Map<string, TaskSkill>()
    for (const dir of dirs) {
      const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): Array<string> => []))
      for (const file of names.toSorted()) {
        if (!file.endsWith(".md") || file.startsWith(".")) continue
        const text = yield* fs.readFileString(`${dir}/${file}`).pipe(Effect.orElseSucceed(() => null))
        if (text === null) continue
        const f = frontmatter(text)
        const name = f !== null && f.name !== "" ? f.name : file.slice(0, -".md".length)
        out.delete(name)
        out.set(name, { name, description: f?.description ?? "" })
      }
    }
    return [...out.values()]
  })

/** The menu's styles: those Claude Code reported, in its order, else the built-in ones and the files'. */
export const outputStyles = (reported: ReportedStyles | null, files: ReadonlyArray<TaskSkill>): ReadonlyArray<TaskSkill> => {
  const known = [...BUILT_IN_STYLES, ...files]
  const described = (name: string): TaskSkill => known.findLast((s) => s.name === name) ?? { name, description: "" }
  if (reported !== null && reported.available.length > 0) return [...new Set(reported.available)].map(described)
  const names = [...new Set(known.map((s) => s.name))]
  return names.map(described)
}

/** The style named `name` (any case) among `styles`, as Claude Code spells it; null if none is. */
export const styleNamed = (styles: ReadonlyArray<TaskSkill>, name: string): string | null => {
  const exact = styles.find((s) => s.name === name)
  if (exact !== undefined) return exact.name
  const lower = name.toLowerCase()
  return styles.find((s) => s.name.toLowerCase() === lower)?.name ?? null
}

const named = (s: string | null | undefined): string | null => (s != null && s.trim() !== "" ? s.trim() : null)

/**
 * HE-111: the style a task's runs are given, and whose it is: its own (`/output-style`), else its project's, else its
 * profile's; null leaves it to Claude Code's settings. A review thread (a reviewer's, a summarizer's) takes only its
 * own, as its report is read by the board and the user, not taught or explained to.
 */
export const styleOf = (
  task: Pick<Task, "kind" | "output_style">,
  project: Pick<Project, "output_style"> | null,
  profile: Pick<Profile, "default_output_style"> | null,
): { readonly style: string; readonly from: "task" | "project" | "profile" } | null => {
  const own = named(task.output_style)
  if (own !== null) return { style: own, from: "task" }
  if (task.kind === "review") return null
  const ofProject = named(project?.output_style)
  if (ofProject !== null) return { style: ofProject, from: "project" }
  const ofProfile = named(profile?.default_output_style)
  return ofProfile === null ? null : { style: ofProfile, from: "profile" }
}

/** The style a task's runs are given (`styleOf`), or null for Claude Code's settings'. */
export const launchStyle = (...args: Parameters<typeof styleOf>): string | null => styleOf(...args)?.style ?? null
