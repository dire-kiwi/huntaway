import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Option, Schema } from "effect"
import type { Scope } from "effect"
import { git, tempDir } from "@huntaway/testing"
import { copySkill, discover } from "./files.ts"
import { claudeSkills } from "./taskSkills.ts"

// huntaway's agent/agent_tools/sources/tests.test.ts (finds_the_skills_in_a_repository, copies_a_skill_folder_and_keeps_to_it)
// and tests.test.ts (lists_a_claude_tasks_skills), on real folders.

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name}.\n`

const write = (path: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    yield* fs.writeFileString(path, content)
  }).pipe(Effect.orDie)

/** A repository with a skill of its own (with a script) at its root, like asd-ste100-skill. */
const rootSkillRepo = (dir: string) =>
  Effect.gen(function* () {
    yield* (yield* FileSystem.FileSystem).makeDirectory(dir, { recursive: true }).pipe(Effect.orDie)
    yield* git(dir, ["init", "-q", "-b", "main"])
    yield* write(`${dir}/SKILL.md`, skillMd("ste-writer", "Writes in STE"))
    yield* write(`${dir}/scripts/lint.py`, "print('lint')\n")
    yield* write(`${dir}/references/rules.md`, "rules\n")
    yield* git(dir, ["add", "."])
    yield* git(dir, ["commit", "-q", "-m", "init"])
  })

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe("agent tools' files", () => {
  it.effect("finds the skills in a repository", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* tempDir
        yield* write(`${root}/skills/alpha/SKILL.md`, skillMd("alpha", "A"))
        // Inside a skill: part of it.
        yield* write(`${root}/skills/alpha/nested/SKILL.md`, skillMd("inside-alpha", "Belongs to alpha"))
        yield* write(`${root}/skills/beta/SKILL.md`, skillMd("beta", "B"))
        // The same skill mirrored for another agent: the visible folder wins.
        yield* write(`${root}/.claude/skills/alpha/SKILL.md`, skillMd("alpha", "A again"))
        yield* write(`${root}/.claude/skills/gamma/SKILL.md`, skillMd("gamma", "G"))
        yield* write(`${root}/skills/bad/SKILL.md`, "no frontmatter")
        yield* write(`${root}/skills/Upper/SKILL.md`, skillMd("Upper Case", "x"))
        yield* write(`${root}/node_modules/pkg/SKILL.md`, skillMd("from-node-modules", "x"))
        yield* write(`${root}/.git/hooks/SKILL.md`, skillMd("from-git", "x"))
        yield* write(`${root}/.hidden/SKILL.md`, skillMd("from-hidden", "x"))
        const { found, notes } = yield* discover(fs, root)
        assert.deepStrictEqual(
          found.map((f) => [f.path, f.name]),
          [
            ["skills/alpha", "alpha"],
            ["skills/beta", "beta"],
            [".claude/skills/gamma", "gamma"],
          ],
        )
        assert.strictEqual(found[0]?.content, skillMd("alpha", "A"))
        assert.isTrue(
          notes.some((n) => n.startsWith("skills/bad:")),
          String(notes),
        )
        assert.isTrue(
          notes.some((n) => n.startsWith("skills/Upper:")),
          String(notes),
        )
        assert.isTrue(
          notes.some((n) => n.startsWith(".claude/skills/alpha:") && n.includes("another skill is named alpha")),
          String(notes),
        )
        assert.strictEqual(notes.length, 3)

        // A skill at the root owns the whole repository.
        const single = `${yield* tempDir}/repo`
        yield* rootSkillRepo(single)
        const one = yield* discover(fs, single)
        assert.deepStrictEqual(
          one.found.map((f) => [f.path, f.name]),
          [["", "ste-writer"]],
        )
        assert.deepStrictEqual(one.notes, [])

        // A link to a SKILL.md elsewhere isn't a skill, and a linked folder isn't looked into.
        const linked = yield* tempDir
        yield* fs.makeDirectory(`${linked}/s`)
        yield* write(`${linked}/elsewhere/SKILL.md`, skillMd("linked", "x"))
        yield* fs.symlink(`${linked}/elsewhere/SKILL.md`, `${linked}/s/SKILL.md`)
        yield* fs.symlink(`${linked}/elsewhere`, `${linked}/dir-link`)
        assert.deepStrictEqual(
          (yield* discover(fs, linked)).found.map((f) => f.path),
          ["elsewhere"],
        )
        // A subfolder that isn't there (or is a link out of the clone) fails.
        assert.strictEqual((yield* Effect.flip(discover(fs, linked, "dir-link")))._tag, "SourceFailed")
      }),
    ),
  )

  it.effect("copies a skill's folder and keeps to it", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* tempDir
        const from = `${root}/from`
        const to = `${root}/to`
        yield* write(`${from}/SKILL.md`, "skill")
        yield* write(`${from}/scripts/run.sh`, "#!/bin/sh\n")
        yield* write(`${from}/.git/config`, "secret")
        yield* fs.symlink("/etc/hostname", `${from}/link`)
        yield* fs.symlink("/etc", `${from}/linked-dir`)
        // What an earlier copy left: a file that has gone, a file where there's a folder now.
        yield* write(`${to}/gone.txt`, "x")
        yield* write(`${to}/scripts`, "was a file")
        yield* copySkill(fs, from, to)
        assert.strictEqual(yield* fs.readFileString(`${to}/SKILL.md`), "skill")
        assert.strictEqual(yield* fs.readFileString(`${to}/scripts/run.sh`), "#!/bin/sh\n")
        for (const gone of ["gone.txt", ".git", "link", "linked-dir"]) assert.isTrue(Option.isNone(yield* fs.lstat(`${to}/${gone}`).pipe(Effect.option)), gone)
        // Files that are right aren't rewritten.
        const old = 1_577_836_800
        yield* fs.utimes(`${to}/SKILL.md`, old, old)
        yield* copySkill(fs, from, to)
        const mtime = Option.getOrNull((yield* fs.stat(`${to}/SKILL.md`)).mtime)
        assert.strictEqual(mtime?.getTime(), old * 1000)
        yield* write(`${from}/SKILL.md`, "skill 2")
        yield* copySkill(fs, from, to)
        assert.strictEqual(yield* fs.readFileString(`${to}/SKILL.md`), "skill 2")
        // A change that's only to a script's permissions reaches the copy, both ways.
        const mode = (p: string) => Effect.map(fs.stat(p), (i) => i.mode & 0o777)
        yield* fs.chmod(`${from}/scripts/run.sh`, 0o644)
        yield* copySkill(fs, from, to)
        assert.strictEqual(yield* mode(`${to}/scripts/run.sh`), 0o644)
        yield* fs.chmod(`${from}/scripts/run.sh`, 0o755)
        yield* copySkill(fs, from, to)
        assert.strictEqual(yield* mode(`${to}/scripts/run.sh`), 0o755)
      }),
    ),
  )

  it.effect("lists a Claude task's skills", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* tempDir
        const config = `${root}/config`
        const repo = `${root}/repo`
        const skill = (dir: string, name: string, description: string, extra: string) =>
          write(`${dir}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n${extra}---\n`)
        const personal = `${config}/skills`
        const project = `${repo}/.claude/skills`
        yield* skill(`${personal}/mine`, "mine", "My own", "")
        yield* skill(`${project}/repo-skill`, "repo-skill", "From the repository", "")
        yield* skill(`${project}/user-only`, "user-only", "User only", "disable-model-invocation: true\n")
        // Changed since the last run so that only the model can call it.
        yield* skill(`${project}/hidden`, "hidden", "Hidden", "user-invocable: false\n")
        // A frontmatter name that's another skill's folder doesn't hide or describe that skill.
        yield* skill(`${project}/aaa-draft`, "deploy", "Draft", "")
        yield* skill(`${project}/deploy`, "deploy", "Deploy", "")
        yield* skill(`${project}/aab-hidden`, "deploy2", "Hidden draft", "user-invocable: false\n")
        yield* skill(`${project}/deploy2`, "deploy2", "Deploy 2", "")
        yield* skill(`${personal}/x`, "review", "Personal x", "")
        yield* skill(`${project}/review`, "review", "Review", "")
        // Plugins' skills are read from the versions installed, not older ones in the cache.
        const cache = `${config}/plugins/cache/market`
        yield* skill(`${cache}/plug/1.0.0/skills/lint`, "lint", "Old lints", "user-invocable: false\n")
        yield* skill(`${cache}/plug/2.0.0/skills/lint`, "lint", "Lints", "")
        yield* skill(`${cache}/upgraded/1.0.0/skills/review`, "review", "Old review", "")
        yield* skill(`${cache}/upgraded/2.0.0/skills/review`, "review", "Review", "user-invocable: false\n")
        yield* skill(`${cache}/upgraded/1.0.0/skills/fixed`, "fixed", "Old fixed", "user-invocable: false\n")
        yield* skill(`${cache}/upgraded/2.0.0/skills/fixed`, "fixed", "Fixed", "")
        const install = (v: string) => [{ scope: "user", installPath: `${cache}/${v}` }]
        const main = `${root}/main`
        const scopedOf = (v: string, scope: string, projectPath: string) => ({ scope, projectPath, installPath: `${cache}/${v}` })
        const scoped = [
          scopedOf("scoped/2.0.0", "project", main),
          scopedOf("scoped/1.0.0", "project", `${root}/elsewhere`),
          { scope: "user", installPath: `${cache}/scoped/0.9.0` },
        ]
        const installed = {
          version: 2,
          plugins: { "plug@market": install("plug/2.0.0"), "upgraded@market": install("upgraded/2.0.0"), "scoped@market": scoped },
        }
        yield* write(
          `${config}/plugins/installed_plugins.json`,
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(installed).pipe(Effect.orDie),
        )
        // Hidden since the last run, which reported them by their frontmatter names.
        yield* skill(`${project}/source`, "alias-hidden", "Hidden", "user-invocable: false\n")
        yield* skill(`${cache}/plug/2.0.0/skills/source-qualified`, "plug:alias-qualified", "Hidden", "user-invocable: false\n")
        yield* skill(`${cache}/plug/2.0.0/skills/psrc`, "alias-plugin", "Hidden", "user-invocable: no\n")
        // A plugin installed for this project is read from that installation, not another project's or the user's.
        yield* skill(`${cache}/scoped/0.9.0/skills/review`, "review", "User's", "user-invocable: false\n")
        yield* skill(`${cache}/scoped/1.0.0/skills/review`, "review", "Elsewhere", "user-invocable: false\n")
        yield* skill(`${cache}/scoped/2.0.0/skills/review`, "review", "Here", "")
        yield* skill(`${cache}/scoped/1.0.0/skills/hidden`, "hidden", "Elsewhere", "")
        yield* skill(`${cache}/scoped/2.0.0/skills/hidden`, "hidden", "Here", "user-invocable: false\n")
        yield* skill(`${personal}/synced/bucket/pdf`, "pdf", "PDFs", "")
        yield* fs.makeDirectory(`${personal}/not-a-skill`, { recursive: true })
        const lastRun = [
          "code-review",
          "anthropic-skills:pdf",
          "plug:lint",
          "upgraded:review",
          "upgraded:fixed",
          "hidden",
          "user-only",
          "deploy",
          "alias-hidden",
          "plug:alias-qualified",
          "plug:alias-plugin",
          "scoped:review",
          "scoped:hidden",
        ]
        // The task works in `repo` (a worktree, say) of the project checked out at `main`.
        const got = (yield* claudeSkills(fs, config, [repo], main, lastRun)).map((s) => [s.name, s.description])
        assert.deepStrictEqual(got, [
          ["aaa-draft", "Draft"],
          ["anthropic-skills:pdf", "PDFs"],
          ["code-review", ""],
          ["deploy", "Deploy"],
          ["deploy2", "Deploy 2"],
          ["mine", "My own"],
          ["plug:lint", "Lints"],
          ["repo-skill", "From the repository"],
          ["review", "Review"],
          ["scoped:review", "Here"],
          ["upgraded:fixed", "Fixed"],
          ["user-only", "User only"],
          ["x", "Personal x"],
        ])
        // Before any run has reported them, the folders' skills are still there.
        assert.deepStrictEqual(yield* claudeSkills(fs, config, [], null, []), [
          { name: "mine", description: "My own" },
          { name: "x", description: "Personal x" },
        ])
      }),
    ),
  )
})
