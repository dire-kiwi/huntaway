import { Config, Context, DateTime, Effect, FileSystem, Layer, Option, Schema, Semaphore } from "effect"
import { SecureRandom } from "effect/crypto"
import { McpServerId, SkillId, SkillSourceId, threadKindOf } from "@huntaway/contracts"
import type {
  AgentToolSwitch,
  GlobalAgentTools,
  McpServer,
  McpServerInput,
  ProjectAgentTools,
  ProjectAgentToolsPatch,
  ProjectId,
  Skill,
  SkillInput,
  SkillSourceSynced,
  Task,
  TaskId,
  TaskSkill,
  TaskSkills,
  ThreadKindFields,
} from "@huntaway/contracts"
import { Git } from "../git/Git.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Db } from "../platform/Db.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import type { AgentConfigRow } from "../profiles/AgentConfigRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { boardSkillsOff, effective, forgetSkill, mergeSeen, reportedSkills, SEEN_DAYS, withBoardSkills } from "./agentTools/effective.ts"
import type { InitTools, Inventory, SkillRow } from "./agentTools/effective.ts"
import { discover, SourceFailed, syncSkills } from "./agentTools/files.ts"
import type { Found } from "./agentTools/files.ts"
import { planSource } from "./agentTools/sourcePlan.ts"
import { claudeSkills } from "./agentTools/taskSkills.ts"
import {
  checkDisabledSkills,
  checkRef,
  checkServerConfig,
  checkServerName,
  checkSkill,
  checkSubdir,
  isBoardServer,
  normalizeUrl,
  sourceName,
  ToolInvalid,
  validOtherSkill,
} from "./agentTools/validation.ts"
import { AgentToolsRepo, noOverrides } from "./AgentToolsRepo.ts"
import type { Overrides, ToolTable } from "./AgentToolsRepo.ts"
import { noRunTools, toolPrefix } from "./claude/access.ts"
import type { RunTools } from "./claude/access.ts"
import { CodexQueries } from "./CodexQueries.ts"

// Skills and MCP servers for agents (docs/plan/inventory/02-agent-support.md, section 2.5; huntaway's
// agent/agent_tools.ts and agent_tools/*): the host keeps skills (a `SKILL.md` each) and MCP servers outside any
// repository, global ones (which each profile switches on by default and each project can override) and a project's
// own. Before each run the skills that are on are written to a folder the agent gets with `--add-dir` and the servers
// go into its `--mcp-config` (`forRun`); skills and servers from elsewhere a project turns off go into
// `--disallowedTools`, and what each run had is recorded from its `init` line (`recordSeen`). A global skill can also
// come from a skill source, a git repository the host clones (`addSource`), whose skills keep their switches across
// updates. The bodies' plain parts are in `agentTools/`.

export { ToolInvalid } from "./agentTools/validation.ts"
export { SourceFailed } from "./agentTools/files.ts"

/** A skill, server, source, project or profile that isn't there. */
export class ToolNotFound extends Schema.TaggedError<ToolNotFound, { readonly brand: unique symbol }>()("ToolNotFound", {
  what: Schema.String,
  id: Schema.String,
}) {}

/** A name taken in its scope, or a source already added. */
export class ToolConflict extends Schema.TaggedError<ToolConflict, { readonly brand: unique symbol }>()("ToolConflict", { detail: Schema.String }) {}

/** How long a clone may take. */
export const CLONE_TIMEOUT = "180 seconds"

/** A thread, as far as its tools go. */
export type ToolTask = ThreadKindFields & Pick<Task, "profile_id">

