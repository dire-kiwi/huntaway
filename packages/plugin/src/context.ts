// What the board tells a plugin about who is asking (docs/plan/15-plugins.md): the run an agent's tool call came from,
// or the session a page or call came from. Plain values, as the board's wire has them (snake_case, ids as strings).

/** A profile: the Claude login whose board a task is on. A plugin keeps its data per profile. */
export interface PluginProfile {
  readonly id: string
  readonly name: string
}

/** A project. */
export interface PluginProject {
  readonly id: string
  readonly key: string
  readonly name: string
  readonly profile_id: string
  readonly repo_path: string
}

/** A task (a thread an agent works). */
export interface PluginTask {
  readonly id: string
  /** `HE-34`. */
  readonly key: string
  readonly title: string
  /** `task`, `review`, `assistant`… */
  readonly kind: string
  readonly status: string
  readonly profile_id: string
  readonly project_id: string | null
}

/** The run an agent's call comes from: its task, the task's project and profile. */
export interface RunContext {
  readonly run_id: string
  readonly task: PluginTask
  readonly project: PluginProject | null
  readonly profile: PluginProfile
  /** A reviewer's run: it reads and reports. */
  readonly review: boolean
}

/** A tool call: the run it came from, and the call's own id (a call runs at most once per id). */
export interface CallContext extends RunContext {
  readonly call_id: string
}

/**
 * Who a page or a call is for: the board's own token (`board`, the person at the board) or a paired device, and what
 * it may do (`read`, `operate`, `settings`…). Huntaway has one user per board, so this is the session, not a person.
 */
export interface PluginSession {
  readonly kind: "board" | "device" | "link"
  readonly device_id: string | null
  readonly scopes: ReadonlyArray<string>
}
