import { assert, describe, it } from "@effect/vitest"
import { McpServerId, ProjectId, SkillId } from "@huntaway/contracts"
import type { McpServer, TaskSkill } from "@huntaway/contracts"
import { effective, lastRunSkills, mergeSeen, withBoardSkills } from "./effective.ts"
import type { Inventory, SkillRow } from "./effective.ts"

// huntaway's agent/agent_tools/tests.test.ts: adds_the_boards_skills_a_user_can_call, a_thread_can_have_board_skills_the_project_doesnt,
// global_ones_follow_the_profile_unless_the_project_overrides (the rule; the switches' rows are AgentTools.test.ts'),
// records_what_runs_had, lists_the_skills_the_last_run_reported, and the google server kept from projects.

const project = ProjectId.make("a")
const skill = (name: string, owner: ProjectId | null, enabled = true, content = `---\nname: ${name}\ndescription: d\n---\n`): SkillRow => ({
  id: SkillId.make(`${owner ?? "g"}-${name}`),
  project_id: owner,
  name,
  description: `${name} (board)`,
  content,
  enabled,
  source_id: null,
  source_path: null,
  created_at: "",
  updated_at: "",
})
const server = (name: string, owner: ProjectId | null): McpServer => ({
  id: McpServerId.make(`${owner ?? "g"}-${name}`),
  project_id: owner,
  name,
  config: { type: "http", url: "https://x" },
  enabled: true,
  auto_allow: false,
  created_at: "",
  updated_at: "",
})
const inventory = (fields: Partial<Inventory>): Inventory => ({
  project: true,
  ownSkills: [],
  ownServers: [],
  globalSkills: [],
  globalServers: [],
  profileSwitches: {},
  projectSwitches: {},
  ...fields,
})

const withFront = (name: string, extra: string) => skill(name, project, true, `---\nname: ${name}\ndescription: d\n${extra}---\n`)
const found = (names: ReadonlyArray<string>): ReadonlyArray<TaskSkill> => names.map((n) => ({ name: n, description: "" }))

