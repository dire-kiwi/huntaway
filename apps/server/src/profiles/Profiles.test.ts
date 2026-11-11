import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Option, Stream } from "effect"
import { AgentConfigId, LinkId, ProfileId, Timestamp } from "@huntaway/contracts"
import type { Reviewer } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { DataDir } from "../platform/DataDir.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { AgentConfigRepo } from "./AgentConfigRepo.ts"
import { AgentConfigs } from "./AgentConfigs.ts"
import { checkAgentAccess, defaultCloneDir, parseGithubAccount } from "./checks.ts"
import { ProfileRepo } from "./ProfileRepo.ts"
import { Profiles } from "./Profiles.ts"

const tag = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (e) => e._tag)
/** A reviewer with every field default but those given. */
const reviewer = (fields: Partial<Reviewer> = {}): Reviewer => Object.assign({ claude_config_id: null, model: null, effort: null }, fields)

/** A profile row made directly, as an older board might have it (two names in different cases). */
const insertProfile = (id: string, name: string) =>
  Effect.flatMap(ProfileRepo, (repo) => repo.insert(ProfileId.make(id), Timestamp.make("2026-01-01T00:00:00.000Z"), { name }))

describe("Profiles", () => {
  // ensure_profile_makes_a_profile_only_if_none_has_its_name
  it.effect("ensure makes a profile only if none has its name", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles
      const p = Option.getOrThrow(yield* profiles.ensure("personal", "/claude/personal"))
      assert.strictEqual(p.name, "personal")
      const configs = yield* (yield* AgentConfigRepo).list
      assert.deepStrictEqual(
        configs.map((c) => [c.name, c.config_dir]),
        [["personal", "/claude/personal"]],
      )
      assert.deepStrictEqual(
        p.claude_config_ids,
        configs.map((c) => c.id),
      )
      // On the next start, or with the name in another case, it's left as it is.
      assert.isTrue(Option.isNone(yield* profiles.ensure("personal", "/claude/personal")))
      assert.isTrue(Option.isNone(yield* profiles.ensure("Personal", "/elsewhere")))
      assert.strictEqual((yield* profiles.list).length, 1)
      // A config on that folder already is shared.
      const work = Option.getOrThrow(yield* profiles.ensure("work", "/claude/personal"))
      assert.deepStrictEqual(work.claude_config_ids, p.claude_config_ids)
      assert.strictEqual((yield* (yield* AgentConfigRepo).list).length, 1)
      assert.isTrue(yield* (yield* FileSystem.FileSystem).exists(`${(yield* DataDir).profileDir(work.id)}/scratch`))
    }).pipe(Effect.provide(TestBoard())),
  )

  it.effect("the --profile flags make their profiles when the server starts", () =>
    Effect.gen(function* () {
      const listed = yield* (yield* Profiles).list
      assert.deepStrictEqual(
        listed.map((p) => p.name),
        ["work"],
      )
    }).pipe(Effect.provide(TestBoard({ profiles: [{ name: "work", dir: "/claude/work" }] }))),
  )

  it("profiles clone into a folder named after them by default", () => {
    assert.strictEqual(defaultCloneDir("personal"), "~/personal")
    assert.strictEqual(defaultCloneDir(" a/b "), "~/a-b")
    for (const name of ["", " ", ".", ".."]) assert.strictEqual(defaultCloneDir(name), "~")
  })

  it("checks GitHub accounts and tidies agent access", () => {
    assert.strictEqual(parseGithubAccount(" octocat "), "octocat")
    assert.strictEqual(parseGithubAccount("ghe.example.com/me"), "ghe.example.com/me")
    assert.strictEqual(parseGithubAccount("--user=x"), null)
    assert.deepStrictEqual(checkAgentAccess("work", [" personal ", "work", "", "lab", "personal"]), ["lab", "personal"])
    assert.deepStrictEqual(checkAgentAccess("work", ["lab", "*"]), ["*"])
  })

  // profiles_keep_their_github_account
  it.effect("keeps their GitHub account", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles
      const p = yield* profiles.create({ name: "work", github_account: " work-me " })
      assert.strictEqual(p.github_account, "work-me")
      assert.strictEqual((yield* profiles.create({ name: "personal" })).github_account, null)
      assert.strictEqual((yield* Effect.flip(profiles.create({ name: "bad", github_account: "--user=x" })))._tag, "Invalid")
      assert.strictEqual((yield* profiles.update(p.id, { github_account: "ghe.example.com/me" })).github_account, "ghe.example.com/me")
      assert.strictEqual((yield* profiles.update(p.id, { github_account: "" })).github_account, null)
    }).pipe(Effect.provide(TestBoard())),
  )

  // profiles_choose_reviewers_and_a_summarizer (the profile's part; a project's are in Projects.test.ts)
  it.effect("choose reviewers and summarizers, tidied and checked", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles
      const codex = yield* (yield* AgentConfigs).create({ name: "Codex", agent: "codex" })
      const p = yield* profiles.create({
        name: "work",
        reviewers: [reviewer({ claude_config_id: codex.id, model: " " })],
        summarizers: [reviewer({ model: "haiku" })],
      })
      assert.deepStrictEqual(p.reviewers, [{ claude_config_id: codex.id, model: null, effort: null }])
      assert.deepStrictEqual(p.summarizers, [{ claude_config_id: null, model: "haiku", effort: null }])
      assert.deepStrictEqual((yield* profiles.create({ name: "home" })).reviewers, [])
      const unknown: Reviewer = reviewer({ claude_config_id: AgentConfigId.make("nope") })
      assert.strictEqual(yield* tag(profiles.create({ name: "bad", reviewers: [unknown] })), "Invalid")
      // A profile's with just the defaults is none, which is the same.
      const p2 = yield* profiles.update(p.id, { reviewers: [reviewer({ model: "" })], summarizers: [reviewer()] })
      assert.deepStrictEqual([p2.reviewers, p2.summarizers], [[], []])
      assert.deepStrictEqual((yield* profiles.update(p.id, { summarizers: [reviewer({ effort: "low" })] })).reviewers, [], "kept when other fields change")
      const seven = Array.from({ length: 7 }, () => reviewer())
      assert.strictEqual((yield* Effect.flip(profiles.update(p.id, { reviewers: seven })))._tag, "Invalid")
    }).pipe(Effect.provide(TestBoard())),
  )

  // profiles_and_projects_can_have_several_summarizers_with_skills (the profile's part)
  it.effect("can have several summarizers with skills and a prompt; reviewers lose the name", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles
      const p = yield* profiles.create({
        name: "work",
        summarizers: [
          reviewer({ name: " Baseline ", model: "haiku" }),
          reviewer({ name: "Skilled", skills: [" /tldr ", "changelog", "tldr", ""], prompt: "  Be brief.  " }),
        ],
      })
      assert.deepStrictEqual(p.summarizers, [
        { claude_config_id: null, model: "haiku", effort: null, name: "Baseline" },
        { claude_config_id: null, model: null, effort: null, name: "Skilled", skills: ["tldr", "changelog"], prompt: "Be brief." },
      ])
      const p2 = yield* profiles.update(p.id, { reviewers: [reviewer({ name: "x", skills: [" /audit ", "audit", "b", ""], prompt: "  Only security.\n" })] })
      assert.deepStrictEqual(p2.reviewers, [reviewer({ skills: ["audit", "b"], prompt: "Only security." })])
      for (const bad of [
        [reviewer({ skills: ["two words"] })],
        [reviewer({ prompt: "x".repeat(20_001) })],
        [reviewer({ skills: Array.from({ length: 21 }, (_, i) => `s${i}`) })],
      ]) {
        assert.strictEqual(yield* tag(profiles.update(p.id, { reviewers: bad })), "Invalid")
      }
      assert.deepStrictEqual((yield* profiles.update(p.id, { summarizers: null })).summarizers, [])
    }).pipe(Effect.provide(TestBoard())),
  )

  // a_deleted_reviewer_config_doesnt_stop_saving_other_settings (the profile's part)
  it.effect("a deleted reviewer config doesn't stop saving other settings", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles
      const configs = yield* AgentConfigs
      const gone = yield* configs.create({ name: "Gone" })
      const spec: Reviewer = { claude_config_id: gone.id, model: "haiku", effort: null }
      const p = yield* profiles.create({ name: "work", reviewers: [spec], summarizers: [spec] })
      yield* configs.delete(gone.id)
      // The forms send them unchanged with every save, as they were saved.
      const p2 = yield* profiles.update(p.id, { name: "job", reviewers: [spec], summarizers: [spec] })
      assert.deepStrictEqual([p2.name, p2.reviewers, p2.summarizers], ["job", [spec], [spec]])
      // A config that was never saved there still has to exist.
      const unknown: Reviewer = reviewer({ claude_config_id: AgentConfigId.make("nope") })
      assert.strictEqual(yield* tag(profiles.update(p.id, { summarizers: [unknown] })), "Invalid")
      assert.strictEqual(yield* tag(profiles.update(p.id, { reviewers: [unknown] })), "Invalid")
    }).pipe(Effect.provide(TestBoard())),
  )

  // profiles_keep_their_clone_folder
  it.effect("keep their clone folder, and Asana is on by default", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles
      assert.strictEqual((yield* profiles.create({ name: "work", clone_dir: " ~/src/work " })).clone_dir, "~/src/work")
      const p = yield* profiles.create({ name: "personal" })
      assert.deepStrictEqual([p.clone_dir, p.asana_enabled], [null, true])
      assert.strictEqual((yield* profiles.create({ name: "home", asana_enabled: false })).asana_enabled, false)
      for (const bad of ["src", "~work"]) assert.strictEqual(yield* tag(profiles.create({ name: "bad", clone_dir: bad })), "Invalid", bad)
      assert.strictEqual((yield* profiles.update(p.id, { clone_dir: "/srv/repos" })).clone_dir, "/srv/repos")
      assert.strictEqual(yield* tag(profiles.update(p.id, { clone_dir: "repos" })), "Invalid")
      assert.strictEqual((yield* profiles.update(p.id, { name: "job" })).clone_dir, "/srv/repos", "kept when other fields change")
      assert.strictEqual((yield* profiles.update(p.id, { clone_dir: " " })).clone_dir, null)
    }).pipe(Effect.provide(TestBoard())),
  )

  // profiles_keep_their_tint
  it.effect("keep their tint", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles
      const p = yield* profiles.create({ name: "work", tint: " #22C55E " })
      assert.strictEqual(p.tint, "#22c55e")
      assert.strictEqual((yield* profiles.create({ name: "personal" })).tint, null)
      for (const tint of ["red", "#fff"]) assert.strictEqual(yield* tag(profiles.create({ name: "bad", tint })), "Invalid", tint)
      assert.strictEqual((yield* profiles.update(p.id, { tint: "#0ea5e9" })).tint, "#0ea5e9")
      assert.strictEqual((yield* profiles.update(p.id, { name: "work" })).tint, "#0ea5e9")
      assert.strictEqual((yield* profiles.update(p.id, { tint: null })).tint, null)
      yield* profiles.update(p.id, { tint: "#0ea5e9" })
      assert.strictEqual((yield* profiles.update(p.id, { tint: "" })).tint, null)
    }).pipe(Effect.provide(TestBoard())),
  )

  // profiles_connect_to_asana_and_search_it: in Asana.test.ts (6.11).

  // profile_names_are_required_and_unique (HA-37)
  it.effect("names are required and unique whatever their case", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles
      const personal = yield* profiles.create({ name: " personal " })
      assert.strictEqual(personal.name, "personal")
      const work = yield* profiles.create({ name: "work" })
      assert.strictEqual(yield* tag(profiles.create({ name: "Personal" })), "Conflict")
      assert.strictEqual(yield* tag(profiles.create({ name: " " })), "Invalid")
      for (const [bad, want] of [
        ["", "Invalid"],
        [" ", "Invalid"],
        [" PERSONAL", "Conflict"],
      ] as const) {
        assert.strictEqual(yield* tag(profiles.update(work.id, { name: bad })), want, bad)
      }
      assert.strictEqual((yield* profiles.get(work.id)).name, "work")
      // Its own name in another case is fine.
      assert.strictEqual((yield* profiles.update(personal.id, { name: "Personal" })).name, "Personal")
      assert.strictEqual((yield* profiles.update(work.id, { name: " office " })).name, "office")
    }).pipe(Effect.provide(TestBoard())),
  )

  // profiles_sharing_a_name_in_another_case_can_still_be_saved (HA-47)
  it.effect("profiles sharing a name in another case can still be saved", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles
      yield* insertProfile("upper", "Work")
      yield* insertProfile("lower", "work")
      for (const [id, name] of [
        ["upper", "Work"],
        ["lower", "work"],
      ] as const) {
        const saved = yield* profiles.update(ProfileId.make(id), { name: ` ${name} `, default_model: " haiku " })
        assert.deepStrictEqual([saved.name, saved.default_model], [name, "haiku"])
      }
      assert.strictEqual(yield* tag(profiles.update(ProfileId.make("lower"), { name: "WORK" })), "Conflict")
      assert.strictEqual((yield* profiles.update(ProfileId.make("lower"), { name: "office" })).name, "office")
    }).pipe(Effect.provide(TestBoard())),
  )

  it.effect("its assistant's and threads' configs are among its own, and go back to the default when it drops them", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles
      const configs = yield* AgentConfigs
      const a = yield* configs.create({ name: "a" })
      const b = yield* configs.create({ name: "b" })
      assert.strictEqual(yield* tag(profiles.create({ name: "x", claude_config_ids: [a.id], assistant_config_id: b.id })), "Invalid")
      assert.strictEqual(yield* tag(profiles.create({ name: "x", claude_config_ids: [AgentConfigId.make("nope")] })), "Invalid")
      const p = yield* profiles.create({ name: "work", claude_config_ids: [a.id, b.id, a.id], assistant_config_id: b.id, threads_config_id: null })
      assert.deepStrictEqual([p.claude_config_ids, p.assistant_config_id], [[a.id, b.id], b.id])
      const p2 = yield* profiles.update(p.id, { claude_config_ids: [a.id] })
      assert.deepStrictEqual([p2.claude_config_ids, p2.assistant_config_id], [[a.id], null])
      assert.strictEqual(yield* tag(profiles.update(p.id, { threads_config_id: b.id })), "Invalid")
      assert.strictEqual((yield* profiles.update(p.id, { threads_config_id: a.id })).threads_config_id, a.id)
    }).pipe(Effect.provide(TestBoard())),
  )

  it.effect("takes no assistant host but this one, as no host is linked yet", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles
      const p = yield* profiles.create({ name: "work" })
      assert.strictEqual(yield* tag(profiles.update(p.id, { assistant_host: LinkId.make("elsewhere") })), "Invalid")
      assert.strictEqual((yield* profiles.update(p.id, { assistant_host: null })).assistant_host, null)
    }).pipe(Effect.provide(TestBoard())),
  )

  // deleting_a_profile_cleans_up_after_its_projects_and_threads, without worktrees, runs and documents (later milestones)
  it.effect("deleting a profile deletes its projects, its tasks and its folders", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* DataDir
      const { sql } = yield* Db
      const p = yield* profiles.create({ name: "work" })
      const other = yield* profiles.create({ name: "other" })
      yield* sql`INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at)
        VALUES ('pr', ${p.id}, 'x', 'X', '/x', ${`${dataDir.projectDir("pr")}/scratch`}, ${`${dataDir.projectDir("pr")}/worktrees`}, '')`.pipe(Effect.orDie)
      yield* fs.makeDirectory(`${dataDir.projectDir("pr")}/scratch`, { recursive: true }).pipe(Effect.orDie)
      const task = (id: string, profileId: string, projectId: string | null, kind = "task") =>
        sql`INSERT INTO tasks ${sql.insert({ id, profile_id: profileId, project_id: projectId, kind, title: id, last_activity_at: "", created_at: "", updated_at: "" })}`.pipe(
          Effect.orDie,
        )
      yield* task("in-project", p.id, "pr")
      yield* task("scratch", p.id, null)
      yield* task("review", p.id, null, "review")
      yield* task("others", other.id, null)
      // Not while one of its agents runs.
      yield* sql`UPDATE tasks SET running = 1 WHERE id = 'scratch'`.pipe(Effect.orDie)
      assert.strictEqual(yield* tag(profiles.delete(p.id)), "Conflict")
      yield* sql`UPDATE tasks SET running = 0`.pipe(Effect.orDie)

      const watch = yield* (yield* Events).watch(undefined)
      yield* profiles.delete(p.id)
      const events = yield* watch.live.pipe(Stream.take(3), Stream.runCollect)
      assert.deepStrictEqual(
        events.map((e) => e.type),
        ["project_deleted", "task_deleted", "profiles_changed"],
      )
      const left = yield* sql<{ readonly id: string }>`SELECT id FROM tasks`.pipe(Effect.orDie)
      assert.deepStrictEqual(
        left.map((r) => r.id),
        ["others"],
      )
      assert.isFalse(yield* fs.exists(dataDir.projectDir("pr")))
      assert.isFalse(yield* fs.exists(dataDir.profileDir(p.id)))
      assert.isTrue(yield* fs.exists(dataDir.profileDir(other.id)))
      assert.strictEqual(yield* tag(profiles.delete(p.id)), "ProfileNotFound")
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  // deleting_a_profile_keeps_its_folder_if_a_project_uses_it (HA-47)
  it.effect("deleting a profile keeps its folder if another profile's project uses it", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* DataDir
      const { sql } = yield* Db
      const gone = yield* profiles.create({ name: "gone" })
      const kept = yield* profiles.create({ name: "kept" })
      const folder = dataDir.profileDir(gone.id)
      yield* sql`INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at)
        VALUES ('pr', ${kept.id}, 'x', 'X', '/x', '/s', ${`${folder}/worktrees`}, '')`.pipe(Effect.orDie)
      yield* profiles.delete(gone.id)
      assert.isTrue(yield* fs.exists(`${folder}/scratch`))
    }).pipe(Effect.provide(TestBoard())),
  )
})
