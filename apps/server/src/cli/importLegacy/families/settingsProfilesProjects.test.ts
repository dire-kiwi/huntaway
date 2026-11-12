import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect"
import { Aead, Kdf, KeyAgreement, SecureRandom, Signature } from "effect/crypto"
import { createECDH, createPublicKey, verify } from "node:crypto"
import { git, gitRepo, makeLegacyBoard } from "@huntaway/testing"
import type { LegacyBoard } from "@huntaway/testing"
import { AgentConfigId, ProfileId, ProjectId } from "@huntaway/contracts"
import { ApprovalRulesRepo } from "../../../agents/ApprovalRulesRepo.ts"
import { SettingsSyncRepo } from "../../../hosts/SettingsSyncRepo.ts"
import { Db } from "../../../platform/Db.ts"
import { Secrets } from "../../../platform/Secrets.ts"
import { AgentConfigRepo } from "../../../profiles/AgentConfigRepo.ts"
import { ProfileRepo } from "../../../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../../../projects/ProjectRepo.ts"
import { authorization, b64, VapidJson, vapidFrom } from "../../../push/crypto.ts"
import type { Crypto } from "../../../push/crypto.ts"
import { VAPID_SECRET } from "../../../push/WebPush.ts"
import { SettingsRepo } from "../../../settings/SettingsRepo.ts"
import { importLegacy } from "../run.ts"
import { approvalRulesFrom, jsonList, reviewerList, statusScripts, summarizersOf } from "./legacyJson.ts"
import { absolutePath, convertProfile, convertProject, convertSettings, settingFate } from "./settingsProfilesProjects.ts"
import type { OldProfile, OldProject } from "./settingsProfilesProjects.ts"

// The settings, profiles, agent configs, projects and settings-sync family (docs/plan/11-migration.md, Table by table):
// its conversions on their own, then old boards imported and read back through the new server's repositories.

const T = "2026-01-01T00:00:00.000Z"
const reviewer = (model: string | null) => ({ claude_config_id: null, model, effort: null })

describe("the old readers' JSON", () => {
  it.each([
    [null, [], true],
    ['["a","b"]', ["a", "b"], true],
    ["[1]", [], false],
    ["not json", [], false],
    ['{"a":1}', [], false],
  ])("jsonList(%s)", (text, value, readable) => {
    expect(jsonList(text)).toEqual({ value, readable })
  })

  it.each([
    [null, [], true],
    ["[]", [], true],
    ['[{"model":"opus"}]', [reviewer("opus")], true],
    [
      '[{"claude_config_id":"c1","model":null,"effort":"high","name":"N","skills":["s"],"prompt":"p"}]',
      [{ claude_config_id: "c1", model: null, effort: "high", name: "N", skills: ["s"], prompt: "p" }],
      true,
    ],
    ['[{"model":"m","skills":[],"name":null}]', [reviewer("m")], true],
    ['{"model":"opus"}', [], false],
    ['[{"model":"opus"},{"skills":null}]', [], false],
    ['[{"model":3}]', [], false],
  ])("reviewerList(%s)", (text, value, readable) => {
    expect(reviewerList(text)).toEqual({ value, readable })
  })

  it.each([
    ['[{"model":"a"}]', '{"model":"b"}', [reviewer("a")], true],
    [null, '{"model":"b"}', [reviewer("b")], true],
    ["[]", '{"model":"b"}', [reviewer("b")], true],
    [null, null, [], true],
    ["[]", null, [], true],
    [null, "[1]", [], false],
    ["nope", '{"model":"b"}', [reviewer("b")], false],
  ])("summarizersOf(%s, %s): a single summarizer becomes a list of one", (list, single, value, readable) => {
    expect(summarizersOf(list, single)).toEqual({ value, readable })
  })

  it.each([
    [null, {}, true],
    ['{"todo":"b","done":"a"}', { done: "a", todo: "b" }, true],
    ['{"todo":"b","nowhere":"x"}', { todo: "b" }, false],
    ['{"todo":1}', {}, false],
  ])("statusScripts(%s)", (text, value, readable) => {
    const read = statusScripts(text)
    expect(read).toEqual({ value, readable })
    expect(Object.keys(read.value)).toEqual(Object.keys(value))
  })

  it.each([
    ['{"rules":[{"tool":"Bash","decision":"ask"}],"expiry_minutes":5}', Option.some({ rules: [{ tool: "Bash", decision: "ask" }], expiry_minutes: 5 })],
    ['{"rules":[{"tool":"Bash","decision":"never","extra":1}]}', Option.some({ rules: [{ tool: "Bash", decision: "never" }], expiry_minutes: 30 })],
    ['{"rules":[{"tool":"Bash","decision":"maybe"}]}', Option.none()],
    ['{"rules":[],"expiry_minutes":-1}', Option.none()],
    ['{"rules":[],"expiry_minutes":1.5}', Option.none()],
    ["[]", Option.none()],
    ["nope", Option.none()],
  ])("approvalRulesFrom(%s)", (text, rules) => {
    expect(approvalRulesFrom(text)).toEqual(rules)
  })
})

