import { Config, Context, Effect, FileSystem, Layer, Option, Redacted } from "effect"
import { SecureRandom } from "effect/crypto"
import type { AgentConfigId, PermissionMode, Task, TaskId } from "@huntaway/contracts"
import type { LaunchSpec } from "../agents/AgentDriver.ts"
import { ApprovalRules } from "../agents/ApprovalRules.ts"
import { cacheDirsIn, codexEffort, noRunTools, reviewFilesystem } from "../agents/claude/access.ts"
import { claudeLaunch, recordedEffort } from "../agents/claude/launch.ts"
import { codexLaunch } from "../agents/codex/launch.ts"
import type { LaunchRefused } from "../agents/codex/launch.ts"
import { isClaudeModel } from "../agents/codex/spec.ts"
import { CodexQueries } from "../agents/CodexQueries.ts"
import { Prompts } from "../agents/Prompts.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Identity } from "../platform/Identity.ts"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import type { AgentConfigRow } from "../profiles/AgentConfigRepo.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskTmp } from "../tasks/TaskTmp.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { AgentRequests } from "./AgentRequests.ts"
import { BackgroundWork } from "./BackgroundWork.ts"
import type { Run } from "./Run.ts"
import { RunDir } from "./RunDir.ts"
import { RunRepo } from "./RunRepo.ts"

// What a run's launch is made of (huntaway's runner/launch.ts, its preparing half; inventory 01, section 2 "Prepare"):
// the facts gathered from the areas for `claudeLaunch`, which is pure. Worktrees and checkpoints (M4), the task's temp
// folder and its lost background work (2.8), the project's own tools (`AgentTools`), attachments' folders, telemetry's
// environment and Codex (M5) join here with their areas.

export interface Prepared {
  readonly spec: LaunchSpec
  /** The run may write its task's documents folder (it started with labels). */
  readonly writesDocuments: boolean
}

/** Trimmed, or null when blank. */
const nonBlank = (s: string | null | undefined): string | null => {
  const t = s?.trim()
  return t === undefined || t === "" ? null : t
}

/** Agents' own settings, which stay read-only to a Codex reviewer even when git ignores them. */
const AGENT_DIRS: ReadonlySet<string> = new Set([".git", ".claude", ".codex", ".agents"])
/** Most git-ignored directories a Codex reviewer may write. */
const MAX_IGNORED_DIRS = 200

/** The thread types that pick their config from their profile (the old `thread_config_key`): the assistant's and the pens'. */
const threadConfigKey = (task: Task): "assistant_config_id" | "threads_config_id" | null => {
  if (task.kind !== "task" || task.project_id !== null) return null
  if (task.task_type === "assistant" || task.task_type === "routine") return "assistant_config_id"
  if (task.task_type === "pens" || task.task_type === "pen") return "threads_config_id"
  return null
}

export interface LaunchFactsShape {
  /** Everything a run is launched with, by its thread's config's agent (Claude's, or Codex's: 5.2). */
  readonly launch: (run: Run, text: string) => Effect.Effect<Prepared, TaskNotFound | LaunchRefused>
  /** Everything a Claude run of `run` is launched with, its folder's contents included: prepared for `RunDir.prepare` and `Shim.spawn`. */
  readonly claude: (run: Run, text: string) => Effect.Effect<Prepared, TaskNotFound>
  /** The config a thread runs on (the old `task_claude_config`): its own, else (with no conversation yet) its first available. */
  readonly config: (task: Task) => Effect.Effect<AgentConfigRow | null>
  /** A task's documents folder. */
  readonly documentsOf: (task: TaskId) => string
  /**
   * The config a new conversation of the assistant's or the pens' threads starts with (the old `thread_config`): the one
   * its profile picks, if still one of its configs, else its first; undefined for other threads (they keep theirs).
   */
  readonly threadConfig: (task: Task) => Effect.Effect<AgentConfigId | null | undefined>
}

