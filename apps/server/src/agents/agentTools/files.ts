import { Effect, Option, Schema } from "effect"
import type { FileSystem } from "effect"
import type { SkillRow } from "./effective.ts"
import { checkSkill } from "./validation.ts"

// The agent tools' files (huntaway's agent/agent_tools/sources.ts `discover`/`copy_skill` and runs.ts `sync_skills`):
// finding the skills in a clone, copying a skill's folder to a run's, and keeping a skills folder to exactly the skills
// a run has. Links are never followed or copied; files that are already right are left alone (other agents may be
// reading them). Each takes the `FileSystem` its service has.

/** Something went wrong with a skill source: the clone, or (a subfolder that isn't there) what it holds. */
export class SourceFailed extends Schema.TaggedError<SourceFailed, { readonly brand: unique symbol }>()("SourceFailed", { reason: Schema.String }) {}

/** How deep in a repository to look for skills, and how many to take from one. */
export const MAX_DEPTH = 6
export const MAX_SKILLS = 200
/** The most a skill's folder may hold, and the most a `SKILL.md` may be. */
export const MAX_SKILL_BYTES = 25 << 20
export const MAX_SKILL_MD = 256 << 10

/** The hidden folders a repository may keep skills in (others' mirrors of them). */
const HIDDEN_OK: ReadonlySet<string> = new Set([".claude", ".agents", ".codex"])

/** A skill in a clone. */
export interface Found {
  /** Its folder relative to the clone's root, with `/`s ("" for the root). */
  readonly path: string
  readonly name: string
  readonly content: string
}

type Fs = FileSystem.FileSystem

const lstat = (fs: Fs, path: string) => fs.lstat(path).pipe(Effect.option)
const isDirectory = (fs: Fs, path: string) => Effect.map(lstat(fs, path), (i) => Option.isSome(i) && i.value.type === "Directory")
const isFile = (fs: Fs, path: string) => Effect.map(lstat(fs, path), (i) => Option.isSome(i) && i.value.type === "File")
const list = (fs: Fs, dir: string) => fs.readDirectory(dir).pipe(Effect.orElseSucceed((): Array<string> => []))
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** The size of the files in a folder, not following links (stops counting past `MAX_SKILL_BYTES`). */
const folderSize = (fs: Fs, dir: string): Effect.Effect<number> =>
  Effect.gen(function* () {
    let total = 0
    for (const name of yield* list(fs, dir)) {
      const info = yield* lstat(fs, `${dir}/${name}`)
      if (Option.isNone(info)) continue
      if (info.value.type === "Directory" && name !== ".git") total += yield* folderSize(fs, `${dir}/${name}`)
      else if (info.value.type === "File") total += Number(info.value.size)
      if (total > MAX_SKILL_BYTES) break
    }
    return total
  })

/** A folder's `SKILL.md`, checked: its name and content, or why it isn't a skill. */
const readSkill = (fs: Fs, dir: string) =>
  Effect.gen(function* () {
    const file = `${dir}/SKILL.md`
    const info = yield* lstat(fs, file)
    if (Option.isSome(info) && Number(info.value.size) > MAX_SKILL_MD) return { why: "its SKILL.md is too big" } as const
    const bytes = yield* fs.readFile(file).pipe(Effect.option)
    if (Option.isNone(bytes)) return { why: "its SKILL.md can't be read" } as const
    const text = yield* Effect.try({ try: () => utf8.decode(bytes.value), catch: () => null }).pipe(Effect.option)
    if (Option.isNone(text)) return { why: "its SKILL.md isn't text" } as const
    const content = text.value
    const checked = checkSkill(content)
    if (checked._tag === "Failure") return { why: checked.failure.reason } as const
    if ((yield* folderSize(fs, dir)) > MAX_SKILL_BYTES) return { why: `its folder is bigger than ${MAX_SKILL_BYTES >> 20} MB` } as const
    return { name: checked.success.name, content } as const
  })

/**
 * The skills in a clone (or in its folder `subdir`, a checked path), and what was left out. A folder with a `SKILL.md`
 * is a skill and its folders belong to it; other folders are looked into, to `MAX_DEPTH` (not `.git`, `node_modules` or
 * hidden folders other than `.claude`, `.agents` and `.codex`). When a name turns up twice the first is taken, with
 * visible folders ahead of hidden ones.
 */