describe("settings", () => {
  it.each([
    ["default_model", { _tag: "keep", credential: false }],
    ["terminal_tools", { _tag: "keep", credential: false }],
    ["settings_sync_since", { _tag: "keep", credential: false }],
    ["desktop_tools", { _tag: "keep", credential: false }],
    ["telemetry_logs", { _tag: "keep", credential: false }],
    ["telemetry_url", { _tag: "keep", credential: true }],
    ["telemetry_password", { _tag: "keep", credential: true }],
    ["telemetry_inflight", { _tag: "keep", credential: true }],
    ["vapid_private_key", { _tag: "vapid" }],
    ["approval_rules:p1", { _tag: "rules", profile: "p1" }],
    ["thread_items", { _tag: "drop", note: null }],
    ["thread_batch", { _tag: "drop", note: null }],
    ["workflows_reviews_moved", { _tag: "drop", note: null }],
  ])("settingFate(%s)", (key, fate) => {
    expect(settingFate(key)).toEqual(fate)
  })

  it.each(["telegram:p1", "telegram_token:p1", "telegram_state:p1", "telegram_outbox:p1", "from_a_branch"])("drops %s with a note", (key) => {
    const fate = settingFate(key)
    expect(fate._tag === "drop" && fate.note !== null).toBe(true)
  })

  it("converts a board's settings", () => {
    const scalar = Buffer.alloc(32, 3).toString("base64url")
    const out = convertSettings(
      [
        { key: "default_model", value: "opus" },
        { key: "terminal_tools", value: '[{"id":"t"}]' },
        { key: "vapid_private_key", value: scalar },
        { key: "approval_rules:p1", value: '{"rules":[{"tool":"Bash","decision":"ask"}],"expiry_minutes":0}' },
        { key: "approval_rules:p2", value: "not json" },
        { key: "approval_rules:gone", value: '{"rules":[]}' },
        { key: "telegram_token:p1", value: "secret" },
        { key: "thread_batch", value: T },
      ],
      new Set(["p1", "p2"]),
    )
    expect(out.settings.map((s) => [s.key, s.credential])).toEqual([
      ["default_model", false],
      ["terminal_tools", false],
      ["vapid_key", true],
    ])
    expect(out.settings[2]?.value).toMatchObject({ d: scalar })
    expect(out.rules).toEqual(
      new Map([
        ["p1", { rules: [{ tool: "Bash", decision: "ask" }], expiry_minutes: 0 }],
        ["p2", null],
      ]),
    )
    expect(out.json.map((j) => j.key)).toEqual(["terminal_tools"])
    expect(out.notes.map((n) => n.key)).toEqual(["approval_rules:p2", "approval_rules:gone", "telegram_token:p1"])
    expect(out.failures).toEqual([])
  })

  it("fails a VAPID key that is not one", () => {
    expect(convertSettings([{ key: "vapid_private_key", value: "!!" }], new Set()).failures.map((f) => f.key)).toEqual(["vapid_private_key"])
  })
})

const oldProfile = (o: Partial<OldProfile> = {}): OldProfile => ({
  id: "p1",
  name: "work",
  default_model: null,
  created_at: T,
  claude_config_ids: '["c1"]',
  agent_access: "[]",
  github_account: null,
  clone_dir: null,
  asana_token: "asana-secret",
  asana_user: "someone",
  asana_enabled: 1,
  limit_wait: 0,
  limit_switch: 0,
  reviewers: null,
  summarizer: null,
  summarizers: null,
  merge_approval: 0,
  require_pr_approval: 0,
  assistant_host: null,
  assistant_config_id: null,
  threads_config_id: null,
  telemetry: 0,
  telemetry_titles: null,
  ...o,
})

