import { Config, Effect, FileSystem, Option, Path, Schema, Struct } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { AgentConfigId, ApprovalRuleSet, PermissionMode, Reviewer, StatusScripts, SyncLost, TerminalTool, WatchPullRequests } from "@huntaway/contracts"
import { SETTING as DESKTOP_SETTING } from "../../../desktop/Desktop.ts"
import { SINCE as SYNC_SINCE } from "../../../hosts/settingsSync/fields.ts"
import { SettingVersionRow } from "../../../hosts/SettingsSyncRepo.ts"
import { encodeColumns } from "../../../platform/columns.ts"
import { KEYS as TELEMETRY } from "../../../platform/TelemetryRepo.ts"
import { AgentConfigRow } from "../../../profiles/AgentConfigRepo.ts"
import { ProfileRow } from "../../../profiles/ProfileRepo.ts"
import { ProjectRow } from "../../../projects/ProjectRepo.ts"
import type { VapidJwk } from "../../../push/crypto.ts"
import { VAPID_SECRET } from "../../../push/WebPush.ts"
import { SettingRow } from "../../../settings/SettingsRepo.ts"
import { decodeOld, issueText, keyOf } from "../family.ts"
import type { Family, FamilyIo, NewRow, TableCheck } from "../family.ts"
import { approvalRulesFrom, jsonList, reviewerList, statusScripts, summarizersOf } from "./legacyJson.ts"
import type { NewRules } from "./legacyJson.ts"
import { vapidJwkFromScalar } from "./vapidKey.ts"

// The host's settings, profiles, agent configs, projects and settings sync's versions (docs/plan/11-migration.md, Table
// by table; inventory 09, sections 3a, 3d and 9). The old readers were lenient (a JSON column that doesn't read is its
// default, a single summarizer is a list of one), so each value is converted as the old server showed it and written
// in the form the new server reads; a value the old server could not read either is noted.

// ---------- old rows ----------

const Text = Schema.String
const NullText = Schema.NullOr(Schema.String)
const NullInt = Schema.NullOr(Schema.Finite)

const OldSetting = Schema.Struct({ key: Text, value: Text })
export type OldSetting = typeof OldSetting.Type

const OldProfile = Schema.Struct({
  id: Text,
  name: Text,
  default_model: NullText,
  created_at: Text,
  claude_config_ids: NullText,
  agent_access: NullText,
  github_account: NullText,
  clone_dir: NullText,
  asana_token: NullText,
  asana_user: NullText,
  asana_enabled: NullInt,
  limit_wait: NullInt,
  limit_switch: NullInt,
  reviewers: NullText,
  summarizer: NullText,
  summarizers: NullText,
  merge_approval: NullInt,
  require_pr_approval: NullInt,
  assistant_host: NullText,
  assistant_config_id: NullText,
  threads_config_id: NullText,
  telemetry: NullInt,
  telemetry_titles: NullInt,
  // Named migration `profile-tint`.
  tint: Schema.optionalKey(NullText),
})
export type OldProfile = typeof OldProfile.Type

const OldConfig = Schema.Struct({
  id: Text,
  name: Text,
  config_dir: Text,
  created_at: Text,
  agent: Text,
  show_usage: NullInt,
  restart_window: NullInt,
  api_url: NullText,
  api_key: NullText,
  management_key: NullText,
})
export type OldConfig = typeof OldConfig.Type

const OldProject = Schema.Struct({
  id: Text,
  profile_id: Text,
  name: Text,
  key: Text,
  repo_path: Text,
  scratch_path: Text,
  worktrees_root: Text,
  base_branch: NullText,
  setup_script: Text,
  teardown_script: Text,
  use_worktrees: NullInt,
  permission_mode: NullText,
  model: NullText,
  next_number: Schema.Int,
  created_at: Text,
  auto_review: NullInt,
  review_rounds: Schema.Int,
  claude_config_ids: NullText,
  start_prompt: NullText,
  review_prompt: NullText,
  merge_prompt: NullText,
  reviewers: NullText,
  group_name: NullText,
  status_script: Text,
  status_scripts: NullText,
  former_keys: NullText,
  repo_root: NullText,
  archived_at: NullText,
  github_account: NullText,
  done_when_merged: NullInt,
  watch_pull_requests: NullText,
  setup_task_id: NullText,
  pr_preview_url: NullText,
  copy_files: Text,
  link_folders: Text,
  auto_summary: NullInt,
  summarizer: NullText,
  summarizers: NullText,
  pull_requests: NullInt,
  merge_approval: NullInt,
  require_pr_approval: NullInt,
  use_workflows: NullInt,
})
export type OldProject = typeof OldProject.Type

