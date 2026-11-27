import { Config, Context, Effect, FileSystem, Layer, Option, Redacted } from "effect"
import { SecureRandom } from "effect/crypto"
import type { AgentConfigId, PermissionMode, Project, Rewind, Task, TaskId } from "@huntaway/contracts"
import type { LaunchSpec } from "../agents/AgentDriver.ts"
import { ApprovalRules } from "../agents/ApprovalRules.ts"
import { AgentTools } from "../agents/AgentTools.ts"
import { launchStyle } from "../agents/agentTools/outputStyles.ts"
import { cacheDirsIn, codexEffort, DOCS_SERVER, reviewFilesystem } from "../agents/claude/access.ts"
import { acpLaunch } from "../agents/acp/launch.ts"
import { claudeLaunch, recordedEffort } from "../agents/claude/launch.ts"
import { codexLaunch, LaunchRefused } from "../agents/codex/launch.ts"
import { isClaudeModel } from "../agents/codex/spec.ts"
import { CodexQueries } from "../agents/CodexQueries.ts"
import { Prompts } from "../agents/Prompts.ts"
import { withPreface } from "../agents/prompts/start.ts"
import { Checkpoints, pendingRewind } from "../git/Checkpoints.ts"
import { Worktrees, WorktreeFailed } from "../git/Worktrees.ts"
import { Restack } from "../git/Restack.ts"
// 6.11: a launch waits for its project's folder to move.
import { Relocation } from "../git/Relocation.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Db } from "../platform/Db.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { Identity } from "../platform/Identity.ts"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { Listening } from "../platform/Listening.ts"
import { Telemetry } from "../platform/Telemetry.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import type { AgentConfigRow } from "../profiles/AgentConfigRepo.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { stackOf } from "../tasks/lanes.ts"
import { heldLevel } from "../tasks/StackThreads.ts"
import { isLead, takesGrant } from "./sets.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskTmp } from "../tasks/TaskTmp.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { AgentRequests } from "./AgentRequests.ts"
// 6.7: the assistant's workspace, memory and routines' reports.
import { AssistantLaunch } from "./AssistantLaunch.ts"
import type { ReportsRun, WorkspaceRefused, WorkspaceRun } from "./AssistantLaunch.ts"
import { BackgroundWork } from "./BackgroundWork.ts"
import type { Run } from "./Run.ts"
import { RunDir } from "./RunDir.ts"
import { RunRepo } from "./RunRepo.ts"

// What a run's launch is made of (huntaway's runner/launch.ts, its preparing half; inventory 01, section 2 "Prepare"):
// the facts gathered from the areas for `claudeLaunch`, which is pure. Worktrees and checkpoints (M4), the task's temp
// folder and its lost background work (2.8), attachments' folders, telemetry's
// environment and Codex (M5) join here with their areas.

export interface Prepared {
  readonly spec: LaunchSpec
  /** The run may write its task's documents folder (it started with labels). */
  readonly writesDocuments: boolean
  /** The conversation rollback a rewind asked for that the run makes (`Checkpoints.rewound` once its agent starts). */
  readonly rewind?: Rewind | null
  /**
   * 6.7: what's done once its agent has started (the assistant's routines' reports it starts with are read, and its
   * conversation was told its memory).
   */
  readonly started?: Effect.Effect<void> | undefined
  /** 6.9: what telemetry's `run_start` says of it: its agent, model, effort and mode, and whether it resumes a session. */
  readonly runStart?: { readonly runtime: string; readonly model: string; readonly effort: string; readonly permission_mode: string; readonly resume: boolean }
}