describe("what's on", () => {
  it("adds the board's skills a user can call", () => {
    const board = [
      withFront("deploy", ""),
      withFront("hidden", "user-invocable: false # Only the model\n"),
      withFront("no", "user-invocable: No\n"),
      withFront("user-only", "disable-model-invocation: true\n"),
    ]
    // Claude Code won't run `/hidden`, even if a run reported a skill by that name.
    const got = withBoardSkills(found(["zeta", "hidden", "deploy"]), board, false, ["zeta"])
    assert.deepStrictEqual(got[0], { name: "deploy", description: "deploy (board)" })
    assert.deepStrictEqual(
      got.map((s) => s.name),
      ["deploy", "user-only"],
    )
    // Codex has no such setting.
    assert.deepStrictEqual(
      withBoardSkills([], board, true, []).map((s) => s.name),
      ["deploy", "hidden", "no", "user-only"],
    )
  })

  it("follows the profile unless the project overrides, and a project's own one takes the name while it's on", () => {
    const on = skill("on", null)
    const off = skill("off", null)
    const own = skill("own", project)
    const inv = inventory({ ownSkills: [own], globalSkills: [on, off], profileSwitches: { [on.id]: true } })
    assert.deepStrictEqual(
      effective(inv).skills.map((s) => s.name),
      ["own", "on"],
    )
    assert.deepStrictEqual(
      effective({ ...inv, projectSwitches: { [on.id]: false, [off.id]: true } }).skills.map((s) => s.name),
      ["own", "off"],
    )
    const mine = skill("on", project)
    assert.deepStrictEqual(
      effective({ ...inv, ownSkills: [own, mine] }).skills.map((s) => s.project_id),
      [project, project],
    )
    // Switched off, the global one is used.
    assert.deepStrictEqual(
      effective({ ...inv, ownSkills: [own, { ...mine, enabled: false }] }).skills.map((s) => s.project_id),
      [project, null],
    )
  })

  it("gives a thread board skills the project doesn't have on", () => {
    const inv = inventory({
      ownSkills: [skill("own", project), skill("local-off", project, false), skill("dup", project)],
      globalSkills: [skill("global", null), skill("dead", null, false), skill("dup", null)],
    })
    const on = (extra: ReadonlyArray<string>) => effective(inv, extra).skills.map((s) => [s.name, s.project_id] as const)
    assert.deepStrictEqual(
      on([]).map((s) => s[0]),
      ["own", "dup"],
    )
    const got = on(["global", "dead", "missing", "dup", "own", "local-off"])
    assert.deepStrictEqual(
      got.map((s) => s[0]),
      ["own", "dup", "global", "local-off"],
    )
    // The project's own skill of a name wins over a global one.
    assert.strictEqual(got[1]?.[1], project)
    // A project's skill that's off for the project, and a global one of that name on for it: picking the name gives the project's.
    const ownAudit = skill("thread-audit", project, false)
    const globalAudit = skill("thread-audit", null)
    const both = inventory({ ownSkills: [ownAudit], globalSkills: [globalAudit], projectSwitches: { [globalAudit.id]: true } })
    assert.strictEqual(effective(both).skills[0]?.id, globalAudit.id)
    assert.strictEqual(effective(both, ["thread-audit"]).skills[0]?.id, ownAudit.id)
  })

  it("keeps the google server from a project's runs, whatever switches say, and gives it to the profile's", () => {
    const google = server("google", null)
    const other = server("other", null)
    const switches = { [google.id]: true, [other.id]: true }
    const inv = inventory({ globalServers: [google, other], profileSwitches: switches })
    assert.deepStrictEqual(
      effective(inv).servers.map((s) => s.name),
      ["other"],
    )
    assert.deepStrictEqual(
      effective({ ...inv, project: false }).servers.map((s) => s.name),
      ["google", "other"],
    )
  })

  it("records what runs had, keeping what earlier ones had for a while", () => {
    const now = "2026-11-12T10:00:00.000Z"
    const cutoff = "2026-10-29T10:00:00.000Z"
    const init = {
      skills: ["zeta", "alpha"],
      mcp_servers: [
        { name: "huntaway", status: "connected" },
        { name: "claude.ai Gmail", status: "needs-auth", source: "claudeai" },
      ],
    }
    let seen = mergeSeen(undefined, init, ["alpha"], now, cutoff)
    assert.deepStrictEqual(
      seen.skills.map((s) => s.name),
      ["alpha", "zeta"],
    )
    assert.deepStrictEqual(seen.mcp_servers, [{ name: "claude.ai Gmail", status: "needs-auth", source: "claudeai", at: now }])
    assert.deepStrictEqual(seen.board_skills, ["alpha"])
    // A later run that doesn't report everything keeps what earlier ones had...
    const later = "2026-11-12T11:00:00.000Z"
    seen = mergeSeen(seen, { skills: ["beta"], mcp_servers: [] }, [], later, cutoff)
    assert.deepStrictEqual(
      seen.skills.map((s) => s.name),
      ["alpha", "beta", "zeta"],
    )
    assert.deepStrictEqual(
      seen.mcp_servers.map((s) => s.name),
      ["claude.ai Gmail"],
    )
    // ...until it's old.
    seen = {
      skills: seen.skills.map((s) => (s.name === "alpha" ? { name: s.name, at: "2000-01-01T00:00:00.000Z" } : s)),
      mcp_servers: seen.mcp_servers,
      at: seen.at,
    }
    seen = mergeSeen(seen, { skills: ["beta"] }, [], later, cutoff)
    assert.deepStrictEqual(
      seen.skills.map((s) => s.name),
      ["beta", "zeta"],
    )
    // The last run's are the ones a user can call.
    assert.deepStrictEqual(lastRunSkills(seen), ["beta"])
    assert.deepStrictEqual(lastRunSkills(undefined), [])
  })
})