const OldSettingVersion = Schema.Struct({
  name: Text,
  value: Text,
  vv: Text,
  changed_at: Text,
  changed_by: Text,
  lost: Text,
  seen: NullText,
  since: Text,
})

// ---------- settings ----------

/** Host settings the new server reads by the old name (`HostSettings`, `Desktop`, settings sync, telemetry). */
const KEPT: ReadonlySet<string> = new Set([
  "default_model",
  "default_effort",
  "default_permission_mode",
  "scratch_host",
  "public_url",
  "terminal_tools",
  "release_prereleases",
  "settings_sync",
  SYNC_SINCE,
  DESKTOP_SETTING,
  TELEMETRY.logs,
  TELEMETRY.agents,
  TELEMETRY.dropped,
  TELEMETRY.since,
])

/**
 * Kept too, but credentials for something outside the folder: a rehearsal converts them and does not write them
 * (11-migration.md, Rehearsal). The batch in flight goes with the destination: it points at outbox rows the rehearsal
 * does not write either.
 */
const CREDENTIALS: ReadonlySet<string> = new Set([TELEMETRY.url, TELEMETRY.database, TELEMETRY.user, TELEMETRY.password, TELEMETRY.inflight])

/** Migration flags and crash-recovery state of the old server: nothing in the new one reads them (04-database.md, Dropped). */
const DROPPED: ReadonlySet<string> = new Set(["thread_items", "thread_batch", "workflows_reviews_moved", "demo_todos_seeded"])

/** The old VAPID key's setting. */
export const OLD_VAPID = "vapid_private_key"
const RULES_PREFIX = "approval_rules:"

/** What becomes of one old setting. */
export type SettingFate =
  | { readonly _tag: "keep"; readonly credential: boolean }
  | { readonly _tag: "drop"; readonly note: string | null }
  | { readonly _tag: "rules"; readonly profile: string }
  | { readonly _tag: "vapid" }

export const settingFate = (key: string): SettingFate => {
  if (KEPT.has(key)) return { _tag: "keep", credential: false }
  if (CREDENTIALS.has(key)) return { _tag: "keep", credential: true }
  if (key === OLD_VAPID) return { _tag: "vapid" }
  if (key.startsWith(RULES_PREFIX)) return { _tag: "rules", profile: key.slice(RULES_PREFIX.length) }
  if (DROPPED.has(key)) return { _tag: "drop", note: null }
  if (/^telegram(_token|_state|_outbox)?:/.test(key))
    return { _tag: "drop", note: "Telegram is not part of the new server: its bot's settings are not carried" }
  return { _tag: "drop", note: "a setting the new server does not read: not carried" }
}

/** A new `settings` row; `credential` ones are not written in a rehearsal. */
export interface NewSetting {
  readonly key: string
  readonly value: string | VapidJwk
  readonly credential: boolean
}

export interface ConvertedSettings {
  readonly settings: ReadonlyArray<NewSetting>
  /** Profile id to its rules: null where the setting didn't read (the defaults, as the old server took it). */
  readonly rules: ReadonlyMap<string, NewRules | null>
  readonly notes: ReadonlyArray<{ readonly key: string; readonly note: string }>
  /** Stored JSON the new server does not read (it reads it as its default). */
  readonly json: ReadonlyArray<{ readonly key: string; readonly error: string }>
  readonly failures: ReadonlyArray<{ readonly key: string; readonly error: string }>
}

const decodeTerminalTools = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Array(TerminalTool)))