describe("convertProfile", () => {
  it("drops the legacy columns, makes a single summarizer a list and takes the approval rules", () => {
    const rules = { rules: [{ tool: "Bash", decision: "never" as const }], expiry_minutes: 30 }
    const { row, notes } = convertProfile(oldProfile({ summarizer: '{"model":"haiku"}', reviewers: '[{"model":"opus"}]', tint: "#112233" }), {
      rules,
      rehearsal: false,
    })
    expect(row).toMatchObject({
      claude_config_ids: ["c1"],
      summarizers: [reviewer("haiku")],
      reviewers: [reviewer("opus")],
      approval_rules: rules,
      asana_token: "asana-secret",
      telemetry_titles: 1,
      tint: "#112233",
    })
    expect(Object.keys(row)).not.toContain("summarizer")
    expect(Object.keys(row)).not.toContain("claude_config_dir")
    expect(notes).toEqual([])
  })

  it("writes no Asana sign-in in a rehearsal, and notes what the old server could not read", () => {
    const { row, notes } = convertProfile(oldProfile({ agent_access: "nope" }), { rules: null, rehearsal: true })
    expect(row).toMatchObject({ asana_token: null, asana_user: null, agent_access: [], approval_rules: null, summarizers: null, tint: null })
    expect(notes.map((n) => n.column)).toEqual(["agent_access"])
  })
})

const oldProject = (o: Partial<OldProject> = {}): OldProject => ({
  id: "j1",
  profile_id: "p1",
  name: "Proj",
  key: "PRJ",
  repo_path: "/repo",
  scratch_path: "projects/j1/scratch",
  worktrees_root: "./projects/j1/worktrees",
  base_branch: "main",
  setup_script: "",
  teardown_script: "",
  use_worktrees: 1,
  permission_mode: "default",
  model: null,
  next_number: 12,
  created_at: T,
  auto_review: 1,
  review_rounds: 2,
  claude_config_ids: null,
  start_prompt: null,
  review_prompt: null,
  merge_prompt: null,
  reviewers: "[]",
  group_name: null,
  status_script: "",
  status_scripts: "{}",
  former_keys: '["OLD"]',
  repo_root: "abc123",
  archived_at: null,
  github_account: null,
  done_when_merged: 1,
  watch_pull_requests: "off",
  setup_task_id: null,
  pr_preview_url: null,
  copy_files: "",
  link_folders: "",
  auto_summary: 1,
  summarizer: '{"model":"haiku"}',
  summarizers: null,
  pull_requests: 1,
  merge_approval: null,
  require_pr_approval: 1,
  use_workflows: 0,
  ...o,
})

describe("projects", () => {
  it.each([
    ["/abs/path", "/abs/path"],
    ["", ""],
    ["~", "/home/me"],
    ["~/src/x", "/home/me/src/x"],
    ["projects/j1/scratch", "/data/old/projects/j1/scratch"],
    ["./projects/../projects/j1", "/data/old/projects/j1"],
  ])("absolutePath(%s)", (path, absolute) => {
    expect(absolutePath(path, "/data/old", "/home/me")).toBe(absolute)
  })

  it("converts a project: folders absolute, 'default' mode as null, facts from the folder, keys kept", () => {
    const { row, notes } = convertProject(oldProject(), { dataDir: "/data/old", home: "/home/me", facts: { is_git: true, has_commits: false } })
    expect(row).toMatchObject({
      repo_path: "/repo",
      scratch_path: "/data/old/projects/j1/scratch",
      worktrees_root: "/data/old/projects/j1/worktrees",
      permission_mode: null,
      is_git: 1,
      has_commits: 0,
      key: "PRJ",
      former_keys: ["OLD"],
      repo_root: "abc123",
      summarizers: [reviewer("haiku")],
      reviewers: [],
      claude_config_ids: null,
      merge_approval: null,
      require_pr_approval: 1,
    })
    expect(Object.keys(row)).not.toContain("summarizer")
    expect(Object.keys(row)).not.toContain("subproject_pull_requests")
    expect(notes).toEqual([])
  })

  it("keeps a real permission mode, and reads an unknown one and an unknown PR watch as the defaults, with notes", () => {
    expect(
      convertProject(oldProject({ permission_mode: "plan" }), { dataDir: "/d", home: "/h", facts: { is_git: false, has_commits: false } }).row,
    ).toMatchObject({
      permission_mode: "plan",
    })
    const { row, notes } = convertProject(oldProject({ permission_mode: "yolo", watch_pull_requests: "some" }), {
      dataDir: "/d",
      home: "/h",
      facts: { is_git: false, has_commits: false },
    })
    expect(row).toMatchObject({ permission_mode: null, watch_pull_requests: "off" })
    expect(notes.map((n) => n.column)).toEqual(["permission_mode", "watch_pull_requests"])
  })
})