export interface AgentToolsShape {
  /** The host's global skills and servers, its sources, and every profile's defaults. */
  readonly global: Effect.Effect<GlobalAgentTools>
  readonly project: (id: ProjectId) => Effect.Effect<ProjectAgentTools, ToolNotFound>
  /** Turn skills and servers from outside the board off (or back on) in a project. */
  readonly updateProject: (id: ProjectId, patch: ProjectAgentToolsPatch) => Effect.Effect<ProjectAgentTools, ToolNotFound | ToolInvalid>
  /** Switch a global skill or server (or every skill of a source) on or off for a profile (its default) or a project. */
  readonly setSwitch: (input: AgentToolSwitch) => Effect.Effect<void, ToolNotFound | ToolInvalid>
  readonly addSkill: (owner: ProjectId | null, input: SkillInput) => Effect.Effect<Skill, ToolNotFound | ToolInvalid | ToolConflict>
  readonly updateSkill: (owner: ProjectId | null, id: string, input: SkillInput) => Effect.Effect<Skill, ToolNotFound | ToolInvalid | ToolConflict>
  readonly removeSkill: (owner: ProjectId | null, id: string) => Effect.Effect<void, ToolNotFound | ToolInvalid>
  readonly addServer: (owner: ProjectId | null, input: McpServerInput) => Effect.Effect<McpServer, ToolNotFound | ToolInvalid | ToolConflict>
  readonly updateServer: (owner: ProjectId | null, id: string, input: McpServerInput) => Effect.Effect<McpServer, ToolNotFound | ToolInvalid | ToolConflict>
  readonly removeServer: (owner: ProjectId | null, id: string) => Effect.Effect<void, ToolNotFound>
  /** Clones a repository and adds its skills, off for every profile and project until switched on. */
  readonly addSource: (input: {
    readonly url: string
    readonly ref?: string | null | undefined
    readonly subdir?: string | null | undefined
  }) => Effect.Effect<SkillSourceSynced, ToolInvalid | ToolConflict | SourceFailed>
  /** Clones it again and brings its skills up to date; a failure keeps them and says why on the source. */
  readonly updateSource: (id: string) => Effect.Effect<SkillSourceSynced, ToolNotFound | SourceFailed>
  /** Forgets a source, its clone and its skills. */
  readonly removeSource: (id: string) => Effect.Effect<void, ToolNotFound>
  /**
   * The skills and servers a run of `task` gets, its skills written to their folder first: its project's (a review
   * thread's own skills too), or for a profile's assistant and its routines the global ones the profile switches on.
   * Other threads in no project get none.
   */
  readonly forRun: (task: ToolTask) => Effect.Effect<RunTools>
  /** The same, without writing the skills (what a run would get, for its prompts). */
  readonly preview: (task: ToolTask) => Effect.Effect<RunTools>
  /** A run's `init` line: what its agent had, kept per config for the project's settings. Database only: in the line's transaction. */
  readonly recordSeen: (task: TaskId, init: InitTools) => Effect.Effect<void>
  /** The skills a task's agent can be asked to use, for the composer's `/` menu. */
  readonly taskSkills: (task: TaskId) => Effect.Effect<TaskSkills, TaskNotFound>
  /** A deleted review or summary thread's skills folder goes with it. */
  readonly removeThreadSkills: (project: ProjectId, thread: TaskId) => Effect.Effect<void>
}

const nonBlank = (s: string | null | undefined): string | null => {
  const t = s?.trim()
  return t === undefined || t === "" ? null : t
}

/** Whose skills and servers a run gets: a project's (with a review thread's own), or a profile's, for its runs in no project. */
type Scope = { readonly _tag: "Project"; readonly project: ProjectId; readonly thread: TaskId | null } | { readonly _tag: "Profile"; readonly profile: string }

const projectScope = (project: ProjectId): Scope => ({ _tag: "Project", project, thread: null })

const tidy = (v: ReadonlyArray<string>) => [...new Set(v.map((n) => n.trim()).filter((n) => n !== ""))].toSorted()

/** A skill as the wire has it (without its folder in its source). */
const wire = (row: SkillRow): Skill => ({
  id: row.id,
  project_id: row.project_id,
  name: row.name,
  description: row.description,
  content: row.content,
  enabled: row.enabled,
  source_id: row.source_id,
  created_at: row.created_at,
  updated_at: row.updated_at,
})

/** Its worktree, once it is set up. */
const ready = (t: Task) => (t.worktree_state === "ready" ? t.worktree_path : null)

const scopeOf = (task: ToolTask): Scope | null => {
  if (task.project_id !== null) return { _tag: "Project", project: task.project_id, thread: task.kind === "review" ? task.id : null }
  const kind = threadKindOf(task)._tag
  return kind === "Assistant" || kind === "Routine" ? { _tag: "Profile", profile: task.profile_id } : null
}

