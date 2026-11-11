import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import type { SkillSourceSynced } from "@huntaway/contracts"
import { git, tempDir, TestBoard } from "@huntaway/testing"
import { Actor } from "../platform/Changes.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { AgentTools } from "./AgentTools.ts"
import { AgentToolsRepo } from "./AgentToolsRepo.ts"

// huntaway's agent/agent_tools/sources/tests.test.ts: adds_updates_and_removes_a_skill_source,
// a_source_whose_skills_names_are_taken_isnt_added, a_source_whose_skills_swap_or_pass_on_names_keeps_them,
// a_source_can_take_its_skills_from_a_subfolder. Local git repositories, never the network.

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name}.\n`

const write = (path: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    yield* fs.writeFileString(path, content)
  }).pipe(Effect.orDie)

/** A new repository in a temp folder, its files written and committed. */
const repoWith = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = `${yield* tempDir}/repo`
    yield* (yield* FileSystem.FileSystem).makeDirectory(dir, { recursive: true }).pipe(Effect.orDie)
    yield* git(dir, ["init", "-q", "-b", "main"])
    for (const [path, content] of Object.entries(files)) yield* write(`${dir}/${path}`, content)
    yield* git(dir, ["add", "-A"])
    yield* git(dir, ["commit", "-q", "-m", "init"])
    return dir
  })

const commit = (dir: string, message: string) => Effect.andThen(git(dir, ["add", "-A"]), git(dir, ["commit", "-q", "-m", message]))

const tag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) => Effect.map(Effect.flip(effect), (e) => e._tag)

const ids = (s: SkillSourceSynced) => s.skills.map((k) => [k.name, k.id])

const board = Effect.gen(function* () {
  const profile = (yield* (yield* Profiles).create({ name: "p" })).id
  const project = yield* (yield* Projects).create({ profile_id: profile, name: "x", key: "X", repo_path: `${yield* tempDir}/x` })
  const task = yield* (yield* Tasks).create({ project_id: project.id, title: "A" }, Actor.user)
  return { profile, project: project.id, task }
})

describe("skill sources", () => {
  it.effect("adds, updates and removes a source; its skills keep their switches and a run gets the whole folder", () =>
    Effect.gen(function* () {
      const tools = yield* AgentTools
      const repo = yield* AgentToolsRepo
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* DataDir
      const source = yield* repoWith({
        "SKILL.md": skillMd("ste-writer", "Writes in STE"),
        "scripts/lint.py": "print('lint')\n",
        "references/rules.md": "rules\n",
      })
      const clones = dataDir.file("skill-sources")
      const { profile, project, task } = yield* board

      // Added, its skill is off everywhere.
      let v: SkillSourceSynced = yield* tools.addSource({ url: source })
      const sourceId = v.source.id
      const skillId = v.skills[0]?.id ?? ""
      assert.strictEqual(v.source.name, "repo")
      assert.strictEqual(v.skills[0]?.name, "ste-writer")
      assert.strictEqual(v.skills[0]?.source_id, sourceId)
      assert.strictEqual(v.skills[0]?.description, "Writes in STE")
      assert.isTrue(yield* fs.exists(`${clones}/${sourceId}/scripts/lint.py`))
      assert.isFalse(yield* fs.exists(`${clones}/${sourceId}.new`))
      // Not twice, not with a ref that isn't there, and not with something that isn't a repository.
      assert.strictEqual(yield* tag(tools.addSource({ url: source })), "ToolConflict")
      assert.strictEqual(yield* tag(tools.addSource({ url: source, ref: "nope" })), "SourceFailed")
      assert.strictEqual(yield* tag(tools.addSource({ url: "ext::sh -c id" })), "ToolInvalid")
      assert.strictEqual(yield* tag(tools.addSource({ url: yield* tempDir })), "SourceFailed")
      assert.strictEqual((yield* repo.sources).length, 1)

      // A project of a profile switched on for it runs with the skill's whole folder.
      const skillsDir = `${dataDir.projectDir(project)}/agent/.claude/skills/ste-writer`
      assert.isNull((yield* tools.forRun(task)).skills_dir)
      yield* tools.setSwitch({ scope: "profile", scope_id: profile, source_id: sourceId, enabled: true })
      assert.isTrue((yield* repo.switches("profile", profile))[skillId])
      assert.isNotNull((yield* tools.forRun(task)).skills_dir)
      assert.strictEqual(yield* fs.readFileString(`${skillsDir}/scripts/lint.py`), "print('lint')\n")
      assert.strictEqual(yield* fs.readFileString(`${skillsDir}/references/rules.md`), "rules\n")
      assert.isFalse(yield* fs.exists(`${skillsDir}/.git`))
      // The project can turn it off.
      yield* tools.setSwitch({ scope: "project", scope_id: project, item_id: skillId, enabled: false })
      assert.isNull((yield* tools.forRun(task)).skills_dir)
      yield* tools.setSwitch({ scope: "project", scope_id: project, item_id: skillId, enabled: null })
      assert.strictEqual(yield* tag(tools.setSwitch({ scope: "profile", scope_id: profile, source_id: "missing", enabled: true })), "ToolNotFound")

      // A source's skill is changed in its repository, not by itself.
      assert.strictEqual(yield* tag(tools.updateSkill(null, skillId, { content: skillMd("ste-writer", "mine") })), "ToolInvalid")
      assert.strictEqual(yield* tag(tools.removeSkill(null, skillId)), "ToolInvalid")
      assert.strictEqual(yield* tag(tools.addSkill(null, { content: skillMd("ste-writer", "x") })), "ToolConflict")

      // The repository changes: a changed script and skill, and a file less.
      yield* write(`${source}/scripts/lint.py`, "print('lint 2')\n")
      yield* fs.remove(`${source}/references/rules.md`)
      yield* write(`${source}/SKILL.md`, skillMd("ste-writer", "Writes better"))
      yield* commit(source, "more")
      v = yield* tools.updateSource(sourceId)
      assert.strictEqual(v.skills.length, 1)
      assert.strictEqual(v.skills[0]?.id, skillId, "the skill keeps its id, and so its switches")
      assert.strictEqual(v.skills[0]?.description, "Writes better")
      assert.isNull(v.source.error)
      yield* tools.forRun(task)
      assert.strictEqual(yield* fs.readFileString(`${skillsDir}/scripts/lint.py`), "print('lint 2')\n")
      assert.isFalse(yield* fs.exists(`${skillsDir}/references/rules.md`))

      // The repository goes away: the update fails, and what was there stays.
      const moved = `${source}-moved`
      yield* fs.rename(source, moved)
      assert.strictEqual(yield* tag(tools.updateSource(sourceId)), "SourceFailed")
      const failed = yield* repo.source(sourceId)
      assert.isTrue(failed?.error?.includes("couldn't clone"), String(failed?.error))
      assert.strictEqual((yield* repo.skillsOfSource(sourceId)).length, 1)
      assert.isTrue(yield* fs.exists(`${clones}/${sourceId}/scripts/lint.py`))
      assert.isFalse(yield* fs.exists(`${clones}/${sourceId}.new`))
      yield* fs.rename(moved, source)

      // The skill's folder moves, as it does once a repository has a second skill: the same skill, with its switches.
      yield* fs.makeDirectory(`${source}/skills/ste-writer`, { recursive: true })
      for (const entry of ["SKILL.md", "scripts"]) yield* git(source, ["mv", entry, `skills/ste-writer/${entry}`])
      yield* git(source, ["commit", "-q", "-m", "move"])
      v = yield* tools.updateSource(sourceId)
      assert.strictEqual(v.skills.length, 1)
      assert.strictEqual(v.skills[0]?.id, skillId)
      assert.deepStrictEqual(v.source.notes, [])
      assert.isTrue((yield* repo.switches("profile", profile))[skillId])
      yield* tools.forRun(task)
      assert.strictEqual(yield* fs.readFileString(`${skillsDir}/scripts/lint.py`), "print('lint 2')\n")

      // The skill goes from the repository and a new one comes: the old one is removed with its switches.
      yield* git(source, ["rm", "-rq", "skills/ste-writer"])
      yield* write(`${source}/skills/fresh/SKILL.md`, skillMd("fresh", "New"))
      yield* commit(source, "restructure")
      v = yield* tools.updateSource(sourceId)
      assert.deepStrictEqual(
        v.skills.map((s) => s.name),
        ["fresh"],
      )
      assert.deepStrictEqual(yield* repo.switches("profile", profile), {})
      assert.isNull((yield* tools.forRun(task)).skills_dir)
      assert.isFalse(yield* fs.exists(skillsDir))

      // Removing the source takes its skills and clone.
      yield* tools.removeSource(sourceId)
      assert.deepStrictEqual(yield* repo.sources, [])
      assert.deepStrictEqual(yield* repo.skills(null), [])
      assert.isFalse(yield* fs.exists(`${clones}/${sourceId}`))
      assert.strictEqual(yield* tag(tools.removeSource(sourceId)), "ToolNotFound")
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  it.effect("doesn't add a source whose skills' names are taken", () =>
    Effect.gen(function* () {
      const tools = yield* AgentTools
      const fs = yield* FileSystem.FileSystem
      yield* tools.addSkill(null, { content: skillMd("ste-writer", "mine") })
      const source = yield* repoWith({ "SKILL.md": skillMd("ste-writer", "Writes in STE") })
      const e = yield* Effect.flip(tools.addSource({ url: source }))
      assert.strictEqual(e._tag, "ToolInvalid")
      const reason = e._tag === "ToolInvalid" ? e.reason : ""
      assert.isTrue(reason.includes("no skills found") && reason.includes("already on this host"), reason)
      assert.deepStrictEqual(yield* (yield* AgentToolsRepo).sources, [])
      const clones = (yield* DataDir).file("skill-sources")
      assert.deepStrictEqual(yield* fs.readDirectory(clones).pipe(Effect.orElseSucceed(() => [])), [])
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  /** A source's skills trade names, or pass them along, in one commit: they stay the same skills, with their switches. */
  it.effect("keeps a source's skills that swap or pass on names", () =>
    Effect.gen(function* () {
      const tools = yield* AgentTools
      const repo = yield* AgentToolsRepo
      const source = yield* repoWith(Object.fromEntries(["alpha", "beta", "gamma"].map((n) => [`skills/${n}/SKILL.md`, skillMd(n, n)])))
      let v = yield* tools.addSource({ url: source })
      const before = new Map(v.skills.map((k) => [k.name, k.id]))
      const profile = (yield* (yield* Profiles).create({ name: "p" })).id
      yield* tools.setSwitch({ scope: "profile", scope_id: profile, source_id: v.source.id, enabled: true })
      const rename = (dir: string, name: string) => write(`${source}/skills/${dir}/SKILL.md`, skillMd(name, "renamed"))
      // alpha → beta, beta → gamma (a chain), and gamma → alpha: a cycle.
      yield* rename("alpha", "beta")
      yield* rename("beta", "gamma")
      yield* rename("gamma", "alpha")
      yield* commit(source, "rotate")
      v = yield* tools.updateSource(v.source.id)
      assert.deepStrictEqual(v.source.notes, [])
      // Each folder's skill keeps its id (matched by folder) under its new name.
      assert.deepStrictEqual(ids(v), [
        ["alpha", before.get("gamma")],
        ["beta", before.get("alpha")],
        ["gamma", before.get("beta")],
      ])
      const on = yield* repo.switches("profile", profile)
      assert.isTrue([...before.values()].every((id) => on[id] === true))
      // A swap of two.
      yield* rename("alpha", "alpha")
      yield* rename("gamma", "beta")
      yield* commit(source, "swap")
      v = yield* tools.updateSource(v.source.id)
      assert.deepStrictEqual(v.source.notes, [])
      assert.strictEqual(v.skills.length, 3)
      assert.strictEqual(Object.keys(yield* repo.switches("profile", profile)).length, 3)
      // A name another global skill has still leaves out the one that wants it, and only that one.
      yield* tools.addSkill(null, { content: skillMd("delta", "mine") })
      yield* rename("alpha", "delta")
      yield* commit(source, "clash")
      v = yield* tools.updateSource(v.source.id)
      assert.strictEqual(v.skills.length, 2)
      assert.isTrue(v.source.notes[0]?.includes("already on this host"))
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  /** A repository with the same skills in two languages, each in a folder of its own, like Deep-Research-skills (HA-311). */
  it.effect("takes a source's skills from a subfolder", () =>
    Effect.gen(function* () {
      const tools = yield* AgentTools
      const fs = yield* FileSystem.FileSystem
      const files: Record<string, string> = {}
      for (const lang of ["en", "zh"]) {
        for (const name of ["research", "research-deep"]) files[`skills/research-${lang}/${name}/SKILL.md`] = skillMd(name, `${name} in ${lang}`)
        files[`skills/research-${lang}/research/scripts/run.sh`] = `echo ${lang}\n`
      }
      const source = yield* repoWith(files)
      // Only the Chinese ones.
      const v = yield* tools.addSource({ url: source, subdir: "skills/research-zh/" })
      assert.strictEqual(v.source.subdir, "skills/research-zh")
      assert.deepStrictEqual(
        v.skills.map((s) => [s.name, s.description]),
        [
          ["research", "research in zh"],
          ["research-deep", "research-deep in zh"],
        ],
      )
      assert.deepStrictEqual(v.source.notes, [])
      // Not twice, not a folder that isn't there, and not a link out of the clone.
      assert.strictEqual(yield* tag(tools.addSource({ url: source, subdir: "skills/research-zh" })), "ToolConflict")
      assert.strictEqual(yield* tag(tools.addSource({ url: source, subdir: "skills/research-fr" })), "SourceFailed")
      yield* fs.symlink(`${source}/skills`, `${source}/linked`)
      yield* commit(source, "link")
      assert.strictEqual(yield* tag(tools.addSource({ url: source, subdir: "linked/research-en" })), "SourceFailed")
      assert.strictEqual((yield* (yield* AgentToolsRepo).sources).length, 1)
      // An update keeps to the subfolder.
      yield* write(`${source}/skills/research-zh/research/SKILL.md`, skillMd("research", "updated in zh"))
      yield* write(`${source}/skills/research-en/research-report/SKILL.md`, skillMd("research-report", "report in en"))
      yield* commit(source, "more")
      const u = yield* tools.updateSource(v.source.id)
      assert.deepStrictEqual(
        u.skills.map((s) => [s.name, s.description]),
        [
          ["research", "updated in zh"],
          ["research-deep", "research-deep in zh"],
        ],
      )
      const clone = `${(yield* DataDir).file("skill-sources")}/${v.source.id}`
      assert.strictEqual(yield* fs.readFileString(`${clone}/skills/research-zh/research/scripts/run.sh`), "echo zh\n")
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )
})
