import { Effect, Option, Schema } from "effect"
import type { FileSystem } from "effect"
import type { TaskSkill } from "@huntaway/contracts"
import { frontmatter } from "./validation.ts"

// A Claude task's skills for the composer's `/` menu (huntaway's agent/agent_tools/task_skills.ts `claude_skills`): the
// ones its last run reported, which are the ones a user can call, and the folders' skills, which `/<folder>` calls, so
// a task has them before any run has reported them. Descriptions come from the `SKILL.md`s, also those of synced skills
// and installed plugins' (skills bundled with Claude Code have none).

type Fs = FileSystem.FileSystem

/** A skill in a folder, from its `SKILL.md`. */
interface FoundSkill {
  /** `<prefix><folder>`, the name that always calls it, or for an alias its frontmatter's `name`. */
  readonly name: string
  /** Its frontmatter's `name`, if that's another (see `addAliases`). */
  readonly otherName: string | null
  /** Found by its frontmatter's `name`: not listed by itself. */
  readonly alias: boolean
  readonly description: string
  readonly userInvocable: boolean
}

const subdirs = (fs: Fs, dir: string) =>
  Effect.gen(function* () {
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): Array<string> => []))
    const out: Array<string> = []
    for (const n of names.toSorted()) {
      const info = yield* fs.stat(`${dir}/${n}`).pipe(Effect.option)
      if (Option.isSome(info) && info.value.type === "Directory") out.push(n)
    }
    return out
  })

/** The skills in `dir` (folders with a `SKILL.md`), looking `depth` folders down, named `<prefix><folder>`. */
const findSkills = (fs: Fs, dir: string, depth: number, prefix: string, out: Array<FoundSkill>): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const folder of yield* subdirs(fs, dir)) {
      if (folder.startsWith(".") || folder === "node_modules") continue
      const path = `${dir}/${folder}`
      const content = yield* fs.readFileString(`${path}/SKILL.md`).pipe(Effect.option)
      if (Option.isSome(content)) {
        const name = `${prefix}${folder}`
        if (out.some((f) => f.name === name)) continue
        const f = frontmatter(content.value)
        // A plugin's skill may name itself with the plugin's prefix already.
        const alias = f !== null && f.name !== "" ? (f.name.startsWith(prefix) ? f.name : `${prefix}${f.name}`) : null
        out.push({
          otherName: alias !== null && alias !== name ? alias : null,
          name,
          alias: false,
          description: f?.description ?? "",
          userInvocable: f?.user_invocable ?? true,
        })
      } else if (depth > 1) yield* findSkills(fs, path, depth - 1, prefix, out)
    }
  })

/**
 * Claude Code may call a skill by its frontmatter's `name` instead of its folder, unless another skill has that name:
 * adds those names, after all the folders', so a run's name for a skill finds it. They aren't listed by themselves.
 */
const addAliases = (found: Array<FoundSkill>): void => {
  const aliases = found.flatMap((f) =>
    f.otherName === null ? [] : [{ name: f.otherName, otherName: null, alias: true, description: f.description, userInvocable: f.userInvocable }],
  )
  for (const a of aliases) if (!found.some((f) => f.name === a.name)) found.push(a)
}

const Installs = Schema.fromJsonString(
  Schema.Struct({
    plugins: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Array(
          Schema.Struct({
            scope: Schema.optionalKey(Schema.Unknown),
            projectPath: Schema.optionalKey(Schema.Unknown),
            installPath: Schema.optionalKey(Schema.Unknown),
          }),
        ),
      ),
    ),
  }),
)
const decodeInstalls = Schema.decodeUnknownOption(Installs)

/**
 * The plugins installed in a Claude config for the folders a task works in, each with the folder of its installation
 * that applies: one for the project (`local`, then `project`, by `projectPath`) over the user's.
 */
export const installedPlugins = (fs: Fs, configDir: string, places: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const text = yield* fs.readFileString(`${configDir}/plugins/installed_plugins.json`).pipe(Effect.option)
    if (Option.isNone(text)) return []
    const parsed = decodeInstalls(text.value)
    const plugins = Option.isSome(parsed) ? (parsed.value.plugins ?? {}) : {}
    const canonical = (p: string) => fs.realPath(p).pipe(Effect.option)
    const same = (a: string, b: string) =>
      Effect.gen(function* () {
        if (a === b) return true
        const x = yield* canonical(a)
        return Option.isSome(x) && Option.getOrNull(yield* canonical(b)) === x.value
      })
    const out: Array<readonly [string, string]> = []
    for (const id of Object.keys(plugins).toSorted()) {
      const plugin = id.split("@")[0] ?? id
      let best: readonly [number, string] | null = null
      for (const i of plugins[id] ?? []) {
        if (typeof i.installPath !== "string") continue
        const projectPath = i.projectPath
        let here = false
        if (typeof projectPath === "string") for (const d of places) if (!here && (yield* same(projectPath, d))) here = true
        const rank = i.scope === "local" ? (here ? 3 : null) : i.scope === "project" ? (here ? 2 : null) : 1
        if (rank === null) continue
        // The last of the best.
        if (best === null || rank >= best[0]) best = [rank, i.installPath]
      }
      if (best !== null) out.push([plugin, best[1]])
    }
    return out
  })

/**
 * The skills Claude Code has with config folder `configDir` in `dirs` (where it runs and the folders it's given), for
 * the `/` menu: those the last run reported (`lastRun`) and the folders' (`<config>/skills`, `<dir>/.claude/skills`),
 * less one changed since to say a user can't call it (`user-invocable: false`). `repo` is the project's main checkout,
 * which plugins installed for the project name.
 */
export const claudeSkills = (fs: Fs, configDir: string, dirs: ReadonlyArray<string>, repo: string | null, lastRun: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const user = `${configDir}/skills`
    // A personal skill wins over the repository's of the same name, as in Claude Code.
    const own: Array<FoundSkill> = []
    yield* findSkills(fs, user, 1, "", own)
    for (const d of dirs) yield* findSkills(fs, `${d}/.claude/skills`, 1, "", own)
    addAliases(own)
    // A plugin's are `<plugin>:<folder>`, in the installation that applies here.
    const plugins: Array<FoundSkill> = []
    for (const [plugin, path] of yield* installedPlugins(fs, configDir, [...dirs, ...(repo === null ? [] : [repo])])) {
      const found: Array<FoundSkill> = []
      yield* findSkills(fs, `${path}/skills`, 1, `${plugin}:`, found)
      addAliases(found)
      plugins.push(...found)
    }
    // Synced ones are in skills/synced/<bucket>/<folder>, under a plugin name the board can't tell: only descriptions.
    const synced: Array<FoundSkill> = []
    yield* findSkills(fs, `${user}/synced`, 2, "", synced)
    const exact = (n: string) => own.find((f) => f.name === n) ?? plugins.find((f) => f.name === n)
    const describe = (n: string) => {
      const colon = n.lastIndexOf(":")
      const short = colon >= 0 ? n.slice(colon + 1) : null
      const byShort = short === null ? undefined : (synced.find((f) => f.name === short) ?? own.filter((f) => !f.alias).find((f) => f.name === short))
      return (exact(n) ?? byShort)?.description ?? ""
    }
    const folders = own.filter((f) => !f.alias).map((f) => f.name)
    const names = [...new Set([...lastRun, ...folders])].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return names.filter((n) => exact(n)?.userInvocable !== false).map((n): TaskSkill => ({ name: n, description: describe(n) }))
  })