// ---------- imported and read back ----------

const options = (from: string, dataDir: string, rehearsal = false) => ({
  from,
  dataDir,
  check: true,
  force: false,
  rehearsal,
  database: Option.none<string>(),
})

/** The new board's repositories over its `board.db`. */
const boardLayer = (file: string) =>
  Layer.mergeAll(
    ProfileRepo.layer,
    ProjectRepo.layer,
    AgentConfigRepo.layer,
    ApprovalRulesRepo.layer,
    SettingsRepo.layer,
    Secrets.layer,
    SettingsSyncRepo.layer,
  ).pipe(Layer.provideMerge(Db.layerOver), Layer.provide(Layer.orDie(SqliteClient.layer({ filename: file }))))

const CryptoLive = Layer.mergeAll(KeyAgreement.layerWebCrypto, Kdf.layerWebCrypto, Aead.layerWebCrypto, Signature.layerWebCrypto).pipe(
  Layer.provideMerge(SecureRandom.layerWebCrypto),
)

/** An old board, its rows put in by `fill`, closed. */
const oldBoard = (root: string, fill: (old: LegacyBoard) => Effect.Effect<void>) => Effect.scoped(Effect.flatMap(makeLegacyBoard(root), fill))

const insertProfile = (old: LegacyBoard, id: string, extra: Readonly<Record<string, string | number | null>> = {}) =>
  old.insert("profiles", { id, name: `profile-${id}`, created_at: T, ...extra })

/** The old VAPID key as the old `webpush.ts` made it: the scalar, base64url, and its public point. */
const oldVapid = () => {
  const e = createECDH("prime256v1")
  e.generateKeys()
  const k = e.getPrivateKey()
  return { scalar: (k.length >= 32 ? k : Buffer.concat([Buffer.alloc(32 - k.length), k])).toString("base64url"), publicKey: e.getPublicKey() }
}