export class AgentTools extends Context.Service<AgentTools, AgentToolsShape>()("huntaway-server/agents/AgentTools") {
  static readonly layer = Layer.effect(
    AgentTools,
    Effect.gen(function* () {
      const repo = yield* AgentToolsRepo
      const db = yield* Db
      const dataDir = yield* DataDir
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const git = yield* Git
      const random = yield* SecureRandom.SecureRandom
      const tasks = yield* TaskRepo
      const projects = yield* ProjectRepo
      const configs = yield* AgentConfigRepo
      const codex = yield* CodexQueries
      // One source operation at a time: they clone, swap folders and write skills. (Runs only read the clones.)
      const busy = yield* Semaphore.make(1)
      // Never wait for a password: ssh in batch mode, unless the environment says how to run ssh.
      const ownSsh = Option.isSome(yield* Config.option(Config.String("GIT_SSH_COMMAND"))) || Option.isSome(yield* Config.option(Config.String("GIT_SSH")))
      const sourcesRoot = dataDir.file("skill-sources")
      const newId = Effect.orDie(random.uuidV4())
      const expand = (path: string) => (path === "~" ? config.home : path.startsWith("~/") ? `${config.home}${path.slice(1)}` : path)

      // ---- reading ----

      const inventory = Effect.fnUntraced(function* (scope: Scope) {
        const profile = scope._tag === "Profile" ? scope.profile : yield* repo.projectProfile(scope.project)
        const inv: Inventory = {
          project: scope._tag === "Project",
          ownSkills: scope._tag === "Project" ? yield* repo.skills(scope.project) : [],
          ownServers: scope._tag === "Project" ? yield* repo.servers(scope.project) : [],
          globalSkills: yield* repo.skills(null),
          globalServers: yield* repo.servers(null),
          profileSwitches: profile === null ? {} : yield* repo.switches("profile", profile),
          projectSwitches: scope._tag === "Project" ? yield* repo.switches("project", scope.project) : {},
        }
        return inv
      })

      const checkProject = Effect.fnUntraced(function* (id: ProjectId | null) {
        if (id === null) return null
        const profile = yield* repo.projectProfile(id)
        if (profile === null) return yield* new ToolNotFound({ what: "project", id })
        return profile
      })

      const overview = Effect.fnUntraced(function* (id: ProjectId) {
        const profile = yield* checkProject(id)
        const o = yield* repo.overrides(id)
        const view: ProjectAgentTools = {
          skills: yield* repo.skills(id),
          mcp_servers: yield* repo.servers(id),
          disabled_skills: o.disabled_skills,
          disabled_mcp_servers: o.disabled_mcp_servers,
          seen: o.seen,
          global_skills: yield* repo.skills(null),
          global_mcp_servers: yield* repo.servers(null),
          skill_sources: yield* repo.sources,
          profile_switches: profile === null ? {} : yield* repo.switches("profile", profile),
          project_switches: yield* repo.switches("project", id),
        }
        return view
      })

      const global = Effect.gen(function* () {
        const view: GlobalAgentTools = {
          skills: yield* repo.skills(null),
          mcp_servers: yield* repo.servers(null),
          skill_sources: yield* repo.sources,
          profile_switches: yield* repo.profileSwitches,
        }
        return view
      }).pipe(Effect.withSpan("AgentTools.global"))

      // ---- changing ----

      const updateProject = Effect.fn("AgentTools.updateProject")(function* (id: ProjectId, patch: ProjectAgentToolsPatch) {
        yield* checkProject(id)
        yield* db.tx(
          Effect.gen(function* () {
            let o: Overrides = yield* repo.overrides(id)
            if (patch.disabled_skills !== undefined)
              o = { ...o, disabled_skills: yield* Effect.fromResult(checkDisabledSkills(o.disabled_skills, tidy(patch.disabled_skills))) }
            if (patch.disabled_mcp_servers !== undefined) {
              // Servers' names can be anything (claude.ai connectors have spaces): `toolPrefix` makes them tool names.
              if (patch.disabled_mcp_servers.some((n) => isBoardServer(n.trim())))
                return yield* new ToolInvalid({ field: "disabled_mcp_servers", reason: "huntaway can't be turned off" })
              o = { ...o, disabled_mcp_servers: tidy(patch.disabled_mcp_servers) }
            }
            return yield* repo.saveOverrides(id, o)
          }),
        )
        return yield* overview(id)
      })

      const setSwitch = Effect.fn("AgentTools.setSwitch")(function* (input: AgentToolSwitch) {
        const exists = input.scope === "profile" ? yield* repo.profileExists(input.scope_id) : (yield* repo.projectProfile(input.scope_id)) !== null
        if (!exists) return yield* new ToolNotFound({ what: input.scope, id: input.scope_id })
        return yield* db.tx(
          Effect.gen(function* () {
            let items: ReadonlyArray<string>
            if (input.item_id !== undefined && input.item_id !== null) {
              const id = input.item_id
              if ((yield* repo.skill(null, id)) === null && (yield* repo.server(null, id)) === null)
                return yield* new ToolNotFound({ what: "global skill or MCP server", id })
              items = [id]
            } else if (input.source_id !== undefined && input.source_id !== null) {
              if ((yield* repo.source(input.source_id)) === null) return yield* new ToolNotFound({ what: "skill source", id: input.source_id })
              items = (yield* repo.skillsOfSource(input.source_id)).map((s) => s.id)
            } else return yield* new ToolInvalid({ field: "item_id", reason: "item_id or source_id is needed" })
            return yield* Effect.forEach(items, (item) => repo.setSwitch(input.scope, input.scope_id, item, input.enabled), {
              concurrency: 1,
              discard: true,
            })
          }),
        )
      })

      const unique = (table: ToolTable, owner: ProjectId | null, name: string, except: string | null) =>
        Effect.flatMap(repo.nameTaken(table, owner, name, except), (taken) =>
          taken
            ? Effect.fail(new ToolConflict({ detail: `there's already one named ${name} ${owner !== null ? "in this project" : "on this host"}` }))
            : Effect.void,
        )

      /**
       * A board skill was renamed or deleted: runs that had it reported it by its old name, which mustn't stay in the `/`
       * menu, so it's forgotten wherever no skill of the board's has that name now. In the change's transaction.
       */
      const forgetBoardSkill = Effect.fnUntraced(function* (owner: ProjectId | null, name: string) {
        for (const id of owner !== null ? [owner] : yield* repo.projectsWithOverrides) {
          if ((yield* repo.projectProfile(id)) === null) continue
          if (effective(yield* inventory(projectScope(id))).skills.some((s) => s.name === name)) continue
          const o = yield* repo.overrides(id)
          yield* repo.saveOverrides(id, { ...o, seen: forgetSkill(o.seen, name) })
        }
      })

      const loadSkill = (owner: ProjectId | null, id: string) =>
        repo.skill(owner, id).pipe(
          Effect.filterOrFail(
            (s): s is SkillRow => s !== null,
            () => new ToolNotFound({ what: "skill", id }),
          ),
        )
      const loadServer = (owner: ProjectId | null, id: string) =>
        repo.server(owner, id).pipe(
          Effect.filterOrFail(
            (s): s is McpServer => s !== null,
            () => new ToolNotFound({ what: "MCP server", id }),
          ),
        )

      const addSkill = Effect.fn("AgentTools.addSkill")(function* (owner: ProjectId | null, input: SkillInput) {
        yield* checkProject(owner)
        const content = input.content ?? ""
        const f = yield* Effect.fromResult(checkSkill(content))
        const id = SkillId.make(yield* newId)
        const at = yield* nowTimestamp
        yield* db.tx(
          Effect.gen(function* () {
            yield* unique("agent_skills", owner, f.name, null)
            yield* repo.insertSkill({ id, project_id: owner, name: f.name, content, enabled: input.enabled ?? true }, at)
          }),
        )
        return wire(yield* loadSkill(owner, id))
      })

      const updateSkill = Effect.fn("AgentTools.updateSkill")(function* (owner: ProjectId | null, id: string, input: SkillInput) {
        const at = yield* nowTimestamp
        yield* db.tx(
          Effect.gen(function* () {
            const skill = yield* loadSkill(owner, id)
            if (skill.source_id !== null && input.content !== undefined)
              return yield* new ToolInvalid({
                field: "content",
                reason: "this skill comes from a skill source: change it in its repository, then update the source",
              })
            let name = skill.name
            let content = skill.content
            if (input.content !== undefined) {
              name = (yield* Effect.fromResult(checkSkill(input.content))).name
              yield* unique("agent_skills", owner, name, id)
              content = input.content
            }
            yield* repo.updateSkill(id, { name, content, enabled: input.enabled ?? skill.enabled }, at)
            return yield* name !== skill.name ? forgetBoardSkill(owner, skill.name) : Effect.void
          }),
        )
        return wire(yield* loadSkill(owner, id))
      })

      const removeSkill = Effect.fn("AgentTools.removeSkill")(function* (owner: ProjectId | null, id: string) {
        yield* db.tx(
          Effect.gen(function* () {
            const skill = yield* loadSkill(owner, id)
            if (skill.source_id !== null)
              return yield* new ToolInvalid({ field: "id", reason: "this skill comes from a skill source: remove the source to delete its skills" })
            yield* repo.remove("agent_skills", owner, id)
            return yield* forgetBoardSkill(owner, skill.name)
          }),
        )
      })

      const addServer = Effect.fn("AgentTools.addServer")(function* (owner: ProjectId | null, input: McpServerInput) {
        yield* checkProject(owner)
        const name = yield* Effect.fromResult(checkServerName((input.name ?? "").trim()))
        const serverConfig = yield* Effect.fromResult(checkServerConfig(input.config ?? null))
        const id = McpServerId.make(yield* newId)
        const at = yield* nowTimestamp
        yield* db.tx(
          Effect.gen(function* () {
            yield* unique("agent_mcp_servers", owner, name, null)
            yield* repo.insertServer(id, owner, { name, config: serverConfig, enabled: input.enabled ?? true, auto_allow: input.auto_allow ?? false }, at)
          }),
        )
        return yield* loadServer(owner, id)
      })

      const updateServer = Effect.fn("AgentTools.updateServer")(function* (owner: ProjectId | null, id: string, input: McpServerInput) {
        const at = yield* nowTimestamp
        yield* db.tx(
          Effect.gen(function* () {
            const server = yield* loadServer(owner, id)
            let name = server.name
            if (input.name !== undefined) {
              name = yield* Effect.fromResult(checkServerName(input.name.trim()))
              yield* unique("agent_mcp_servers", owner, name, id)
            }
            const serverConfig = input.config !== undefined && input.config !== null ? yield* Effect.fromResult(checkServerConfig(input.config)) : server.config
            yield* repo.updateServer(
              id,
              { name, config: serverConfig, enabled: input.enabled ?? server.enabled, auto_allow: input.auto_allow ?? server.auto_allow },
              at,
            )
          }),
        )
        return yield* loadServer(owner, id)
      })

      const removeServer = (owner: ProjectId | null, id: string) =>
        repo.remove("agent_mcp_servers", owner, id).pipe(
          Effect.filterOrFail(
            (removed) => removed,
            () => new ToolNotFound({ what: "MCP server", id }),
          ),
          Effect.asVoid,
          Effect.withSpan("AgentTools.removeServer"),
        )

      // ---- skill sources ----

      /** Shallow-clones `url` into `dest` (which mustn't exist), and returns the commit it's at. */
      const clone = Effect.fnUntraced(function* (url: string, ref: string | null, dest: string) {
        const args = ["clone", "--depth", "1", "--single-branch", "--no-tags", "--quiet", ...(ref === null ? [] : ["--branch", ref]), "--", url, dest]
        // Only the transports we accept (not `ext::`, which runs commands).
        const env = { GIT_ALLOW_PROTOCOL: "https:http:ssh:git:file", ...(ownSsh ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }) }
        const out = yield* git
          .run(sourcesRoot, args, { env, timeout: CLONE_TIMEOUT })
          .pipe(Effect.mapError((e) => new SourceFailed({ reason: e.reason.startsWith("timed out") ? `cloning ${url} took more than 180 seconds` : e.reason })))
        if (!out.ok) {
          const why = out.stderr
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l !== "")
            .slice(-3)
            .join(" ")
          // GitHub answers for a repository that isn't there as it does for a private one.
          const hint = why.includes("terminal prompts disabled")
            ? " (the repository may not exist, or it's private and this host has no git credentials for it)"
            : ""
          return yield* new SourceFailed({ reason: `couldn't clone ${url}${ref !== null ? ` at ${ref}` : ""}: ${why}${hint}` })
        }
        const head = yield* git.run(dest, ["rev-parse", "HEAD"]).pipe(Effect.orElseSucceed(() => ({ stdout: "" })))
        return head.stdout.trim()
      })

      const removeDir = (dir: string) => fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore)

