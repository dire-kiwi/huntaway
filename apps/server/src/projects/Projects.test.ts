import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Stream } from "effect"
import { AgentConfigId, ProfileId } from "@huntaway/contracts"
import type { Project, Reviewer } from "@huntaway/contracts"
import { git, gitRepo, tempDir, TestBoard } from "@huntaway/testing"
import { DataDir } from "../platform/DataDir.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { AgentConfigs } from "../profiles/AgentConfigs.ts"
import { removeUnusedDir } from "../profiles/dataFolders.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { checkKey, deriveKey, formerKeysAfter, newProjectKey } from "./keys.ts"
import { Projects } from "./Projects.ts"

/** A reviewer with every field default but those given. */
const reviewer = (fields: Partial<Reviewer> = {}): Reviewer => Object.assign({ claude_config_id: null, model: null, effort: null }, fields)
const tag = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (e) => e._tag)
const reason = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.flip(effect), (e) => ("reason" in e && typeof e.reason === "string" ? e.reason : e._tag))
const names = (rows: ReadonlyArray<Project>) => rows.map((p) => p.name)

/** A profile, a temp folder, and a way to make projects on new folders in it (not repositories). */
const setup = Effect.gen(function* () {
  const projects = yield* Projects
  const profile = yield* (yield* Profiles).create({ name: "p" })
  const dir = yield* tempDir
  const make = (name: string) => projects.create({ profile_id: profile.id, name, repo_path: `${dir}/${name}` })
  return { projects, profile, dir, make }
})

/** A task row with only what the table needs. */
const insertTask = (id: string, project: Project) =>
  Effect.flatMap(
    Db,
    ({ sql }) =>
      sql`INSERT INTO tasks ${sql.insert({ id, profile_id: project.profile_id, project_id: project.id, title: id, last_activity_at: "", created_at: "", updated_at: "" })}`,
  ).pipe(Effect.orDie)

describe("project keys", () => {
  it("are derived from the name", () => {
    assert.deepStrictEqual(["omarchy sandbox", "Huntaway", "a b c d", "", "--", "x"].map(deriveKey), ["OS", "HUN", "ABC", "T", "T", "X"])
  })

  // a_renamed_projects_old_key_still_names_its_tasks: the key rules, without the task lookups (TaskRefs, 1.3)
  it.effect("are the project's alone, former keys included", () =>
    Effect.gen(function* () {
      const projects = [
        { id: "os", name: "omarchy-sandbox", key: "OMS", former_keys: ["OS"] },
        { id: "web", name: "web", key: "WEB", former_keys: [] },
      ]
      assert.strictEqual(yield* reason(checkKey(projects, "os", "WEB")), 'the project "web" already has the key WEB')
      assert.strictEqual(yield* reason(checkKey(projects, "os", "O-S")), "the key must be 1 to 10 letters or digits")
      assert.strictEqual(yield* reason(checkKey(projects, "os", "ABCDEFGHIJK")), "the key must be 1 to 10 letters or digits")
      assert.strictEqual(yield* reason(checkKey(projects, "web", "os")), `the key os was the project "omarchy-sandbox"'s, and its old task keys still use it`)
      assert.strictEqual(yield* reason(checkKey(projects, null, "A")), "the key A is used by the assistant; pick another")
      assert.strictEqual(yield* checkKey(projects, "os", "OS"), "OS", "a project may take back its own")
      assert.strictEqual(newProjectKey(projects, "Oms"), "OMS2")
      assert.strictEqual(newProjectKey(projects, "G"), "GP", "clear of the group tasks' key")
      // Changing back drops it from the old keys.
      assert.deepStrictEqual(formerKeysAfter({ key: "OMS", former_keys: ["OS"] }, "OSX"), ["OS", "OMS"])
      assert.deepStrictEqual(formerKeysAfter({ key: "OSX", former_keys: ["OS", "OMS"] }, "OS"), ["OMS", "OSX"])
    }),
  )
})

