// Builders for a board's data, as a host sends it (tagged with the host, as the client keeps it), for the component
// checks: `board()` is one local host with a Default profile, an agent config and a Demo project, and its methods add
// more. The fake host (host.ts) answers from it, and `mount` (mount.tsx) shows components on it.
import {
  type AgentConfig,
  AgentConfigId,
  type Host,
  HostId,
  type HostSettings,
  type Pen,
  PenId,
  type Profile,
  ProfileId,
  type Project,
  ProjectId,
  PROTOCOL,
  type Task,
  TaskId,
  Timestamp,
} from "@huntaway/contracts"
import type { HostAgentConfig, HostPen, HostProfile, HostProject, HostTask } from "@huntaway/client"

/** `x` with `change`: a new object, as an event carries one. */
export const changed = <T extends object>(x: T, change: Partial<T>): T => ({ ...x, ...change })

/** When everything on a fake board was made and last changed. */
export const AT = Timestamp.make("2026-11-01T09:00:00.000Z")

export interface Board {
  readonly host: Host
  readonly profiles: Array<HostProfile>
  readonly claudeConfigs: Array<HostAgentConfig>
  /** Archived ones too (with `archived_at`). */
  readonly projects: Array<HostProject>
  readonly tasks: Array<HostTask>
  readonly pens: Array<HostPen>
  settings: HostSettings
  /** The Default profile and Demo project it starts with. */
  readonly me: HostProfile
  readonly demo: HostProject
  /** Adds a profile on the host. */
  profile(p?: Partial<Profile>): HostProfile
  /** Adds an agent config, which `profile` (Default by default) can use. */
  config(c?: Partial<AgentConfig>, profile?: HostProfile): HostAgentConfig
  /** Adds a project to `profile` (Default by default). */
  project(p?: Partial<Project>, profile?: HostProfile): HostProject
  /** Adds a task to `project` (Demo by default; null for a scratch task in no project), numbered after its others. */
  task(t?: Partial<Task>, project?: HostProject | null): HostTask
  /** Adds a pen to `profile` (Default by default). */
  pen(p?: Partial<Pen>, profile?: HostProfile): HostPen
  /** The task with `id`, as it is now (a change through the fake host puts a new object in its place). */
  get(id: string): HostTask
}

// Ids go on counting across a file's boards: the app keeps some things by id outside the board (drafts, caches), which
// a later check with the same ids would find.
const ids = { n: 0 }
const next = (kind: string): string => `${kind}-${++ids.n}`