      /** A fresh clone of a source and the skills in it, in a folder beside where it will go. */
      const fetch = Effect.fnUntraced(function* (id: string, url: string, ref: string | null, subdir: string | null) {
        yield* fs.makeDirectory(sourcesRoot, { recursive: true }).pipe(Effect.ignore)
        const dir = `${sourcesRoot}/${id}.new`
        yield* removeDir(dir)
        return yield* Effect.gen(function* () {
          const commit = yield* clone(url, ref, dir)
          const { found, notes } = yield* discover(fs, dir, subdir)
          return { dir, commit, found, notes }
        }).pipe(Effect.tapError(() => removeDir(dir)))
      })

      /** Puts a fetched clone where the source's is, in place of the one before (swapped by renames). */
      const install = Effect.fnUntraced(function* (id: string, dir: string) {
        const live = `${sourcesRoot}/${id}`
        const old = `${sourcesRoot}/${id}.old`
        yield* removeDir(old)
        if (yield* fs.exists(live).pipe(Effect.orElseSucceed(() => false))) yield* fs.rename(live, old).pipe(Effect.ignore)
        yield* fs
          .rename(dir, live)
          .pipe(
            Effect.catch((e) =>
              Effect.andThen(
                fs.rename(old, live).pipe(Effect.ignore),
                Effect.fail(new SourceFailed({ reason: `couldn't put the clone in place: ${e.message}` })),
              ),
            ),
          )
        yield* removeDir(old)
      })