describe("Projects", () => {
  it.live("a folder's move and the write that records it aren't cut in two when the caller goes", () =>
    Effect.gen(function* () {
      const { projects, dir, make } = yield* setup
      const fs = yield* FileSystem.FileSystem
      const p = yield* make("before")
      const to = `${dir}/after`
      const renamed = yield* Deferred.make<void>()
      // A move that renames the folder, then takes a while (as copying sessions does) before it's done.
      const move = () =>
        Effect.gen(function* () {
          yield* fs.rename(p.repo_path, to)
          yield* Deferred.succeed(renamed, undefined)
          yield* Effect.sleep("200 millis")
          return { repo_path: to, worktrees_root: null, scratch_path: null, repo_root: yield* projects.fingerprint(to) }
        })
      const fiber = yield* Effect.forkChild(projects.relocate(p.id, { repo_path: to, move_repo: true }, move), { startImmediately: true })
      yield* Deferred.await(renamed)
      // The RPC's client goes away mid-move: the interrupt waits for the project to say where the folder is now.
      yield* Fiber.interrupt(fiber)
      assert.strictEqual((yield* projects.get(p.id)).repo_path, to)
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )
  it.live("creates a project on a repository: its branch, its git facts, its folders, and a project event", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* DataDir
      const profile = yield* (yield* Profiles).create({ name: "p" })
      const repo = yield* gitRepo
      const watch = yield* (yield* Events).watch(undefined)
      const p = yield* (yield* Projects).create({ profile_id: profile.id, repo_path: repo })
      assert.deepStrictEqual([p.base_branch, p.is_git, p.has_commits, p.use_worktrees, p.key], ["main", true, true, true, deriveKey(p.name)])
      assert.strictEqual(p.repo_path, yield* fs.realPath(repo))
      assert.strictEqual(p.scratch_path, `${dataDir.projectDir(p.id)}/scratch`)
      assert.isTrue(yield* fs.exists(p.scratch_path))
      const { sql } = yield* Db
      const [row] = yield* sql<{ readonly repo_root: string }>`SELECT repo_root FROM projects WHERE id = ${p.id}`.pipe(Effect.orDie)
      assert.strictEqual(row?.repo_root, yield* git(repo, ["rev-list", "--max-parents=0", "HEAD"]))
      const [event] = yield* watch.live.pipe(Stream.take(1), Stream.runCollect)
      assert.deepStrictEqual(event?.type === "project" ? event.project : null, p)
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  it.live("makes a folder that doesn't exist yet, only for an absolute path, and refreshes the git facts when asked", () =>
    Effect.gen(function* () {
      const { projects, profile, dir } = yield* setup
      const p = yield* projects.create({ profile_id: profile.id, repo_path: `${dir}/new/folder`, key: " nf " })
      assert.deepStrictEqual([p.name, p.key, p.is_git, p.has_commits, p.base_branch], ["folder", "NF", false, false, null])
      assert.strictEqual(yield* tag(projects.create({ profile_id: profile.id, repo_path: "relative/missing" })), "Invalid")
      assert.strictEqual(yield* tag(projects.create({ profile_id: ProfileId.make("nope"), repo_path: dir })), "ProfileNotFound")
      yield* git(p.repo_path, ["init", "-q", "-b", "trunk"])
      assert.deepStrictEqual(yield* Effect.map(projects.refreshGit(p.id), (q) => [q.is_git, q.has_commits]), [true, false])
      yield* git(p.repo_path, ["commit", "-q", "--allow-empty", "-m", "first"])
      assert.deepStrictEqual(yield* Effect.map(projects.refreshGit(p.id), (q) => [q.is_git, q.has_commits]), [true, true])
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  // no_project_can_have_the_assistants_key, and keys derived clear of the profile's
  it.live("no project can have the assistant's key; a derived key steers clear of the profile's", () =>
    Effect.gen(function* () {
      const { projects, profile, dir, make } = yield* setup
      assert.strictEqual(
        yield* reason(projects.create({ profile_id: profile.id, name: "Apps", key: "A", repo_path: dir })),
        "the key A is used by the assistant; pick another",
      )
      const first = yield* make("Oms")
      const second = yield* make("oms")
      assert.deepStrictEqual([first.key, second.key], ["OMS", "OMS2"])
      assert.strictEqual(yield* reason(projects.create({ profile_id: profile.id, repo_path: dir, key: "oms" })), 'the project "Oms" already has the key OMS')
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  // a_renamed_projects_old_key_still_names_its_tasks (the project's part)
  it.live("keeps a renamed project's old keys, and refuses them to another project", () =>
    Effect.gen(function* () {
      const { projects, profile, dir, make } = yield* setup
      const os = yield* projects.create({ profile_id: profile.id, name: "os", key: "OS", repo_path: `${dir}/os` })
      const web = yield* make("web")
      let v = yield* projects.update(os.id, { name: " omarchy-sandbox ", key: "oms" })
      assert.deepStrictEqual([v.name, v.key, v.former_keys], ["omarchy-sandbox", "OMS", ["OS"]])
      assert.strictEqual(yield* reason(projects.update(os.id, { key: "WEB" })), 'the project "web" already has the key WEB')
      assert.strictEqual(yield* reason(projects.update(os.id, { name: "  " })), "name can't be blank")
      v = yield* projects.update(os.id, { key: "OSX" })
      assert.deepStrictEqual(v.former_keys, ["OS", "OMS"])
      v = yield* projects.update(os.id, { key: "OS" })
      assert.deepStrictEqual(v.former_keys, ["OMS", "OSX"])
      assert.strictEqual(
        yield* reason(projects.update(web.id, { key: "OMS" })),
        `the key OMS was the project "omarchy-sandbox"'s, and its old task keys still use it`,
      )
      assert.strictEqual(
        yield* reason(projects.create({ profile_id: profile.id, name: "x", repo_path: dir, key: "OSX" })),
        `the key OSX was the project "omarchy-sandbox"'s, and its old task keys still use it`,
      )
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  // a_key_taken_while_the_folder_moves_isnt_taken_twice / a_rename_while_the_folder_moves_keeps_every_old_key, without the move
  it.live("two changes at once neither take one key twice nor lose an old key", () =>
    Effect.gen(function* () {
      const { projects, make } = yield* setup
      const p = yield* make("x")
      const q = yield* make("q")
      const both = yield* Effect.all([Effect.result(projects.update(p.id, { key: "NEW" })), Effect.result(projects.update(q.id, { key: "NEW" }))], {
        concurrency: 2,
      })
      assert.deepStrictEqual(both.map((r) => r._tag).toSorted(), ["Failure", "Success"])
      yield* Effect.all([projects.update(p.id, { key: "ONE" }), projects.update(p.id, { key: "TWO" })], { concurrency: 2 })
      const now = yield* projects.get(p.id)
      assert.includeMembers([...now.former_keys, now.key], ["X", "ONE", "TWO"])
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  // a_projects_scripts_and_models_are_checked_for_type_before_theyre_stored (the values; the types are the contract's)
  it.live("stores scripts as given, null as none, and a blank model as the default", () =>
    Effect.gen(function* () {
      const { projects, make } = yield* setup
      const p = yield* make("x")
      let back = yield* projects.update(p.id, { setup_script: "make", model: " haiku " })
      assert.deepStrictEqual([back.setup_script, back.model], ["make", "haiku"])
      back = yield* projects.update(p.id, { setup_script: null, status_script: null, model: "" })
      assert.deepStrictEqual([back.setup_script, back.status_script, back.model], ["", "", null])
      back = yield* projects.update(p.id, { start_prompt: "  Go.  ", review_prompt: " " })
      assert.deepStrictEqual([back.start_prompt, back.review_prompt], ["Go.", null])
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  // projects_turn_their_tasks_pull_requests_on_and_off, projects_watch_pull_requests_in_review_once_asked_to
  it.live("turn pull requests on and off and watch them once asked to", () =>
    Effect.gen(function* () {
      const { projects, make } = yield* setup
      const p = yield* make("x")
      assert.deepStrictEqual([p.pull_requests, p.watch_pull_requests], [true, "off"])
      assert.isFalse((yield* projects.update(p.id, { pull_requests: false })).pull_requests)
      for (const mode of ["failures", "all", "off"] as const)
        assert.strictEqual((yield* projects.update(p.id, { watch_pull_requests: mode })).watch_pull_requests, mode)
      assert.strictEqual(yield* tag(projects.update(p.id, { pr_preview_url: "https://x.example" })), "Invalid")
      assert.strictEqual((yield* projects.update(p.id, { pr_preview_url: " https://pr-{pr}.example " })).pr_preview_url, "https://pr-{pr}.example")
      assert.strictEqual((yield* projects.update(p.id, { pr_preview_url: "" })).pr_preview_url, null)
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  // worktree_settings_are_checked (HA-42)
  it.live("checks worktree settings and base branches", () =>
    Effect.gen(function* () {
      const profile = yield* (yield* Profiles).create({ name: "p" })
      const projects = yield* Projects
      const repo = yield* gitRepo
      const p = yield* projects.create({ profile_id: profile.id, repo_path: repo })
      const dir = p.repo_path
      const base = dir.slice(dir.lastIndexOf("/") + 1)
      for (const bad of [
        { worktrees_root: "worktrees" },
        { worktrees_root: "./w" },
        { worktrees_root: dir },
        { worktrees_root: `${dir}/` },
        { worktrees_root: `${dir}/../${base}` },
        { worktrees_root: " " },
        { base_branch: "a..b" },
        { base_branch: "-x" },
        { base_branch: "@{-1}" },
        { base_branch: "with space" },
        { base_branch: "main.lock" },
      ]) {
        assert.strictEqual(yield* tag(projects.update(p.id, bad)), "Invalid")
      }
      const kept = yield* projects.get(p.id)
      assert.deepStrictEqual([kept.worktrees_root, kept.base_branch], [p.worktrees_root, "main"])
      const updated = yield* projects.update(p.id, { worktrees_root: `${dir}/.worktrees`, base_branch: " feature/x " })
      assert.deepStrictEqual([updated.worktrees_root, updated.base_branch], [`${dir}/.worktrees`, "feature/x"])
      assert.strictEqual((yield* projects.update(p.id, { base_branch: "" })).base_branch, null)
      assert.strictEqual(yield* tag(projects.create({ profile_id: profile.id, name: "y", repo_path: dir, key: "Y", base_branch: "no..pe" })), "Invalid")
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  // groups_projects
  it.live("groups projects", () =>
    Effect.gen(function* () {
      const { projects, make } = yield* setup
      const p = yield* make("x")
      assert.strictEqual(p.group_name, null)
      assert.strictEqual((yield* projects.update(p.id, { group_name: "  Work  " })).group_name, "Work")
      assert.strictEqual((yield* projects.update(p.id, { group_name: " " })).group_name, null)
      yield* projects.update(p.id, { group_name: "Work" })
      assert.strictEqual((yield* projects.update(p.id, { group_name: null })).group_name, null)
      assert.strictEqual(yield* tag(projects.update(p.id, { group_name: "x".repeat(101) })), "Invalid")
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  // archives_projects (without the archived project's refusal of new tasks, which is Tasks.create's, 1.3)
  it.live("archives projects, not while one of their agents runs", () =>
    Effect.gen(function* () {
      const { projects, profile, make } = yield* setup
      const p = yield* make("x")
      yield* make("y")
      const listed = (archived: boolean) => Effect.map(projects.list(profile.id, archived), names)
      assert.deepStrictEqual([yield* listed(false), yield* listed(true)], [["x", "y"], []])
      yield* insertTask("t", p)
      const { sql } = yield* Db
      yield* sql`UPDATE tasks SET running = 1`.pipe(Effect.orDie)
      assert.strictEqual(yield* reason(projects.update(p.id, { archived: true })), "agent_running")
      yield* sql`UPDATE tasks SET running = 0`.pipe(Effect.orDie)
      const archived = (yield* projects.update(p.id, { archived: true })).archived_at
      assert.isNotNull(archived)
      assert.deepStrictEqual([yield* listed(false), yield* listed(true)], [["y"], ["x"]])
      // Archiving again keeps when it was archived.
      assert.strictEqual((yield* projects.update(p.id, { archived: true })).archived_at, archived)
      assert.strictEqual((yield* projects.update(p.id, { archived: false })).archived_at, null)
      assert.deepStrictEqual(yield* listed(false), ["x", "y"])
      assert.strictEqual(yield* tag(projects.list(ProfileId.make("nope"), false)), "ProfileNotFound")
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  // sets_a_script_per_status
  it.live("sets a script per status", () =>
    Effect.gen(function* () {
      const { projects, make } = yield* setup
      const p = yield* make("x")
      assert.deepStrictEqual(p.status_scripts, {})
      assert.deepStrictEqual((yield* projects.update(p.id, { status_scripts: { done: "make clean", todo: "  " } })).status_scripts, { done: "make clean" })
      assert.deepStrictEqual((yield* projects.get(p.id)).status_scripts, { done: "make clean" })
      assert.deepStrictEqual((yield* projects.update(p.id, { status_scripts: null })).status_scripts, {})
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  it.live("checks the files copied and the folders linked into worktrees", () =>
    Effect.gen(function* () {
      const { projects, make } = yield* setup
      const p = yield* make("x")
      assert.strictEqual(
        (yield* projects.update(p.id, { copy_files: " .env\n# note\n!secret \n", link_folders: "node_modules/\n" })).copy_files,
        ".env\n# note\n!secret",
      )
      for (const bad of [{ copy_files: "../up" }, { link_folders: "/abs" }, { link_folders: "~/x" }, { link_folders: "a/.git" }, { link_folders: "./" }]) {
        assert.strictEqual(yield* tag(projects.update(p.id, bad)), "Invalid")
      }
      assert.strictEqual((yield* projects.update(p.id, { link_folders: null })).link_folders, "")
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  // profiles_choose_reviewers_and_a_summarizer_that_projects_can_override, several summarizers, a deleted config (the project's part)
  it.live("have reviewers and summarizers of their own, kept when the profile's config is deleted", () =>
    Effect.gen(function* () {
      const configs = yield* AgentConfigs
      const gone = yield* configs.create({ name: "Gone" })
      const spec: Reviewer = { claude_config_id: gone.id, model: "haiku", effort: null }
      const profile = yield* (yield* Profiles).create({ name: "work", reviewers: [spec] })
      const projects = yield* Projects
      const p = yield* projects.create({ profile_id: profile.id, name: "x", repo_path: `${yield* tempDir}/x` })
      // One with the defaults is a project's own choice (the task's config) over the profile's.
      assert.deepStrictEqual((yield* projects.update(p.id, { reviewers: [reviewer()], summarizers: [reviewer({ skills: ["x"] })] })).reviewers, [reviewer()])
      assert.deepStrictEqual((yield* projects.get(p.id)).summarizers, [reviewer({ skills: ["x"] })])
      const back = yield* projects.update(p.id, { reviewers: [], summarizers: null })
      assert.deepStrictEqual([back.reviewers, back.summarizers], [[], []])
      yield* configs.delete(gone.id)
      // A project taking its own, starting from the profile's, keeps the profile's deleted config.
      assert.strictEqual(
        (yield* projects.update(p.id, { reviewers: [reviewer({ claude_config_id: gone.id, model: "sonnet" })] })).reviewers[0]?.model,
        "sonnet",
      )
      assert.strictEqual(yield* tag(projects.update(p.id, { summarizers: [reviewer({ claude_config_id: AgentConfigId.make("nope") })] })), "Invalid")
      assert.strictEqual(yield* tag(projects.update(p.id, { reviewers: [reviewer({ skills: ["two words"] })] })), "Invalid")
      const own = yield* configs.create({ name: "own" })
      assert.deepStrictEqual((yield* projects.update(p.id, { claude_config_ids: [own.id, own.id] })).claude_config_ids, [own.id])
      assert.strictEqual((yield* projects.update(p.id, { claude_config_ids: [] })).claude_config_ids, null)
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  it.live("leaves a new folder to Relocation: a plain update refuses it", () =>
    Effect.gen(function* () {
      const { projects, dir, make } = yield* setup
      const p = yield* make("x")
      assert.strictEqual(yield* tag(projects.update(p.id, { repo_path: `${dir}/y`, move_repo: true })), "Invalid")
      assert.strictEqual((yield* projects.update(p.id, { repo_path: p.repo_path, name: "z" })).name, "z", "its own folder is no change")
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  it.live("deleting a project deletes its tasks and its data folder, never its repository", () =>
    Effect.gen(function* () {
      const { projects, make } = yield* setup
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* DataDir
      const p = yield* make("x")
      yield* insertTask("t", p)
      const watch = yield* (yield* Events).watch(undefined)
      yield* projects.delete(p.id)
      const [event] = yield* watch.live.pipe(Stream.take(1), Stream.runCollect)
      assert.deepStrictEqual(event?.type === "project_deleted" ? event.id : null, p.id)
      const { sql } = yield* Db
      assert.deepStrictEqual(yield* sql`SELECT id FROM tasks`.pipe(Effect.orDie), [])
      assert.isFalse(yield* fs.exists(dataDir.projectDir(p.id)))
      assert.isTrue(yield* fs.exists(p.repo_path))
      assert.strictEqual(yield* tag(projects.delete(p.id)), "ProjectNotFound")
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  // deleting_a_project_keeps_its_folder_if_another_uses_it
  it.live("deleting a project keeps its folder if another uses it", () =>
    Effect.gen(function* () {
      const { projects, make } = yield* setup
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* DataDir
      const a = yield* make("a")
      const b = yield* make("b")
      yield* projects.update(b.id, { worktrees_root: `${dataDir.projectDir(a.id)}/shared` })
      yield* projects.delete(a.id)
      assert.isTrue(yield* fs.exists(dataDir.projectDir(a.id)))
      yield* projects.delete(b.id)
      assert.isFalse(yield* fs.exists(dataDir.projectDir(b.id)))
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  // a_folder_is_kept_for_a_path_in_it_through_a_symlink (HA-47)
  it.live("keeps a folder for a path in it through a symbolic link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* tempDir
      yield* fs.makeDirectory(`${tmp}/real/projects/x`, { recursive: true })
      yield* fs.symlink(`${tmp}/real`, `${tmp}/link`)
      const dir = `${tmp}/link/projects/x`
      yield* removeUnusedDir(fs, dir, [`${dir}/worktrees`], "project")
      assert.isTrue(yield* fs.exists(`${tmp}/real/projects/x`))
      yield* removeUnusedDir(fs, dir, [`${tmp}/elsewhere`], "project")
      assert.isFalse(yield* fs.exists(`${tmp}/real/projects/x`))
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )
})