/** What's done once a run's agent has started: its conversation was told its memory, and has read its routines' reports. */
const startedWith = (workspace: WorkspaceRun | null, reports: ReportsRun | null): Effect.Effect<void> | undefined =>
  workspace === null && reports === null ? undefined : Effect.andThen(workspace?.told ?? Effect.void, reports?.started ?? Effect.void)

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
  /** Everything a run is launched with, by its thread's config's agent (Claude's, Codex's: 5.2, or an ACP agent's: HE-69). */
  readonly launch: (run: Run, text: string) => Effect.Effect<Prepared, TaskNotFound | LaunchRefused | WorktreeFailed | WorkspaceRefused>
  /** Everything a Claude run of `run` is launched with, its folder's contents included: prepared for `RunDir.prepare` and `Shim.spawn`. */
  readonly claude: (run: Run, text: string) => Effect.Effect<Prepared, TaskNotFound | WorktreeFailed | WorkspaceRefused>
  /** The config a thread runs on (the old `task_claude_config`): its own, else (with no conversation yet) its first available. */
  readonly config: (task: Task) => Effect.Effect<AgentConfigRow | null>
  /** A task's documents folder. */
  readonly documentsOf: (task: TaskId) => string
  /**
   * The config a new conversation of the assistant's or the pens' threads starts with (the old `thread_config`): the one
   * its profile picks, if still one of its configs, else its first; undefined for other threads (they keep theirs).
   */
  readonly threadConfig: (task: Task) => Effect.Effect<AgentConfigId | null | undefined>
  /**
   * 6.1: where the thread's agent works (its worktree while that is there), and what of its config a program run there
   * gets: the config folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` for a Codex config, `GEMINI_HOME` for an ACP one) and its
   * proxy. A task's terminal.
   */
  readonly workEnv: (task: Task) => Effect.Effect<{ readonly cwd: string; readonly env: Readonly<Record<string, string>> }>
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
      const listening = yield* Listening
      const identity = yield* Identity
      const requests = yield* AgentRequests
      const runs = yield* RunRepo
      const dir = yield* RunDir
      const fs = yield* FileSystem.FileSystem
      const random = yield* SecureRandom.SecureRandom
      const taskTmp = yield* TaskTmp
      const background = yield* BackgroundWork
      const checkpoints = yield* Checkpoints
      const worktrees = yield* Worktrees
      const restack = yield* Restack
      const relocation = yield* Relocation
      const threads = yield* Threads
      const queries = yield* CodexQueries
      const proc = yield* Proc
      // 6.4: the project's skills and servers (its skills written for the run).
      const agentTools = yield* AgentTools
      // 6.7
      const assistantLaunch = yield* AssistantLaunch
      // 6.9
      const telemetry = yield* Telemetry
      // HE-118: a set's lead is given its followers' worktrees under each follower's lock.
      const db = yield* Db
      const locks = yield* KeyedLock
      // Where the package managers' caches are, when the environment says (Codex's sandbox would keep them read-only).
      const cacheEnv: Readonly<Record<string, string | null>> = Object.fromEntries(
        yield* Effect.forEach(
          ["CARGO_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"],
          (name) => Effect.map(Config.String(name).pipe(Config.option), (v) => [name, Option.getOrNull(v)] as const),
          { concurrency: 1 },
        ),
      )

      const expand = (path: string) => (path === "~" ? config.home : path.startsWith("~/") ? `${config.home}${path.slice(1)}` : path)
      /** HE-118: the worktrees of the tasks a lead's run was given. */
      const dirsOf = (granted: ReadonlyArray<Task>) => granted.flatMap((t) => (t.worktree_path === null ? [] : [expand(t.worktree_path)]))
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
        const url = cfg === null || cfg.agent !== "claude" ? null : nonBlank(cfg.api_url)
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

      /**
       * Where the thread's agent works (the old `documents.work_dir`, then `runner.work_dir`): a task's own `work_dir` when
       * it has one (a scratch task's, a document task's from before labels, an imported one's in the old data folder:
       * relative to the data folder, `~` its home), so its sessions are found where they ran; a scratch task's or a pen's
       * thread's own folder (which lasts as long as it, for the pen's notes); its worktree; its project's repository; or
       * its profile's scratch folder.
       */
      const cwdOf = Effect.fnUntraced(function* (task: Task, repo: string | null) {
        if (task.kind === "task" && task.work_dir !== null && task.work_dir !== "") {
          const own = task.work_dir.startsWith("/") || task.work_dir.startsWith("~") ? expand(task.work_dir) : `${dataDir.root}/${task.work_dir}`
          yield* mkdir(own)
          return own
        }
        if (task.kind === "task" && (task.task_type === "pen" || task.task_type === "scratch")) {
          const own = dataDir.documents(task.id)
          yield* mkdir(own)
          return own
        }
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

      /**
       * HE-105: the worktrees a stack's own thread restacks in (its stack's open levels' that are set up), besides the
       * project's repository it works in; none for any other thread.
       */
      const stackDirs = Effect.fnUntraced(function* (task: Task) {
        if (task.kind !== "task" || task.task_type !== "stack" || task.parent_id === null || task.project_id === null) return []
        const parent = yield* tasks.get(task.parent_id)
        if (parent === null) return []
        const rows = (yield* tasks.projectTasks(task.project_id)).filter((t) => t.kind === "task" && t.profile_id === task.profile_id)
        // A level held on a deleted or closed one below is all that's left of its stack until the user says where it goes.
        const levels = stackOf(rows, parent)?.levels ?? (heldLevel(rows, parent) ? [parent] : [])
        return levels.flatMap((l) => (l.status !== "done" && l.worktree_state === "ready" && l.worktree_path !== null ? [expand(l.worktree_path)] : []))
      })

      /**
       * HE-118: a set's lead's worktree comes with the set's others: each open one not running is set up too (nothing for
       * one that's ready). A failure in one is the lead's, its thread saying which; the follower's own thread says why.
       */
      const setUpFollowers = Effect.fnUntraced(function* (lead: Task) {
        if (!isLead(lead)) return lead
        const set = yield* tasks.inSet(lead.id)
        for (const f of set.slice(1)) {
          if (f.status === "done" || f.running || (f.worktree_state === "ready" && f.worktree_path !== null && (yield* exists(f.worktree_path)))) continue
          yield* threads.notice(lead.id, "info", `Setting up ${f.key}'s worktree…`).pipe(Effect.ignore)
          const made = yield* Effect.result(worktrees.setup(f.id))
          if (made._tag === "Success") {
            yield* threads
              .notice(
                f.id,
                "info",
                `This task waits in To do while its lead, ${lead.key}, works in this worktree`,
                "Its own agent starts only for its own work: a review round's fixes, a merge conflict, or a message from the lead or the user.",
              )
              .pipe(Effect.ignore)
            continue
          }
          const e = made.failure
          if (e._tag === "TaskNotFound") continue
          const reason = e._tag === "AgentInWorktree" ? e.message : e.reason
          const project = f.project_id === null ? null : Option.getOrNull(yield* projects.get(f.project_id))
          const which = `${f.key}'s worktree${project === null ? "" : ` (${project.name}, ${project.repo_path})`}`
          yield* threads.notice(lead.id, "error", `Couldn't set up ${which}`, reason).pipe(Effect.ignore)
          return yield* new WorktreeFailed({ reason: `${which} couldn't be set up: ${reason}` })
        }
        return lead
      })

      /**
       * HE-118: the worktrees a set's lead's run is given as it starts: those of the set's tasks in To do with no run of
       * their own, set up. Each is recorded on the run (`RunRepo.grant`) under its task's lock, so its own agent can't
       * start, nor the task leave To do, between the look and the grant. None for a compaction, which does no work (nor
       * for an ACP agent, whose launch takes no other folders yet: it doesn't ask).
       */
      const grantSet = Effect.fnUntraced(function* (run: Run, lead: Task) {
        if (!isLead(lead) || run.kind !== "prompt") return []
        const given: Array<Task> = []
        for (const f of (yield* tasks.inSet(lead.id)).slice(1)) {
          const granted = yield* locks.withLock(["task", f.id])(
            db.tx(
              Effect.gen(function* () {
                const now = yield* tasks.get(f.id)
                if (now === null || !takesGrant(now) || (yield* runs.hasActive(now.id))) return null
                yield* runs.grant(run.id, now.id)
                return now
              }),
            ),
          )
          if (granted !== null) given.push(granted)
        }
        return given
      })

      /**
       * What the agent works in, made ready (the old launch's, for both agents): its worktree set up (4.1), then a
       * checkpoint of it before the agent changes it (4.3). The task as it is after.
       */
      const prepareWork = Effect.fnUntraced(function* (run: Run, start: Task, project: Project | null) {
        let task = start
        // 4.8: a run doesn't launch in the middle of a restack of the task's branch (or its task's, for a review thread).
        yield* restack.settled(task.kind === "review" && task.parent_id !== null ? task.parent_id : task.id)
        // ---- 4.1: the worktree it works in (the old launch's). A review thread works in its task's, once that's set up;
        // a task with a worktree of its own has it set up first, and a setup that fails fails the launch.
        if (project !== null && task.kind === "review" && task.parent_id !== null) {
          const parent = yield* tasks.get(task.parent_id)
          if (parent !== null && parent.worktree_state !== "ready" && parent.use_worktree) {
            return yield* new WorktreeFailed({ reason: "the task's worktree isn't set up" })
          }
        } else if (project !== null && task.kind === "task" && task.use_worktree && task.work_dir === null) {
          if (task.worktree_state !== "ready") yield* threads.notice(task.id, "info", "Setting up worktree…").pipe(Effect.ignore)
          task = yield* worktrees.setup(task.id).pipe(Effect.catchTag("AgentInWorktree", (e) => Effect.fail(new WorktreeFailed({ reason: e.message }))))
          // HE-118: a set's lead sets up the set's other worktrees with its own.
          yield* setUpFollowers(task)
        }
        // ---- end of 4.1's block.
        // 4.3: a checkpoint of the worktree before the agent changes it (once it is set up), taken after any rewind asked
        // for meanwhile, whose conversation rollback this run makes: the task is read again after it.
        yield* checkpoints.beforeRun(task, run)
        task = yield* load(task.id)
        return task
      })

      const claude = Effect.fn("LaunchFacts.claude")(function* (run: Run, text: string) {
        let task = yield* load(run.task_id)
        // 6.11: not while its project's folder moves, so what's read of the project says where it is now.
        if (task.project_id !== null) yield* relocation.settled(task.project_id)
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
        task = yield* prepareWork(run, task, project)
        // 6.7: the assistant and its routine threads work in its workspace, with its memory.
        const workspace = yield* assistantLaunch.workspace(task, { compact, message: text })
        const cwd = workspace?.cwd ?? (yield* cwdOf(task, project?.repo_path ?? null))
        const rewind = pendingRewind(task)
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
        // 6.7: the assistant reads its routines' reports since its last turn with the next message.
        const reports = compact ? null : yield* assistantLaunch.reports(task)
        // HE-25: what changed in its memory since its conversation was told, first (after a command).
        const prompt = compact
          ? text
          : withPreface((workspace?.update ?? "") + (reports?.preface ?? ""), yield* prompts.start(task.id, text, yield* background.takeLost(task.id)))
        // The task's own temp folder, its TMPDIR, which goes once it's done.
        const tmp = yield* taskTmp.ensure(task)
        // 6.10: the board's servers this run gets, read once: the desktop's and the Spaces' are told of in its system prompt.
        const served = yield* requests.served
        // HE-118: a set's lead works in its followers' worktrees that are still in To do.
        const granted = yield* grantSet(run, task)
        const systemPrompt = yield* prompts.system(task.id, {
          codex: false,
          granted: granted.map((t) => t.id),
          permission_mode: permissionMode,
          tmp,
          desktopHost: served.desktop ? identity.hostName : null,
          spacesHost: served.spaces === true ? identity.hostName : null,
          browserTools: served.browser === true,
          docsServer: (served.plugins ?? []).some((p) => p.name === DOCS_SERVER),
          memory: workspace?.memory,
        })
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
          // 6.9: the agent's own events, to this server, when its profile sends.
          telemetryEnv: yield* telemetry.claudeEnv(task.id, run.id, configDir),
          tmp,
          resumeAt: rewind?.resume_at ?? null,
          model,
          effort,
          permissionMode,
          outputStyle: launchStyle(task, project, profile),
          codeMode: host.experiments?.includes("code_mode") === true,
          sessionCodeMode: task.session_id !== null && (yield* runs.sessionCodeMode(task.id, task.session_id)),
          rules: yield* rules.forTask(task),
          tools: yield* agentTools.forRun(task),
          served,
          githubAccount: nonBlank(project?.github_account) ?? nonBlank(profile?.github_account),
          addDirs: [...group, ...(yield* stackDirs(task)), ...dirsOf(granted), ...(docs !== null && docs !== cwd ? [docs] : [])],
          attachmentDirs: [],
          prompt,
          promptId: yield* random.uuidV4(),
          systemPrompt,
          mcp: {
            url: `http://127.0.0.1:${yield* listening.port}/api/mcp/${encodeURIComponent(run.id)}/`,
            secret: yield* identity.runSecret(run.id),
            manifest: yield* requests.manifest(review),
          },
        })
        // Where its conversation is kept, if it starts one, and the effort it was given (review statistics).
        yield* runs.update(run.id, { config_dir: configDir ?? "", effort: recordedEffort(effort) })
        const runStart = { runtime: "claude", model: model ?? "", effort: effort ?? "", permission_mode: permissionMode, resume: task.session_id !== null }
        const prepared: Prepared = { spec, writesDocuments: docs !== null, rewind, started: startedWith(workspace, reports), runStart }
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
        const before = yield* load(run.task_id)
        // 6.11: as Claude's launch.
        if (before.project_id !== null) yield* relocation.settled(before.project_id)
        const project = before.project_id === null ? null : Option.getOrNull(yield* projects.get(before.project_id))
        const task = yield* prepareWork(run, before, project)
        const profile = Option.getOrNull(yield* profiles.get(task.profile_id))
        const host = yield* settings.get
        const compact = run.kind === "compact"
        const review = task.kind === "review"
        // 6.7: as Claude's launch.
        const workspace = yield* assistantLaunch.workspace(task, { compact, message: text })
        const cwd = workspace?.cwd ?? (yield* cwdOf(task, project?.repo_path ?? null))
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
        const reports = compact ? null : yield* assistantLaunch.reports(task)
        const prompt = compact
          ? ""
          : withPreface((workspace?.update ?? "") + (reports?.preface ?? ""), yield* prompts.start(task.id, text, yield* background.takeLost(task.id)))
        const tmp = yield* taskTmp.ensure(task)
        // 6.10: the board's servers this run gets, read once: the desktop's and the Spaces' are told of in its system prompt.
        const served = yield* requests.served
        // HE-118: as Claude's launch, as writable roots.
        const granted = yield* grantSet(run, task)
        const systemPrompt = yield* prompts.system(task.id, {
          codex: true,
          granted: granted.map((t) => t.id),
          permission_mode: permissionMode,
          tmp,
          desktopHost: served.desktop ? identity.hostName : null,
          spacesHost: served.spaces === true ? identity.hostName : null,
          browserTools: served.browser === true,
          docsServer: (served.plugins ?? []).some((p) => p.name === DOCS_SERVER),
          memory: workspace?.memory,
        })
        const configDir = yield* configDirOf(task, cfg)
        const gitDir = nonBlank(yield* git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
        const caches = yield* cacheDirs()
        const work = [expand(cwd), ...(gitDir === null ? [] : [gitDir])]
        const reviewFs = review && permissionMode !== "bypassPermissions" ? reviewFilesystem([...caches, ...(yield* ignoredDirs(cwd))], work) : null
        // A rewind's conversation rollback, for the session it was made in (`Runs.launch` clears it once the agent started).
        const pending = pendingRewind(task)
        const rewind = pending?.before_turn ?? null
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
          tools: yield* agentTools.forRun(task),
          served,
          githubAccount: nonBlank(project?.github_account) ?? nonBlank(profile?.github_account),
          systemPrompt,
          prompt,
          promptId: yield* random.uuidV4(),
          gitDir,
          cacheDirs: caches,
          workDirs: [...(yield* stackDirs(task)), ...dirsOf(granted)],
          documentsDir: docs !== null && docs !== cwd ? docs : null,
          reviewFilesystem: reviewFs,
          sessionBoardTools: task.session_id === null ? false : yield* runs.sessionBoardTools(task.id, task.session_id),
          revertBeforeTurn: rewind,
          // 6.9
          configOverrides: yield* telemetry.codexOverrides(task.id, run.id, configDir),
          mcp: {
            url: `http://127.0.0.1:${yield* listening.port}/api/mcp/${encodeURIComponent(run.id)}/`,
            secret: yield* identity.runSecret(run.id),
            manifest: yield* requests.manifest(review),
          },
        })
        yield* runs.update(run.id, { config_dir: configDir ?? "", effort: effort?.trim() ?? "", board_tools: launched.boardTools })
        const runStart = { runtime: "codex", model: model ?? "", effort: effort ?? "", permission_mode: permissionMode, resume: task.session_id !== null }
        const prepared: Prepared = { spec: launched.spec, writesDocuments: docs !== null, rewind: pending, started: startedWith(workspace, reports), runStart }
        return prepared
      })

      // ---- ACP agents (HE-69): Codex's half without Codex's sandbox, rules, dynamic tools or compaction ----

      const acp = Effect.fn("LaunchFacts.acp")(function* (run: Run, text: string, cfg: AgentConfigRow) {
        // ACP has no compaction (`Compaction` doesn't ask for one; a `/compact` sent is refused before any work is made ready).
        if (run.kind === "compact") return yield* new LaunchRefused({ reason: "an ACP agent's conversation can't be compacted" })
        const before = yield* load(run.task_id)
        // 6.11: as Claude's launch.
        if (before.project_id !== null) yield* relocation.settled(before.project_id)
        const project = before.project_id === null ? null : Option.getOrNull(yield* projects.get(before.project_id))
        const task = yield* prepareWork(run, before, project)
        const profile = Option.getOrNull(yield* profiles.get(task.profile_id))
        const host = yield* settings.get
        const review = task.kind === "review"
        // 6.7: as Claude's launch.
        const workspace = yield* assistantLaunch.workspace(task, { compact: false, message: text })
        const cwd = workspace?.cwd ?? (yield* cwdOf(task, project?.repo_path ?? null))
        const docs = task.kind === "task" && task.labels.length > 0 ? dataDir.documents(task.id) : null
        if (docs !== null) yield* mkdir(docs)
        const permissionMode: PermissionMode = task.permission_mode ?? project?.permission_mode ?? host.default_permission_mode ?? "default"
        // The thread's own pick and effort as given: the adapter selects the model if the agent offers it (and says
        // nothing of a Claude or Codex model left from another config that it doesn't).
        const model = nonBlank(task.model)
        const effort = nonBlank(task.effort)
        const reports = yield* assistantLaunch.reports(task)
        const prompt = withPreface(
          (workspace?.update ?? "") + (reports?.preface ?? ""),
          yield* prompts.start(task.id, text, yield* background.takeLost(task.id)),
        )
        const tmp = yield* taskTmp.ensure(task)
        const served = yield* requests.served
        // The text for an agent other than Claude Code: its tools are MCP tools.
        // HE-118: an ACP launch takes no other folders yet, so a set's lead is given none of its followers' worktrees.
        const systemPrompt = yield* prompts.system(task.id, {
          codex: true,
          acp: true,
          granted: [],
          permission_mode: permissionMode,
          tmp,
          desktopHost: served.desktop ? identity.hostName : null,
          spacesHost: served.spaces === true ? identity.hostName : null,
          browserTools: served.browser === true,
          docsServer: (served.plugins ?? []).some((p) => p.name === DOCS_SERVER),
          memory: workspace?.memory,
        })
        const configDir = yield* configDirOf(task, cfg)
        const launched = yield* acpLaunch({
          run: run.id,
          runDir: dir.path(run.id),
          kind: run.kind,
          task,
          cwd,
          exe: config.exe,
          home: config.home,
          configDir,
          command: cfg.command,
          tmp,
          model,
          effort,
          permissionMode,
          tools: yield* agentTools.forRun(task),
          served,
          githubAccount: nonBlank(project?.github_account) ?? nonBlank(profile?.github_account),
          systemPrompt,
          prompt,
          promptId: yield* random.uuidV4(),
          mcp: {
            url: `http://127.0.0.1:${yield* listening.port}/api/mcp/${encodeURIComponent(run.id)}/`,
            secret: yield* identity.runSecret(run.id),
            manifest: yield* requests.manifest(review),
          },
        })
        yield* runs.update(run.id, { config_dir: configDir ?? "", effort: effort ?? "" })
        const runStart = { runtime: "acp", model: model ?? "", effort: effort ?? "", permission_mode: permissionMode, resume: task.session_id !== null }
        // No conversation rollback: an ACP agent can't make one (`Checkpoints` refuses it).
        const prepared: Prepared = { spec: launched.spec, writesDocuments: docs !== null, rewind: null, started: startedWith(workspace, reports), runStart }
        return prepared
      })

      /** A run's launch, by its thread's config's agent: Claude's, Codex's or an ACP agent's. */
      const launch = Effect.fn("LaunchFacts.launch")(function* (run: Run, text: string) {
        const task = yield* load(run.task_id)
        const cfg = yield* configOf(task)
        if (cfg === null || cfg.agent === "claude") return yield* claude(run, text)
        // A thread created while its profile had no configs takes the default it has now, and keeps it with its
        // conversation.
        if (task.claude_config_id === null && task.session_id === null) yield* tasks.write(task.id, { claude_config_id: cfg.id }, run.created_at)
        return cfg.agent === "acp" ? yield* acp(run, text, cfg) : yield* codex(run, text, cfg)
      })

      const threadConfig = Effect.fnUntraced(function* (task: Task) {
        const key = threadConfigKey(task)
        if (key === null) return undefined
        const available = yield* tasks.configs(task.profile_id, null)
        const profile = Option.getOrNull(yield* profiles.get(task.profile_id))
        const picked = profile?.[key] ?? null
        return available.find((id) => id === picked) ?? available[0] ?? null
      })

      // 6.1: a task's terminal works where its agent does, with its config.
      const workEnv = Effect.fn("LaunchFacts.workEnv")(function* (task: Task) {
        const project = task.project_id === null ? null : Option.getOrNull(yield* projects.get(task.project_id))
        // 6.7: the assistant's terminal is in its workspace.
        const workspace = yield* assistantLaunch.workspace(task).pipe(Effect.orElseSucceed(() => null))
        const at = workspace?.cwd ?? (yield* cwdOf(task, project?.repo_path ?? null))
        // A worktree that's gone (being set up, or removed by hand) is no place to start: the repository is.
        const cwd = expand(at === task.worktree_path && project !== null && !(yield* exists(at)) ? project.repo_path : at)
        const cfg = yield* configOf(task)
        const configDir = yield* configDirOf(task, cfg)
        const env: Record<string, string> = Object.fromEntries(yield* apiEnv(cfg))
        const homeVar = cfg?.agent === "codex" ? "CODEX_HOME" : cfg?.agent === "acp" ? "GEMINI_HOME" : "CLAUDE_CONFIG_DIR"
        if (configDir !== null) env[homeVar] = expand(configDir)
        return { cwd, env }
      })

      return LaunchFacts.of({ launch, claude, config: configOf, documentsOf: (task) => dataDir.documents(task), threadConfig, workEnv })
    }),
  )
}