/** The old `settings` rows as the new `settings` rows and each profile's approval rules. */
export const convertSettings = (rows: ReadonlyArray<OldSetting>, profiles: ReadonlySet<string>): ConvertedSettings => {
  const settings: Array<NewSetting> = []
  const rules = new Map<string, NewRules | null>()
  const notes: Array<{ key: string; note: string }> = []
  const json: Array<{ key: string; error: string }> = []
  const failures: Array<{ key: string; error: string }> = []
  for (const { key, value } of rows) {
    const fate = settingFate(key)
    switch (fate._tag) {
      case "keep": {
        if (key === "terminal_tools") {
          const tools = decodeTerminalTools(value)
          if (tools._tag === "Failure") json.push({ key, error: issueText(tools.failure) })
        }
        settings.push({ key, value, credential: fate.credential })
        break
      }
      case "vapid": {
        const jwk = vapidJwkFromScalar(value)
        if (Option.isSome(jwk)) settings.push({ key: VAPID_SECRET, value: jwk.value, credential: true })
        else
          failures.push({
            key,
            error: "not a P-256 private key (the old server could not read it either): the new server makes a new one, and browsers subscribe again",
          })
        break
      }
      case "rules": {
        if (!profiles.has(fate.profile)) {
          notes.push({ key, note: "names no profile: not carried" })
          break
        }
        const read = approvalRulesFrom(value)
        if (Option.isNone(read)) notes.push({ key, note: "the old server could not read these rules and used the defaults: the profile keeps the defaults" })
        rules.set(fate.profile, Option.getOrNull(read))
        break
      }
      case "drop":
        if (fate.note !== null) notes.push({ key, note: fate.note })
    }
  }
  return { settings, rules, notes, json, failures }
}

// ---------- profiles and agent configs ----------

/** A note on one column of a converted row. */
export interface ColumnNote {
  readonly column: string
  readonly note: string
}

const unreadable = (what: string) => `the old server could not read it and showed ${what}: written as that`

const bit = (v: number | null, ifNull: 0 | 1 = 0): 0 | 1 => (v === null ? ifNull : v !== 0 ? 1 : 0)
const triState = (v: number | null): 0 | 1 | null => (v === null ? null : v !== 0 ? 1 : 0)

/** A converted row: JSON columns as values (lists, objects), written with `encodeColumns`. */
export type Converted = Readonly<Record<string, unknown>>

/**
 * An old profile as the new row: `claude_config_dir` and `summarizer` dropped, `summarizers` from the list or the single
 * one, `approval_rules` from its setting. A rehearsal writes no Asana sign-in (`asana_token`, `asana_user` null).
 */
export const convertProfile = (
  old: OldProfile,
  extra: { readonly rules: NewRules | null; readonly rehearsal: boolean },
): { readonly row: Converted; readonly notes: ReadonlyArray<ColumnNote> } => {
  const notes: Array<ColumnNote> = []
  const list = (column: string, text: string | null) => {
    const r = jsonList(text)
    if (!r.readable) notes.push({ column, note: unreadable("[]") })
    return r.value
  }
  const reviewers = reviewerList(old.reviewers)
  if (!reviewers.readable) notes.push({ column: "reviewers", note: unreadable("none") })
  const summarizers = summarizersOf(old.summarizers, old.summarizer)
  if (!summarizers.readable) notes.push({ column: "summarizers", note: unreadable(summarizers.value.length === 0 ? "none" : "the ones it could") })
  const row: Converted = {
    id: old.id,
    name: old.name,
    default_model: old.default_model,
    created_at: old.created_at,
    claude_config_ids: list("claude_config_ids", old.claude_config_ids),
    agent_access: list("agent_access", old.agent_access),
    github_account: old.github_account,
    clone_dir: old.clone_dir,
    asana_token: extra.rehearsal ? null : old.asana_token,
    asana_user: extra.rehearsal ? null : old.asana_user,
    asana_enabled: bit(old.asana_enabled, 1),
    limit_wait: bit(old.limit_wait),
    limit_switch: bit(old.limit_switch),
    reviewers: old.reviewers === null ? null : reviewers.value,
    summarizers: old.summarizers === null && old.summarizer === null ? null : summarizers.value,
    merge_approval: bit(old.merge_approval),
    require_pr_approval: bit(old.require_pr_approval),
    assistant_host: old.assistant_host,
    assistant_config_id: old.assistant_config_id,
    threads_config_id: old.threads_config_id,
    telemetry: bit(old.telemetry),
    telemetry_titles: bit(old.telemetry_titles, 1),
    tint: old.tint ?? null,
    approval_rules: extra.rules,
  }
  return { row, notes }
}