export const discover = (fs: Fs, root: string, subdir: string | null = null) =>
  Effect.gen(function* () {
    const found: Array<Found> = []
    const notes: Array<string> = []
    const walk = (dir: string, rel: string, depth: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const label = rel === "" ? "the repository's root" : rel
        if (yield* isFile(fs, `${dir}/SKILL.md`)) {
          if (found.length >= MAX_SKILLS) {
            const note = `only the first ${MAX_SKILLS} skills are taken`
            if (!notes.includes(note)) notes.push(note)
            return
          }
          const skill = yield* readSkill(fs, dir)
          if ("why" in skill) notes.push(`${label}: ${skill.why}`)
          else if (found.some((f) => f.name === skill.name)) notes.push(`${label}: another skill is named ${skill.name}`)
          else found.push({ path: rel, name: skill.name, content: skill.content })
          return
        }
        if (depth >= MAX_DEPTH) return
        const subs: Array<readonly [boolean, string]> = []
        for (const name of yield* list(fs, dir)) {
          if (name === ".git" || name === "node_modules" || (name.startsWith(".") && !HIDDEN_OK.has(name))) continue
          if (yield* isDirectory(fs, `${dir}/${name}`)) subs.push([name.startsWith("."), name])
        }
        subs.sort((a, b) => (a[0] !== b[0] ? (a[0] ? 1 : -1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
        for (const [, name] of subs) yield* walk(`${dir}/${name}`, rel === "" ? name : `${rel}/${name}`, depth + 1)
      })
    if (subdir !== null) {
      // Each step a folder, not a link, so the skills can't come from outside the clone.
      let dir = root
      for (const part of subdir.split("/")) {
        dir = `${dir}/${part}`
        if (!(yield* isDirectory(fs, dir))) return yield* new SourceFailed({ reason: `the repository has no folder ${subdir}` })
      }
      yield* walk(dir, subdir, 0)
    } else yield* walk(root, "", 0)
    return { found, notes } as const
  })

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Makes `to` hold the same files as the skill folder `from`, leaving files that are already right alone. Links are
 * skipped, so a repository can't make a run's folder show files from elsewhere, and so is `.git`. A change that is
 * only to a script's permissions reaches the copy.
 */
export const copySkill = (fs: Fs, from: string, to: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const there = yield* lstat(fs, to)
    if (Option.isSome(there) && there.value.type !== "Directory") yield* fs.remove(to).pipe(Effect.ignore)
    yield* fs.makeDirectory(to, { recursive: true }).pipe(Effect.ignore)
    const kind = (name: string) =>
      name === ".git" ? Effect.succeed(null) : Effect.map(lstat(fs, `${from}/${name}`), (i) => (Option.isSome(i) ? i.value.type : null))
    for (const name of yield* list(fs, to)) {
      const k = yield* kind(name)
      if (k !== "File" && k !== "Directory") yield* fs.remove(`${to}/${name}`, { recursive: true }).pipe(Effect.ignore)
    }
    for (const name of yield* list(fs, from)) {
      const k = yield* kind(name)
      const src = `${from}/${name}`
      const dst = `${to}/${name}`
      if (k === "Directory") {
        yield* copySkill(fs, src, dst)
        continue
      }
      if (k !== "File") continue
      const d = yield* lstat(fs, dst)
      if (Option.isSome(d) && d.value.type !== "File") yield* fs.remove(dst, { recursive: true }).pipe(Effect.ignore)
      const srcInfo = yield* fs.stat(src).pipe(Effect.option)
      if (Option.isNone(srcInfo)) continue
      const want = srcInfo.value.mode & 0o7777
      const [a, b] = yield* Effect.all([fs.readFile(src).pipe(Effect.option), fs.readFile(dst).pipe(Effect.option)], { concurrency: 1 })
      if (Option.isSome(a) && Option.isSome(b) && sameBytes(a.value, b.value)) {
        const dstInfo = yield* fs.stat(dst).pipe(Effect.option)
        if (Option.isSome(dstInfo) && (dstInfo.value.mode & 0o777) !== (want & 0o777)) yield* fs.chmod(dst, want).pipe(Effect.ignore)
        continue
      }
      yield* fs.copyFile(src, dst).pipe(Effect.ignore)
      yield* fs.chmod(dst, want).pipe(Effect.ignore)
    }
  })

/**
 * Makes `dir` hold exactly these skills. A skill from a source is its whole folder in the clone (under `sources`); one
 * that isn't, or whose clone has gone (the next update brings it back), is its saved `SKILL.md`.
 */
export const syncSkills = (fs: Fs, dir: string, skills: ReadonlyArray<SkillRow>, sources: string) =>
  Effect.gen(function* () {
    for (const name of yield* list(fs, dir)) {
      if (!skills.some((s) => s.name === name)) yield* fs.remove(`${dir}/${name}`, { recursive: true }).pipe(Effect.ignore)
    }
    for (const s of skills) {
      if (s.source_id !== null && s.source_path !== null) {
        const from = s.source_path === "" ? `${sources}/${s.source_id}` : `${sources}/${s.source_id}/${s.source_path}`
        if (yield* isFile(fs, `${from}/SKILL.md`)) {
          yield* copySkill(fs, from, `${dir}/${s.name}`)
          continue
        }
      }
      const file = `${dir}/${s.name}/SKILL.md`
      const current = yield* fs.readFileString(file).pipe(Effect.option)
      if (Option.isSome(current) && current.value === s.content) continue
      yield* fs.makeDirectory(`${dir}/${s.name}`, { recursive: true }).pipe(Effect.ignore)
      yield* fs.writeFileString(file, s.content).pipe(Effect.ignore)
    }
  })
