import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Profile, Project } from "@huntaway/contracts"

// HE-111: a host from before projects and profiles had output styles sends neither key; its board still decodes
// (docs/plan/05-protocol.md, Schemas change by adding).

const AT = "2026-11-26T00:00:00.000Z"

const profile = {
  id: "p",
  name: "work",
  claude_config_ids: [],
  default_model: null,
  agent_access: [],
  github_account: null,
  clone_dir: null,
  asana_user: null,
  asana_enabled: true,
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
  telemetry_titles: true,
  tint: null,
  created_at: AT,
}

const project = {
  id: "pr",
  profile_id: "p",
  name: "Web",
  key: "WEB",
  former_keys: [],
  repo_path: "/r",
  scratch_path: "/r/s",
  worktrees_root: "/r/w",
  base_branch: null,
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
  pull_requests: true,
  review_rounds: 3,
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
  watch_pull_requests: "off" as const,
  pr_preview_url: null,
  created_at: AT,
}

describe("output styles from an older host", () => {
  it.effect("decodes a profile and a project without them, and with them", () =>
    Effect.gen(function* () {
      expect((yield* Schema.decodeEffect(Profile)(profile)).default_output_style).toBeUndefined()
      expect((yield* Schema.decodeEffect(Project)(project)).output_style).toBeUndefined()
      expect((yield* Schema.decodeEffect(Profile)({ ...profile, default_output_style: "Concise" })).default_output_style).toBe("Concise")
      expect((yield* Schema.decodeEffect(Project)({ ...project, output_style: null })).output_style).toBeNull()
    }),
  )
})