/** An old `claude_configs` row as an `agent_configs` row: as it is (`config_dir` '' is the agent's default folder). */
export const convertConfig = (old: OldConfig): Converted => ({
  id: old.id,
  name: old.name,
  config_dir: old.config_dir,
  created_at: old.created_at,
  agent: old.agent,
  show_usage: bit(old.show_usage),
  restart_window: bit(old.restart_window),
  api_url: old.api_url,
  api_key: old.api_key,
  management_key: old.management_key,
})

// ---------- projects ----------

/** `.` and `..` taken out of an absolute path, and repeated slashes. */
const normalize = (path: string): string => {
  const out: Array<string> = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return `/${out.join("/")}`
}

/**
 * A stored path as an absolute one: `~` is the home folder (the old server expanded it where it used the path, the new
 * one expands it when a path is set), and a relative path is relative to the old data folder. An empty one stays empty.
 */
export const absolutePath = (path: string, dataDir: string, home: string): string => {
  if (path === "" || path.startsWith("/")) return path
  if (path === "~") return home
  if (path.startsWith("~/")) return normalize(`${home}/${path.slice(2)}`)
  return normalize(`${dataDir}/${path}`)
}

const isPermissionMode = Schema.is(PermissionMode)
const isWatch = Schema.is(WatchPullRequests)

/** What the project's folder is: the new server's `Projects` asks the same (a `.git` there; `HEAD` a commit). */
export interface GitFacts {
  readonly is_git: boolean
  readonly has_commits: boolean
}

/**
 * An old project as the new row: `summarizer` and `subproject_pull_requests` dropped, `permission_mode` `default` read as
 * null (the host's default, as at v6), its folders absolute, `is_git` and `has_commits` from the folder. Its key and
 * former keys are kept; `repo_root` (what the repository was when last seen, not a path) as it is.
 */
export const convertProject = (
  old: OldProject,
  extra: { readonly dataDir: string; readonly home: string; readonly facts: GitFacts },
): { readonly row: Converted; readonly notes: ReadonlyArray<ColumnNote> } => {
  const notes: Array<ColumnNote> = []
  const path = (p: string) => absolutePath(p, extra.dataDir, extra.home)
  const formerKeys = jsonList(old.former_keys)
  if (!formerKeys.readable) notes.push({ column: "former_keys", note: unreadable("[]") })
  const configs = jsonList(old.claude_config_ids)
  if (!configs.readable) notes.push({ column: "claude_config_ids", note: unreadable("none, so the profile's") })
  const reviewers = reviewerList(old.reviewers)
  if (!reviewers.readable) notes.push({ column: "reviewers", note: unreadable("none, so the profile's") })
  const summarizers = summarizersOf(old.summarizers, old.summarizer)
  if (!summarizers.readable)
    notes.push({ column: "summarizers", note: unreadable(summarizers.value.length === 0 ? "none, so the profile's" : "the ones it could") })
  const scripts = statusScripts(old.status_scripts)
  if (!scripts.readable) notes.push({ column: "status_scripts", note: "scripts for something that is not a status, or not text, are not carried" })
  const mode = old.permission_mode
  const permissionMode = mode === null || mode === "default" ? null : isPermissionMode(mode) ? mode : null
  if (permissionMode === null && mode !== null && mode !== "default")
    notes.push({ column: "permission_mode", note: `"${mode}" is not a permission mode: the host's default` })
  const watch = old.watch_pull_requests ?? "off"
  if (!isWatch(watch)) notes.push({ column: "watch_pull_requests", note: `"${watch}" is not a choice: off` })
  const row: Converted = {
    id: old.id,
    profile_id: old.profile_id,
    name: old.name,
    key: old.key,
    repo_path: path(old.repo_path),
    scratch_path: path(old.scratch_path),
    worktrees_root: path(old.worktrees_root),
    base_branch: old.base_branch,
    setup_script: old.setup_script,
    teardown_script: old.teardown_script,
    use_worktrees: bit(old.use_worktrees, 1),
    permission_mode: permissionMode,
    model: old.model,
    next_number: old.next_number,
    created_at: old.created_at,
    auto_review: bit(old.auto_review, 1),
    review_rounds: old.review_rounds,
    claude_config_ids: old.claude_config_ids === null ? null : configs.value,
    start_prompt: old.start_prompt,
    review_prompt: old.review_prompt,
    merge_prompt: old.merge_prompt,
    reviewers: old.reviewers === null ? null : reviewers.value,
    group_name: old.group_name,
    status_script: old.status_script,
    status_scripts: scripts.value,
    former_keys: formerKeys.value,
    repo_root: old.repo_root,
    archived_at: old.archived_at,
    github_account: old.github_account,
    done_when_merged: bit(old.done_when_merged, 1),
    watch_pull_requests: isWatch(watch) ? watch : "off",
    setup_task_id: old.setup_task_id,
    pr_preview_url: old.pr_preview_url,
    copy_files: old.copy_files,
    link_folders: old.link_folders,
    auto_summary: bit(old.auto_summary, 1),
    summarizers: old.summarizers === null && old.summarizer === null ? null : summarizers.value,
    pull_requests: bit(old.pull_requests, 1),
    merge_approval: triState(old.merge_approval),
    require_pr_approval: triState(old.require_pr_approval),
    use_workflows: bit(old.use_workflows),
    is_git: extra.facts.is_git ? 1 : 0,
    has_commits: extra.facts.has_commits ? 1 : 0,
  }
  return { row, notes }
}