/** A board with one host on it (`local`, this machine), Default's profile, a config and the Demo project. */
export function board(host: Partial<Host> = {}): Board {
  const h: Host = {
    id: HostId.make("local"),
    name: "this machine",
    local: true,
    connected: true,
    mode: "local",
    agents: true,
    url: null,
    version: "0.0.0-test",
    protocol: PROTOCOL,
    capabilities: [],
    commit: null,
    updates_from: null,
    last_seen: null,
    last_message_at: null,
    uplink: false,
    ...host,
  }
  const profiles: Array<HostProfile> = []
  const configs: Array<HostAgentConfig> = []
  const projects: Array<HostProject> = []
  const tasks: Array<HostTask> = []
  const pens: Array<HostPen> = []

  const profile = (p: Partial<Profile> = {}): HostProfile => {
    const made: HostProfile = {
      host_id: h.id,
      id: ProfileId.make(next("profile")),
      name: `Profile ${ids.n}`,
      claude_config_ids: [],
      default_model: null,
      agent_access: [],
      github_account: null,
      clone_dir: null,
      asana_user: null,
      asana_enabled: false,
      limit_wait: false,
      limit_switch: false,
      reviewers: [],
      summarizers: [],
      merge_approval: false,
      require_pr_approval: false,
      assistant_host: null,
      assistant_config_id: null,
      threads_config_id: null,
      telemetry: false,
      telemetry_titles: false,
      tint: null,
      created_at: AT,
      ...p,
    }
    profiles.push(made)
    return made
  }
  const me = profile({ name: "Default" })

  const config = (c: Partial<AgentConfig> = {}, owner: HostProfile = me): HostAgentConfig => {
    const made: HostAgentConfig = {
      host_id: h.id,
      id: AgentConfigId.make(next("config")),
      name: "Claude",
      config_dir: "",
      agent: "claude",
      show_usage: false,
      restart_window: false,
      api_url: null,
      settings_api_url: null,
      has_api_key: false,
      has_management_key: false,
      created_at: AT,
      ...c,
    }
    configs.push(made)
    const i = profiles.findIndex((p) => p.id === owner.id)
    const was = profiles[i]
    if (was) profiles[i] = changed(was, { claude_config_ids: [...was.claude_config_ids, made.id] })
    return made
  }

  const project = (p: Partial<Project> = {}, owner: HostProfile = me): HostProject => {
    const id = next("project")
    const made: HostProject = {
      host_id: owner.host_id,
      id: ProjectId.make(id),
      profile_id: owner.id,
      name: `Project ${ids.n}`,
      key: `P${ids.n}`,
      former_keys: [],
      repo_path: `/repos/${id}`,
      scratch_path: `/scratch/${id}`,
      worktrees_root: `/worktrees/${id}`,
      base_branch: "master",
      setup_script: "",
      teardown_script: "",
      copy_files: "",
      link_folders: "",
      status_script: "",
      status_scripts: {},
      use_worktrees: true,
      is_git: true,
      has_commits: true,
      setup_task_id: null,
      permission_mode: null,
      model: null,
      claude_config_ids: null,
      auto_review: false,
      done_when_merged: false,
      use_workflows: false,
      pull_requests: false,
      review_rounds: 0,
      reviewers: [],
      auto_summary: false,
      summarizers: [],
      merge_approval: null,
      require_pr_approval: null,
      start_prompt: null,
      review_prompt: null,
      merge_prompt: null,
      group_name: null,
      archived_at: null,
      github_account: null,
      watch_pull_requests: "off",
      pr_preview_url: null,
      created_at: AT,
      ...p,
    }
    projects.push(made)
    return made
  }

  const b: Board = {
    host: h,
    profiles,
    claudeConfigs: configs,
    projects,
    tasks,
    pens,
    settings: {
      default_model: null,
      default_effort: null,
      default_permission_mode: null,
      scratch_host: null,
      terminal_tools: [],
      public_url: null,
      release_prereleases: false,
      settings_sync: false,
    },
    // As it is now: a config added to it changes it.
    get me(): HostProfile {
      return profiles.find((p) => p.id === me.id) ?? me
    },
    demo: project({ name: "Demo", key: "DEMO" }),
    profile,
    config,
    project,
    task(t = {}, where = b.demo) {
      const profileId = where?.profile_id ?? b.me.id
      const others = tasks.filter((x) => x.project_id === (where?.id ?? null) && x.profile_id === profileId)
      const number = Math.max(0, ...others.map((x) => x.number)) + 1
      const made: HostTask = {
        host_id: where?.host_id ?? h.id,
        id: TaskId.make(next("task")),
        profile_id: profileId,
        project_id: where?.id ?? null,
        kind: "task",
        parent_id: null,
        task_type: where ? null : "scratch",
        labels: [],
        group_name: null,
        number,
        key: `${where?.key ?? "S"}-${number}`,
        pen_id: null,
        fanout_id: null,
        created_by: null,
        position: others.length + 1,
        work_dir: null,
        title: `Task ${ids.n}`,
        title_pinned: false,
        description: "",
        status: "todo",
        resolution: null,
        done_at: null,
        attention_reason: null,
        starred: false,
        remind_at: null,
        reminder: null,
        preview_url: null,
        pr_url: null,
        pr_checks: null,
        external_links: [],
        todos: [],
        tracked: [],
        context: null,
        document_at: null,
        cost_usd: 0,
        last_activity_at: AT,
        created_at: AT,
        updated_at: AT,
        use_worktree: where?.use_worktrees ?? false,
        worktree_path: null,
        worktree_state: "none",
        worktree_error: null,
        branch: null,
        base_branch: null,
        start_from: null,
        merges_into: null,
        carries: null,
        restack: null,
        github_stack: null,
        stack_title: null,
        stack_description: null,
        stack_pinned: false,
        stack_run: null,
        merging: false,
        remerge: false,
        merge_approval: null,
        depends_on: [],
        waiting: false,
        session_id: null,
        running: false,
        run_started_at: null,
        steerable: false,
        limit_reset_at: null,
        agent_wait: null,
        background_work: null,
        servers: [],
        queued_message: null,
        steering: [],
        model: null,
        effort: null,
        permission_mode: null,
        claude_config_id: null,
        auto_allow: [],
        review: null,
        summaries: [],
        rewind: null,
        ...t,
      }
      tasks.push(made)
      return made
    },
    pen(p = {}, owner = b.me) {
      const made: HostPen = {
        host_id: owner.host_id,
        id: PenId.make(next("pen")),
        profile_id: owner.id,
        name: `Pen ${ids.n}`,
        position: pens.length,
        active: true,
        thread_id: null,
        color: "blue",
        created_at: AT,
        updated_at: AT,
        task_count: 0,
        ...p,
      }
      pens.push(made)
      return made
    },
    get(id) {
      const found = tasks.find((x) => x.id === id)
      if (!found) throw new Error(`no task ${id} on the fake board`)
      return found
    },
  }
  config()
  return b
}