      /** Brings a source's skills in line with a fresh clone, all or nothing: what was left out. */
      const apply = Effect.fnUntraced(function* (id: SkillSourceId, found: ReadonlyArray<Found>, notes: ReadonlyArray<string>) {
        const at = yield* nowTimestamp
        const newIds = yield* Effect.forEach(found, () => Effect.map(newId, (fresh) => SkillId.make(fresh)), { concurrency: 1 })
        return yield* db.tx(
          Effect.gen(function* () {
            const existing = yield* repo.skillsOfSource(id)
            const others = (yield* repo.skills(null)).filter((s) => s.source_id !== id)
            const plan = planSource(existing, found, notes, (name) => others.some((s) => s.name === name))
            const inserts = plan.insert.flatMap((f, i) => {
              const fresh = newIds[i]
              return fresh === undefined ? [] : [[fresh, f] as const]
            })
            yield* repo.applySource(id, plan, inserts, at)
            for (const name of plan.forget) yield* forgetBoardSkill(null, name)
            return plan.notes
          }),
        )
      })

      const synced = (id: string) =>
        Effect.gen(function* () {
          const source = yield* repo.source(id)
          if (source === null) return yield* Effect.die(`skill source ${id} went`)
          const view: SkillSourceSynced = { source, skills: (yield* repo.skillsOfSource(id)).map(wire) }
          return view
        })