// ---------- the checks the rows are written with ----------

const Reviewers = Schema.Array(Reviewer)
const ConfigIds = Schema.Array(AgentConfigId)
const Names = Schema.Array(Schema.String)

const settingsCheck: TableCheck = { row: SettingRow, key: keyOf("key") }

const profilesCheck: TableCheck = {
  row: Schema.Struct({ ...ProfileRow.fields, asana_token: NullText, approval_rules: NullText }),
  json: { claude_config_ids: ConfigIds, agent_access: Names, reviewers: Reviewers, summarizers: Reviewers, approval_rules: ApprovalRuleSet },
  key: keyOf("id"),
}

const configsCheck: TableCheck = {
  row: Schema.Struct({ ...Struct.omit(AgentConfigRow.fields, ["has_api_key", "has_management_key"]), api_key: NullText, management_key: NullText }),
  key: keyOf("id"),
}

const projectsCheck: TableCheck = {
  row: Schema.Struct({ ...ProjectRow.fields, next_number: Schema.Int, repo_root: NullText }),
  json: { former_keys: Names, status_scripts: StatusScripts, claude_config_ids: ConfigIds, reviewers: Reviewers, summarizers: Reviewers },
  key: keyOf("id"),
}

const versionsCheck: TableCheck = {
  row: SettingVersionRow,
  json: { value: Schema.Unknown, vv: Schema.Record(Schema.String, Schema.Int), lost: Schema.Array(SyncLost), seen: Schema.Unknown },
  key: keyOf("name"),
}

// ---------- the family ----------

/** A row that is converted and checked but not written (a rehearsal's credential): a failure if it doesn't check. */
const checkOnly = (io: FamilyIo, table: string, check: TableCheck, row: NewRow) => {
  const decoded = Schema.decodeResult(check.row)(row)
  return decoded._tag === "Failure" ? io.report.failure(table, check.key(row), `new row: ${issueText(decoded.failure)}`) : Effect.void
}

const notesFor = (io: FamilyIo, table: string, key: string, notes: ReadonlyArray<ColumnNote>) =>
  Effect.forEach(notes, (n) => io.report.note(table, `${key}.${n.column}`, n.note), { concurrency: 1, discard: true })

/** The new server's question of a project's folder (`Projects.gitFacts`), read-only (`GIT_OPTIONAL_LOCKS=0`). */
const gitFacts = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  if (dir === "" || !(yield* fs.exists(path.join(dir, ".git")).pipe(Effect.orElseSucceed(() => false)))) return { is_git: false, has_commits: false }
  const code = yield* spawner
    .exitCode(ChildProcess.make("git", ["-C", dir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { env: { GIT_OPTIONAL_LOCKS: "0" }, extendEnv: true }))
    .pipe(
      Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.succeed(-1) }),
      Effect.orElseSucceed(() => -1),
    )
  return { is_git: true, has_commits: Number(code) === 0 }
})