export class LaunchFacts extends Context.Service<LaunchFacts, LaunchFactsShape>()("huntaway-server/runs/LaunchFacts") {
  static readonly layer = Layer.effect(
    LaunchFacts,
    Effect.gen(function* () {
      const tasks = yield* TaskRepo
      const projects = yield* ProjectRepo
      const profiles = yield* ProfileRepo
      const configs = yield* AgentConfigRepo
      const settings = yield* HostSettings
      const rules = yield* ApprovalRules
      const prompts = yield* Prompts
      const dataDir = yield* DataDir
      const config = yield* ServerConfig
      const identity = yield* Identity
      const requests = yield* AgentRequests
      const runs = yield* RunRepo
      const dir = yield* RunDir
      const fs = yield* FileSystem.FileSystem
      const random = yield* SecureRandom.SecureRandom
      const taskTmp = yield* TaskTmp
      const background = yield* BackgroundWork
      const queries = yield* CodexQueries
      const proc = yield* Proc
      // Where the package managers' caches are, when the environment says (Codex's sandbox would keep them read-only).
      const cacheEnv: Readonly<Record<string, string | null>> = Object.fromEntries(
        yield* Effect.forEach(
          ["CARGO_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"],
          (name) => Effect.map(Config.String(name).pipe(Config.option), (v) => [name, Option.getOrNull(v)] as const),
          { concurrency: 1 },
        ),
      )

      const expand = (path: string) => (path === "~" ? config.home : path.startsWith("~/") ? `${config.home}${path.slice(1)}` : path)
      const exists = (path: string) => fs.exists(expand(path)).pipe(Effect.orElseSucceed(() => false))
      const mkdir = (path: string) => fs.makeDirectory(path, { recursive: true }).pipe(Effect.ignore)

      const load = Effect.fnUntraced(function* (id: TaskId) {
        const task = yield* tasks.get(id)
        if (task === null) return yield* new TaskNotFound({ id })
        return task
      })

      /** The config a thread runs on (the old `task_claude_config`): its own, else (with no conversation yet) its first available. */
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
       * The config folder for the thread (the old `task_config_dir`): a thread with a conversation goes on in the folder
       * it started in, unless that folder is gone or not known; else its config's. Null for the agent's default.
       */
      const configDirOf = Effect.fnUntraced(function* (task: Task, cfg: AgentConfigRow | null) {
        const current = nonBlank(cfg?.config_dir)
        if (task.session_id === null) return current
        const was = Option.map(yield* runs.sessionConfigDir(task.id, task.session_id), (d) => d.trim())
        if (Option.isNone(was) || was.value === (current ?? "")) return current
        if (was.value === "") return null
        return (yield* exists(was.value)) ? was.value : current
      })

      /** The proxy a config sends its agents through (its own `api_url`): its URL and key; nothing without one. */
      const apiEnv = Effect.fnUntraced(function* (cfg: AgentConfigRow | null) {
        const url = cfg === null || cfg.agent === "codex" ? null : nonBlank(cfg.api_url)
        if (cfg === null || url === null) return []
        const keys = yield* configs.keys(cfg.id)
        const key = keys.api_key === null ? "" : Redacted.value(keys.api_key)
        // ANTHROPIC_API_KEY is emptied: Claude Code would send it to the proxy instead of the proxy's key.
        const env: ReadonlyArray<readonly [string, string]> = [
          ["ANTHROPIC_BASE_URL", url.replace(/\/+$/u, "")],
          ["ANTHROPIC_AUTH_TOKEN", key],
          ["ANTHROPIC_API_KEY", ""],
        ]
        return env
      })

      /** Where the thread's agent works: its worktree, its project's repository, or its profile's scratch folder. */
      const cwdOf = Effect.fnUntraced(function* (task: Task, repo: string | null) {
        if (task.kind === "review" && task.parent_id !== null) {
          const parent = yield* tasks.get(task.parent_id)
          if (parent?.worktree_path != null && parent.worktree_state === "ready") return parent.worktree_path
        }
        if (task.worktree_path !== null) return task.worktree_path
        if (repo !== null) return repo
        const scratch = `${dataDir.profileDir(task.profile_id)}/scratch`
        yield* mkdir(scratch)
        return scratch
      })

      const claude = Effect.fn("LaunchFacts.claude")(function* (run: Run, text: string) {
        let task = yield* load(run.task_id)
        const project = task.project_id === null ? null : Option.getOrNull(yield* projects.get(task.project_id))
        const profile = Option.getOrNull(yield* profiles.get(task.profile_id))
        const host = yield* settings.get
        const cfg = yield* configOf(task)
        // A thread created while its profile had no configs takes the default it has now, and keeps it with its
        // conversation.
        if (task.claude_config_id === null && task.session_id === null && cfg !== null) {
          yield* tasks.write(task.id, { claude_config_id: cfg.id }, run.created_at)
          task = yield* load(task.id)
        }
        const compact = run.kind === "compact"
        const cwd = yield* cwdOf(task, project?.repo_path ?? null)
        // A labelled task's agent writes its documents in the task's own folder, wherever it works.
        const docs = task.kind === "task" && task.labels.length > 0 ? dataDir.documents(task.id) : null
        if (docs !== null) yield* mkdir(docs)
        // A group task plans across its group's projects, so it can read their repositories.
        const group =
          task.group_name !== null && project === null && task.kind === "task" && profile !== null
            ? (yield* projects.list(profile.id)).filter((p) => p.group_name === task.group_name && p.archived_at === null).map((p) => p.repo_path)
            : []
        const permissionMode: PermissionMode = task.permission_mode ?? project?.permission_mode ?? host.default_permission_mode ?? "default"
        const model = nonBlank(task.model) ?? nonBlank(project?.model) ?? nonBlank(profile?.default_model) ?? nonBlank(host.default_model)
        const effort = nonBlank(task.effort) ?? nonBlank(host.default_effort)
        // What the end of its last run stopped of its background work, which it never heard about: once.
        const prompt = compact ? text : yield* prompts.start(task.id, text, yield* background.takeLost(task.id))
        // The task's own temp folder, its TMPDIR, which goes once it's done.
        const tmp = yield* taskTmp.ensure(task)
        const systemPrompt = yield* prompts.system(task.id, { codex: false, permission_mode: permissionMode, tmp })
        const configDir = yield* configDirOf(task, cfg)
        const review = task.kind === "review"
        const spec = yield* claudeLaunch({
          run: run.id,
          runDir: dir.path(run.id),
          kind: run.kind,
          task,
          cwd,
          program: config.claudeBin,
          exe: config.exe,
          home: config.home,
          configDir,
          apiEnv: yield* apiEnv(cfg),
          telemetryEnv: [],
          tmp,
          resumeAt: null,
          model,
          effort,
          permissionMode,
          rules: yield* rules.forTask(task),
          tools: noRunTools,
          served: yield* requests.served,
          githubAccount: nonBlank(project?.github_account) ?? nonBlank(profile?.github_account),
          addDirs: [...group, ...(docs !== null && docs !== cwd ? [docs] : [])],
          attachmentDirs: [],
          prompt,
          promptId: yield* random.uuidV4(),
          systemPrompt,
          mcp: {
            url: `http://127.0.0.1:${config.port}/api/mcp/${encodeURIComponent(run.id)}/`,
            secret: yield* identity.runSecret(run.id),
            manifest: yield* requests.manifest(review),
          },
        })
        // Where its conversation is kept, if it starts one, and the effort it was given (review statistics).
        yield* runs.update(run.id, { config_dir: configDir ?? "", effort: recordedEffort(effort) })
        const prepared: Prepared = { spec, writesDocuments: docs !== null }
        return prepared
      })

      // ---- Codex (5.2): the old launch's Codex half ----

      /** Git run in `cwd` (with `stdin`): its output, or null if it failed. */
      const git = Effect.fnUntraced(function* (cwd: string, args: ReadonlyArray<string>, stdin?: string) {
        const out = yield* proc.run("git", args, { cwd: expand(cwd), timeout: "30 seconds", ...(stdin === undefined ? {} : { stdin }) }).pipe(Effect.option)
        return Option.isSome(out) && out.value.code === 0 ? out.value.stdout : null
      })

      /**
       * The directories in `cwd` that git ignores as a whole (build output, installed packages): a reviewer may write them
       * without changing the work. Agents' own settings stay read-only. At most 200, absolute.
       */
      const ignoredDirs = Effect.fnUntraced(function* (cwd: string) {
        const root = expand(cwd)
        const listed = yield* git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])
        if (listed === null) return []
        // That lists untracked directories with only ignored files in them too.
        const candidates = listed
          .split("\0")
          .filter((p) => p.endsWith("/"))
          .map((p) => p.slice(0, -1))
          .filter((p) => !p.split("/").some((c) => AGENT_DIRS.has(c)))
          .slice(0, MAX_IGNORED_DIRS)
        if (candidates.length === 0) return []
        const ignored = yield* git(root, ["check-ignore", "-z", "--stdin"], candidates.join("\0"))
        return ignored === null ? [] : ignored.split("\0").flatMap((p) => (p === "" ? [] : [`${root}/${p}`]))
      })

      /** Package managers' caches, made if missing (those that can't be made are left out). */
      const cacheDirs = Effect.fnUntraced(function* () {
        const all = cacheDirsIn(config.home, (name) => cacheEnv[name] ?? null)
        const made = yield* Effect.forEach(
          all,
          (d) =>
            fs.makeDirectory(d, { recursive: true }).pipe(
              Effect.as([d]),
              Effect.orElseSucceed(() => []),
            ),
          {
            concurrency: 1,
          },
        )
        return made.flat()
      })

      const codex = Effect.fn("LaunchFacts.codex")(function* (run: Run, text: string, cfg: AgentConfigRow) {
        const task = yield* load(run.task_id)
        const project = task.project_id === null ? null : Option.getOrNull(yield* projects.get(task.project_id))
        const profile = Option.getOrNull(yield* profiles.get(task.profile_id))
        const host = yield* settings.get
        const compact = run.kind === "compact"
        const review = task.kind === "review"
        const cwd = yield* cwdOf(task, project?.repo_path ?? null)
        const docs = task.kind === "task" && task.labels.length > 0 ? dataDir.documents(task.id) : null
        if (docs !== null) yield* mkdir(docs)
        const permissionMode: PermissionMode = task.permission_mode ?? project?.permission_mode ?? host.default_permission_mode ?? "default"
        // Claude's models don't run on Codex; a thread's own pick is used as given.
        const model =
          nonBlank(task.model) ??
          [project?.model, profile?.default_model, host.default_model].map(nonBlank).find((m) => m !== null && !isClaudeModel(m)) ??
          null
        // Not every Codex model takes every effort: one the model doesn't take gives way to the model's own default
        // (when its models can be listed).
        const asked = nonBlank(task.effort) ?? nonBlank(host.default_effort)
        const effort = asked === null ? null : codexEffort(asked, model, yield* queries.models(cfg).pipe(Effect.orElseSucceed(() => [])))
        const prompt = compact ? "" : yield* prompts.start(task.id, text, yield* background.takeLost(task.id))
        const tmp = yield* taskTmp.ensure(task)
        const systemPrompt = yield* prompts.system(task.id, { codex: true, permission_mode: permissionMode, tmp })
        const configDir = yield* configDirOf(task, cfg)
        const gitDir = nonBlank(yield* git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
        const caches = yield* cacheDirs()
        const work = [expand(cwd), ...(gitDir === null ? [] : [gitDir])]
        const reviewFs = review && permissionMode !== "bypassPermissions" ? reviewFilesystem([...caches, ...(yield* ignoredDirs(cwd))], work) : null
        // A rewind's conversation rollback, for the session it was made in (4.3 clears what the run consumed).
        const rewind = task.rewind !== null && task.rewind.session === task.session_id ? (task.rewind.before_turn ?? null) : null
        const launched = yield* codexLaunch({
          run: run.id,
          runDir: dir.path(run.id),
          kind: run.kind,
          task,
          cwd,
          exe: config.exe,
          codexBin: config.codexBin,
          home: config.home,
          configDir,
          tmp,
          model,
          effort,
          permissionMode,
          rules: yield* rules.forTask(task),
          tools: noRunTools,
          served: yield* requests.served,
          githubAccount: nonBlank(project?.github_account) ?? nonBlank(profile?.github_account),
          systemPrompt,
          prompt,
          promptId: yield* random.uuidV4(),
          gitDir,
          cacheDirs: caches,
          documentsDir: docs !== null && docs !== cwd ? docs : null,
          reviewFilesystem: reviewFs,
          sessionBoardTools: task.session_id === null ? false : yield* runs.sessionBoardTools(task.id, task.session_id),
          revertBeforeTurn: rewind,
          configOverrides: [],
          mcp: {
            url: `http://127.0.0.1:${config.port}/api/mcp/${encodeURIComponent(run.id)}/`,
            secret: yield* identity.runSecret(run.id),
            manifest: yield* requests.manifest(review),
          },
        })
        yield* runs.update(run.id, { config_dir: configDir ?? "", effort: effort?.trim() ?? "", board_tools: launched.boardTools })
        const prepared: Prepared = { spec: launched.spec, writesDocuments: docs !== null }
        return prepared
      })

      /** A run's launch, by its thread's config's agent: Claude's, or Codex's. */
      const launch = Effect.fn("LaunchFacts.launch")(function* (run: Run, text: string) {
        const task = yield* load(run.task_id)
        const cfg = yield* configOf(task)
        if (cfg?.agent !== "codex") return yield* claude(run, text)
        // A thread created while its profile had no configs takes the default it has now, and keeps it with its
        // conversation.
        if (task.claude_config_id === null && task.session_id === null) yield* tasks.write(task.id, { claude_config_id: cfg.id }, run.created_at)
        return yield* codex(run, text, cfg)
      })

      const threadConfig = Effect.fnUntraced(function* (task: Task) {
        const key = threadConfigKey(task)
        if (key === null) return undefined
        const available = yield* tasks.configs(task.profile_id, null)
        const profile = Option.getOrNull(yield* profiles.get(task.profile_id))
        const picked = profile?.[key] ?? null
        return available.find((id) => id === picked) ?? available[0] ?? null
      })

      return LaunchFacts.of({ launch, claude, config: configOf, documentsOf: (task) => dataDir.documents(task), threadConfig })
    }),
  )
}