      const addSource = Effect.fn("AgentTools.addSource")(function* (input: {
        readonly url: string
        readonly ref?: string | null | undefined
        readonly subdir?: string | null | undefined
      }) {
        const url = yield* Effect.fromResult(normalizeUrl(input.url))
        const ref = yield* Effect.fromResult(checkRef(input.ref))
        const subdir = yield* Effect.fromResult(checkSubdir(input.subdir))
        return yield* busy.withPermits(1)(
          Effect.gen(function* () {
            if ((yield* repo.sources).some((o) => o.url === url && o.ref === ref && o.subdir === subdir))
              return yield* new ToolConflict({ detail: "that repository is already added: update it instead" })
            const id = SkillSourceId.make(yield* newId)
            const fetched = yield* fetch(id, url, ref, subdir)
            yield* install(id, fetched.dir)
            yield* repo.insertSource({ id, url, ref, subdir, name: sourceName(url), commit: fetched.commit }, yield* nowTimestamp)
            const notes = yield* apply(id, fetched.found, fetched.notes)
            if ((yield* repo.skillsOfSource(id)).length === 0) {
              // Nothing in it could be added: it isn't a source.
              yield* repo.removeSource(id)
              yield* removeDir(`${sourcesRoot}/${id}`)
              const why = notes.length > 0 ? ` (${notes.join("; ")})` : ""
              return yield* new ToolInvalid({
                field: "url",
                reason: `no skills found in ${url}${subdir !== null ? `/${subdir}` : ""}: a skill is a folder with a SKILL.md${why}`,
              })
            }
            yield* repo.sourceNotes(id, notes)
            return yield* synced(id)
          }),
        )
      })

      const updateSource = Effect.fn("AgentTools.updateSource")(function* (id: string) {
        return yield* busy.withPermits(1)(
          Effect.gen(function* () {
            const source = yield* repo.source(id)
            if (source === null) return yield* new ToolNotFound({ what: "skill source", id })
            const fetched = yield* fetch(source.id, source.url, source.ref, source.subdir).pipe(Effect.tapError((e) => repo.sourceFailed(source.id, e.reason)))
            yield* install(source.id, fetched.dir)
            const notes = yield* apply(source.id, fetched.found, fetched.notes)
            yield* repo.sourceSynced(source.id, { commit: fetched.commit, notes }, yield* nowTimestamp)
            return yield* synced(source.id)
          }),
        )
      })