const run = (io: FamilyIo) =>
  Effect.gen(function* () {
    const { ctx, old, report } = io
    const fs = yield* FileSystem.FileSystem
    const home = yield* Effect.orDie(Config.String("HOME").pipe(Config.withDefault("/")))

    // Settings first: the approval rules go onto the profiles.
    const settingRows = yield* old.rows("settings", "key")
    yield* report.old("settings", settingRows.length)
    const oldSettings = yield* decodeOld(report, "settings", OldSetting, keyOf("key"))(settingRows)
    const profileRows = yield* old.rows("profiles")
    yield* report.old("profiles", profileRows.length)
    const oldProfiles = yield* decodeOld(report, "profiles", OldProfile, keyOf("id"))(profileRows)

    const converted = convertSettings(oldSettings, new Set(oldProfiles.map((p) => p.id)))
    for (const n of converted.notes) yield* report.note("settings", n.key, n.note)
    for (const j of converted.json) yield* report.json("settings", `${j.key}.value`, j.error)
    for (const f of converted.failures) yield* report.failure("settings", f.key, f.error)
    const settings: Array<NewRow> = []
    let withheld = 0
    for (const s of converted.settings) {
      const row = yield* encodeColumns({ key: s.key, value: s.value })
      if (ctx.rehearsal && s.credential) {
        yield* checkOnly(io, "settings", settingsCheck, row)
        withheld++
      } else settings.push(row)
    }
    yield* io.write("settings", settingsCheck, settings)
    if (withheld > 0) yield* report.withheld("settings", withheld)

    // Profiles.
    const profiles: Array<NewRow> = []
    let asana = 0
    for (const p of oldProfiles) {
      const { row, notes } = convertProfile(p, { rules: converted.rules.get(p.id) ?? null, rehearsal: ctx.rehearsal })
      yield* notesFor(io, "profiles", p.id, notes)
      if (ctx.rehearsal && (p.asana_token !== null || p.asana_user !== null)) asana++
      profiles.push(yield* encodeColumns(row))
    }
    yield* io.write("profiles", profilesCheck, profiles)
    if (asana > 0) yield* report.withheld("profiles.asana_token", asana)

    // Agent configs.
    const configRows = yield* old.rows("claude_configs")
    yield* report.old("agent_configs", configRows.length)
    const oldConfigs = yield* decodeOld(report, "claude_configs", OldConfig, keyOf("id"))(configRows)
    const configs: Array<NewRow> = []
    for (const c of oldConfigs) configs.push(yield* encodeColumns(convertConfig(c)))
    yield* io.write("agent_configs", configsCheck, configs)

    // Projects, with what their folders are now.
    const projectRows = yield* old.rows("projects")
    yield* report.old("projects", projectRows.length)
    const oldProjects = yield* decodeOld(report, "projects", OldProject, keyOf("id"))(projectRows)
    const projects: Array<NewRow> = []
    for (const p of oldProjects) {
      const repo = absolutePath(p.repo_path, ctx.oldDataDir, home)
      if (repo === "" || !(yield* fs.exists(repo).pipe(Effect.orElseSucceed(() => false))))
        yield* report.note("projects", `${p.key}.repo_path`, `${repo} is not on disk: the project's folder is missing on the old board too`)
      const { row, notes } = convertProject(p, { dataDir: ctx.oldDataDir, home, facts: yield* gitFacts(repo) })
      yield* notesFor(io, "projects", p.key, notes)
      projects.push(yield* encodeColumns(row))
    }
    yield* io.write("projects", projectsCheck, projects)

    // Settings sync's versions, as they are.
    const versionRows = yield* old.rows("setting_versions", "name")
    yield* report.old("setting_versions", versionRows.length)
    const versions = yield* decodeOld(report, "setting_versions", OldSettingVersion, keyOf("name"))(versionRows)
    yield* io.write("setting_versions", versionsCheck, versions)
  })

export const settingsProfilesProjects: Family = {
  name: "settings-profiles-projects",
  reads: ["settings", "profiles", "claude_configs", "projects", "setting_versions"],
  writes: ["settings", "profiles", "agent_configs", "projects", "setting_versions"],
  run,
}