describe("import-legacy: settings, profiles, agent configs, settings sync", () => {
  it.effect("imports them as the new server reads them, and the push service signs with the old VAPID key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      const vapid = oldVapid()
      yield* oldBoard(`${tmp}/old`, (old) =>
        Effect.gen(function* () {
          yield* insertProfile(old, "p1", {
            claude_config_dir: "~/.claude-old",
            claude_config_ids: '["c1"]',
            summarizer: '{"model":"haiku","effort":"low"}',
            asana_token: "asana-secret",
            asana_user: "me",
            telemetry: 1,
          })
          yield* insertProfile(old, "p2", { summarizers: '[{"model":"a"},{"model":"b","name":"B"}]', summarizer: '{"model":"a"}' })
          yield* old.insert("claude_configs", { id: "c1", name: "Main", config_dir: "", created_at: T, agent: "claude", api_key: "k" })
          yield* old.insert("claude_configs", { id: "c2", name: "Codex", config_dir: "~/.codex-2", created_at: T, agent: "codex", show_usage: 1 })
          for (const [key, value] of [
            ["default_model", "opus"],
            ["default_effort", "high"],
            ["release_prereleases", "true"],
            ["vapid_private_key", vapid.scalar],
            ["approval_rules:p1", '{"rules":[{"tool":"mcp__google__send*","decision":"never"}],"expiry_minutes":10}'],
            ["telegram_token:p1", "bot-token"],
            ["thread_batch", T],
            ["workflows_reviews_moved", "1"],
            ["telemetry_url", "https://clickhouse.example"],
            ["telemetry_password", " pass "],
          ] as const)
            yield* old.insert("settings", { key, value })
          yield* old.insert("setting_versions", { name: "global/default_model", value: '"opus"', vv: '{"h1":2}', changed_at: T, changed_by: "h1", since: "" })
        }),
      )
      const result = yield* importLegacy(options(`${tmp}/old`, `${tmp}/new`))
      expect(result.report.failures).toEqual([])
      expect(result.report.json).toEqual([])
      expect(result.passes).toBe(true)
      expect(result.report.tables["settings"]).toEqual({ old: 10, written: 6, withheld: 0 })
      expect(result.report.notes.map((n) => n.key)).toEqual(["telegram_token:p1"])

      yield* Effect.gen(function* () {
        const profiles = yield* (yield* ProfileRepo).list
        expect(profiles.map((p) => [p.id, p.summarizers, p.claude_config_ids, p.telemetry])).toEqual([
          ["p1", [{ claude_config_id: null, model: "haiku", effort: "low" }], ["c1"], true],
          [
            "p2",
            [
              { claude_config_id: null, model: "a", effort: null },
              { claude_config_id: null, model: "b", effort: null, name: "B" },
            ],
            [],
            false,
          ],
        ])
        expect(Redacted.value((yield* (yield* ProfileRepo).asanaToken(ProfileId.make("p1"))) ?? Redacted.make(""))).toBe("asana-secret")
        const rules = yield* ApprovalRulesRepo
        expect(yield* rules.saved(ProfileId.make("p1"))).toEqual({ rules: [{ tool: "mcp__google__send*", decision: "never" }], expiry_minutes: 10 })
        expect(yield* rules.saved(ProfileId.make("p2"))).toBeNull()

        const configs = yield* (yield* AgentConfigRepo).list
        expect(configs.map((c) => [c.id, c.agent, c.config_dir, c.has_api_key, c.show_usage])).toEqual([
          ["c2", "codex", "~/.codex-2", false, true],
          ["c1", "claude", "", true, false],
        ])
        const keys = yield* (yield* AgentConfigRepo).keys(AgentConfigId.make("c1"))
        expect(keys.api_key === null ? null : Redacted.value(keys.api_key)).toBe("k")

        const settings = yield* (yield* SettingsRepo).all
        expect([...settings.keys()].toSorted()).toEqual([
          "default_effort",
          "default_model",
          "release_prereleases",
          "telemetry_password",
          "telemetry_url",
          VAPID_SECRET,
        ])
        expect(settings.get("telemetry_password")).toBe(" pass ")

        // The push service's own reading and signing of the key.
        const text = Redacted.value(Option.getOrThrow(yield* (yield* Secrets).get(VAPID_SECRET)))
        const key = yield* vapidFrom(yield* Schema.decodeEffect(VapidJson)(text))
        expect(Buffer.from(key.publicKey).equals(vapid.publicKey)).toBe(true)
        const c: Crypto = {
          agreement: yield* KeyAgreement.KeyAgreement,
          kdf: yield* Kdf.Kdf,
          aead: yield* Aead.Aead,
          signature: yield* Signature.Signature,
        }
        const header = yield* authorization(c, key, "https://push.example/send/1", "mailto:me@example.com", 1_000_000)
        const [t = "", k = ""] = header.slice("vapid t=".length).split(", k=")
        expect(k).toBe(b64(vapid.publicKey))
        const [h = "", claims = "", sig = ""] = t.split(".")
        const pub = createPublicKey({
          key: { kty: "EC", crv: "P-256", x: b64(vapid.publicKey.subarray(1, 33)), y: b64(vapid.publicKey.subarray(33, 65)) },
          format: "jwk",
        })
        expect(verify("sha256", Buffer.from(`${h}.${claims}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))).toBe(true)

        const versions = yield* (yield* SettingsSyncRepo).all
        expect(versions.get("global/default_model")).toMatchObject({ value: "opus", vv: { h1: 2 }, changed_by: "h1" })
      }).pipe(Effect.provide(Layer.merge(boardLayer(`${tmp}/new/board.db`), CryptoLive)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("in a rehearsal, converts and checks the credentials but does not write them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* oldBoard(`${tmp}/old`, (old) =>
        Effect.gen(function* () {
          yield* insertProfile(old, "p1", { asana_token: "asana-secret", asana_user: "me" })
          for (const [key, value] of [
            ["default_model", "opus"],
            ["vapid_private_key", oldVapid().scalar],
            ["telemetry_url", "https://clickhouse.example"],
            ["telemetry_user", "u"],
            ["telemetry_password", "p"],
            ["telemetry_logs", "info"],
          ] as const)
            yield* old.insert("settings", { key, value })
        }),
      )
      const result = yield* importLegacy(options(`${tmp}/old`, `${tmp}/new`, true))
      expect(result.report.failures).toEqual([])
      expect(result.report.tables["settings"]).toEqual({ old: 6, written: 2, withheld: 4 })
      expect(result.report.tables["profiles.asana_token"]?.withheld).toBe(1)
      yield* Effect.gen(function* () {
        expect([...(yield* (yield* SettingsRepo).all).keys()].toSorted()).toEqual(["default_model", "telemetry_logs"])
        expect(yield* (yield* ProfileRepo).asanaToken(ProfileId.make("p1"))).toBeNull()
        expect(Option.getOrThrow(yield* (yield* ProfileRepo).get(ProfileId.make("p1"))).asana_user).toBeNull()
      }).pipe(Effect.provide(boardLayer(`${tmp}/new/board.db`)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

describe("import-legacy: projects", () => {
  it.effect("fills is_git and has_commits from the folder, makes folders absolute and keeps keys", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      const withCommits = yield* gitRepo
      const empty = `${tmp}/empty-repo`
      yield* fs.makeDirectory(empty)
      yield* git(empty, ["init", "-q", "-b", "main"])
      const plain = `${tmp}/plain`
      yield* fs.makeDirectory(plain)
      const project = (id: string, key: string, repo: string, extra: Readonly<Record<string, string | number | null>> = {}) => ({
        id,
        profile_id: "p1",
        name: key,
        key,
        repo_path: repo,
        scratch_path: `projects/${id}/scratch`,
        worktrees_root: `${tmp}/old/projects/${id}/worktrees`,
        created_at: T,
        ...extra,
      })
      yield* oldBoard(`${tmp}/old`, (old) =>
        Effect.gen(function* () {
          yield* insertProfile(old, "p1")
          yield* old.insert(
            "projects",
            project("j1", "GP", withCommits, {
              former_keys: '["G"]',
              permission_mode: "default",
              next_number: 40,
              summarizer: '{"model":"haiku"}',
              subproject_pull_requests: 0,
              status_scripts: '{"todo":"echo hi"}',
            }),
          )
          yield* old.insert("projects", project("j2", "EMP", empty, { permission_mode: "acceptEdits" }))
          yield* old.insert("projects", project("j3", "PLN", plain))
          yield* old.insert("projects", project("j4", "GONE", `${tmp}/nowhere`))
        }),
      )
      const result = yield* importLegacy(options(`${tmp}/old`, `${tmp}/new`))
      expect(result.report.failures).toEqual([])
      expect(result.report.json).toEqual([])
      expect(result.report.tables["projects"]).toEqual({ old: 4, written: 4, withheld: 0 })
      expect(result.report.notes.map((n) => n.key)).toEqual(["GONE.repo_path"])
      const from = yield* fs.realPath(`${tmp}/old`)
      yield* Effect.gen(function* () {
        const repo = yield* ProjectRepo
        const get = (id: string) => Effect.map(repo.get(ProjectId.make(id)), Option.getOrThrow)
        const j1 = yield* get("j1")
        expect(j1).toMatchObject({
          key: "GP",
          former_keys: ["G"],
          repo_path: withCommits,
          scratch_path: `${from}/projects/j1/scratch`,
          worktrees_root: `${tmp}/old/projects/j1/worktrees`,
          is_git: true,
          has_commits: true,
          permission_mode: null,
          summarizers: [{ claude_config_id: null, model: "haiku", effort: null }],
          status_scripts: { todo: "echo hi" },
        })
        expect(yield* repo.nextNumber(ProjectId.make("j1"))).toBe(40)
        expect(yield* get("j2")).toMatchObject({ is_git: true, has_commits: false, permission_mode: "acceptEdits" })
        expect(yield* get("j3")).toMatchObject({ is_git: false, has_commits: false })
        expect(yield* get("j4")).toMatchObject({ is_git: false, has_commits: false })
      }).pipe(Effect.provide(boardLayer(`${tmp}/new/board.db`)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