      const removeSource = Effect.fn("AgentTools.removeSource")(function* (id: string) {
        return yield* busy.withPermits(1)(
          Effect.gen(function* () {
            if ((yield* repo.source(id)) === null) return yield* new ToolNotFound({ what: "skill source", id })
            yield* db.tx(
              Effect.gen(function* () {
                const skills = yield* repo.skillsOfSource(id)
                yield* repo.removeSource(id)
                for (const s of skills) yield* forgetBoardSkill(null, s.name)
              }),
            )
            return yield* removeDir(`${sourcesRoot}/${id}`)
          }),
        )
      })

      // ---- runs ----

      /** Where a review or summary thread with skills of its own has them, so the project's other runs don't lose or gain them. */
      const threadSkillsRoot = (project: ProjectId, thread: TaskId) => `${dataDir.projectDir(project)}/agent-threads/${thread}`

      const runTools = Effect.fnUntraced(function* (scope: Scope, sync: boolean) {
        let { skills, servers } = effective(yield* inventory(scope))
        let o: Overrides = noOverrides
        let root: string
        if (scope._tag === "Project") {
          const thread = scope.thread === null ? null : yield* repo.threadTools(scope.thread)
          if (thread !== null && thread.skills.length > 0) skills = effective(yield* inventory(scope), thread.skills).skills
          o = yield* repo.overrides(scope.project)
          // A workflow's agent step can turn some of them off for its thread.
          const off = thread?.disabled_mcp_servers ?? []
          if (off.length > 0) {
            servers = servers.filter((s) => !off.includes(s.name))
            o = { ...o, disabled_mcp_servers: [...o.disabled_mcp_servers, ...off] }
          }
          root =
            scope.thread !== null && thread !== null && thread.skills.length > 0
              ? threadSkillsRoot(scope.project, scope.thread)
              : `${dataDir.projectDir(scope.project)}/agent`
        } else root = `${dataDir.profileDir(scope.profile)}/agent`
        if (sync) yield* syncSkills(fs, `${root}/.claude/skills`, skills, sourcesRoot)
        const tools: RunTools = {
          skills_dir: skills.length > 0 ? root : null,
          mcp_servers: Object.fromEntries(servers.map((s) => [s.name, s.config])),
          allowed: servers.filter((s) => s.auto_allow).map((s) => toolPrefix(s.name)),
          // Lists saved before names were checked may have bad ones.
          disallowed: [...o.disabled_skills.filter(validOtherSkill).map((n) => `Skill(${n})`), ...o.disabled_mcp_servers.map(toolPrefix)],
        }
        return tools
      })

      const forTask = (sync: boolean) => (task: ToolTask) => {
        const scope = scopeOf(task)
        return scope === null ? Effect.succeed(noRunTools) : runTools(scope, sync)
      }

      const recordSeen = Effect.fn("AgentTools.recordSeen")(function* (id: TaskId, init: InitTools) {
        const task = yield* tasks.get(id)
        if (task === null || task.project_id === null) return
        const project = task.project_id
        if ((yield* repo.projectProfile(project)) === null) return
        // The skills a review thread has on top of its project's aren't the project's to list or turn off.
        const extra = task.kind === "review" ? (yield* repo.threadTools(task.id)).skills : []
        const reported = Array.isArray(init.skills) ? init.skills.filter((s) => !(typeof s === "string" && extra.includes(s))) : init.skills
        const now = yield* DateTime.now
        const at = DateTime.formatIso(now)
        const cutoff = DateTime.formatIso(DateTime.subtract(now, { days: SEEN_DAYS }))
        const board = effective(yield* inventory(projectScope(project))).skills.map((s) => s.name)
        const key = task.claude_config_id ?? ""
        const o = yield* repo.overrides(project)
        const seen = mergeSeen(o.seen[key], { skills: reported, mcp_servers: init.mcp_servers }, board, at, cutoff)
        yield* repo.saveOverrides(project, { ...o, seen: { ...o.seen, [key]: seen } })
      })

      /** The config a thread runs on: its own, else (with no conversation yet) its first available. */
      const configOf = Effect.fnUntraced(function* (task: Task) {
        if (task.claude_config_id !== null) {
          const own = yield* configs.get(task.claude_config_id)
          if (Option.isSome(own)) return own.value
        } else if (task.session_id !== null) return null
        const project = task.project_id === null ? null : yield* tasks.project(task.project_id)
        const [first] = yield* tasks.configs(task.profile_id, project)
        return first === undefined ? null : Option.getOrNull(yield* configs.get(first))
      })

      /**
       * Where a task's agent runs and the folders it's given, for the skills it finds there: a review thread in the
       * reviewed task's worktree; a task in its worktree once it is set up, else its project's checkout; one in no
       * project in its profile's scratch folder. A labelled task reads its documents folder, a group task its group's
       * repositories.
       */
      const skillPlaces = Effect.fnUntraced(function* (task: Task, repoPath: string | null) {
        const parent = task.kind === "review" && task.parent_id !== null ? yield* tasks.get(task.parent_id) : null
        const cwd = repoPath !== null ? ((parent !== null ? ready(parent) : ready(task)) ?? repoPath) : `${dataDir.profileDir(task.profile_id)}/scratch`
        const addDirs: Array<string> = []
        if (task.kind === "task" && task.labels.length > 0) addDirs.push(dataDir.documents(task.id))
        if (task.group_name !== null && task.project_id === null && task.kind === "task")
          addDirs.push(
            ...(yield* projects.list(task.profile_id)).filter((p) => p.group_name === task.group_name && p.archived_at === null).map((p) => p.repo_path),
          )
        return { cwd: expand(cwd), addDirs: addDirs.map(expand) }
      })

      const taskSkills = Effect.fn("AgentTools.taskSkills")(function* (id: TaskId) {
        const task = yield* tasks.get(id)
        if (task === null) return yield* new TaskNotFound({ id })
        const cfg: AgentConfigRow | null = yield* configOf(task)
        const project = task.project_id === null ? null : Option.getOrNull(yield* projects.get(task.project_id))
        const { cwd, addDirs } = yield* skillPlaces(task, project?.repo_path ?? null)
        let board: ReadonlyArray<SkillRow> = []
        let off: ReadonlyArray<string> = []
        let o: Overrides = noOverrides
        const scope = scopeOf(task)
        if (project !== null && scope !== null) {
          const inv = yield* inventory(projectScope(project.id))
          const extra = task.kind === "review" ? (yield* repo.threadTools(task.id)).skills : []
          board = effective(inv, extra).skills
          off = boardSkillsOff(inv, board)
          o = yield* repo.overrides(project.id)
        } else if (scope !== null) {
          // A profile's assistant (and its routine threads) has the global skills its profile switches on.
          const inv = yield* inventory(scope)
          board = effective(inv).skills
          off = inv.globalSkills.map((s) => s.name).filter((n) => !board.some((s) => s.name === n))
        }
        const isCodex = cfg?.agent === "codex"
        let found: ReadonlyArray<TaskSkill>
        if (isCodex && cfg !== null) {
          // Codex finds a repository's skills from where it runs; it doesn't read added folders.
          found = yield* codex.skills(cfg, cwd).pipe(
            Effect.tapError((e) => Effect.logWarning(`listing Codex skills: ${e.reason}`)),
            Effect.orElseSucceed(() => []),
          )
        } else {
          const dir = expand(nonBlank(cfg?.config_dir) ?? "~/.claude")
          // The board's own skills the last run had that are off now aren't given to runs any more.
          const seen = reportedSkills(o.seen[cfg?.id ?? ""], board, off)
          found = yield* claudeSkills(fs, dir, [cwd, ...addDirs], project === null ? null : expand(project.repo_path), seen)
        }
        const result: TaskSkills = { agent: isCodex ? "codex" : "claude", skills: withBoardSkills(found, board, isCodex, o.disabled_skills) }
        return result
      })

      return AgentTools.of({
        global,
        project: overview,
        updateProject,
        setSwitch,
        addSkill,
        updateSkill,
        removeSkill,
        addServer,
        updateServer,
        removeServer,
        addSource,
        updateSource,
        removeSource,
        forRun: forTask(true),
        preview: forTask(false),
        recordSeen,
        taskSkills,
        removeThreadSkills: (project, thread) => removeDir(threadSkillsRoot(project, thread)),
      })
    }),
  )
}
