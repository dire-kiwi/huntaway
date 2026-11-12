import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { vi } from "vite-plus/test"
import { ProjectId } from "@huntaway/contracts"
import { AT, importOld, onBoard } from "../../../../tests/importLegacy/importOld.ts"
import { AgentToolsRepo } from "../../../agents/AgentToolsRepo.ts"
import { OldMcpServer, OldProjectAgentTools, OldSkill, OldSkillSource } from "./agentTools.ts"

vi.mock("./index.ts", () => import("../../../../tests/importLegacy/families.ts"))

describe("agent tools: old rows", () => {
  // Columns added late, or with defaults, read as the new table's defaults when an older database lacks them.
  it.each<readonly [string, () => Result.Result<unknown, Schema.SchemaError>, object]>([
    [
      "a skill source without subdir",
      () => Schema.decodeResult(OldSkillSource)({ id: "s1", url: "https://example.test/skills.git", name: "Skills", created_at: AT }),
      { git_ref: null, subdir: null, commit_sha: null, synced_at: null, error: null, notes: "[]" },
    ],
    [
      "a skill from before sources",
      () => Schema.decodeResult(OldSkill)({ id: "k1", project_id: null, name: "deploy", content: "x", created_at: AT, updated_at: AT }),
      { enabled: 1, source_id: null, source_path: null },
    ],
    [
      "a server without auto_allow",
      () => Schema.decodeResult(OldMcpServer)({ id: "m1", name: "docs", config: "{}", created_at: AT, updated_at: AT }),
      { project_id: null, enabled: 1, auto_allow: 0 },
    ],
    [
      "overrides without seen",
      () => Schema.decodeResult(OldProjectAgentTools)({ project_id: "j1" }),
      { disabled_skills: "[]", disabled_mcp_servers: "[]", seen: "{}" },
    ],
  ])("%s", (_, decode, expected) => {
    expect(Result.getOrThrow(decode())).toMatchObject(expected)
  })
})

describe("agent tools: import", () => {
  it.effect("skills, servers, switches, sources and a project's overrides read back as they were", () =>
    Effect.gen(function* () {
      const { report, dataDir } = yield* importOld((old) =>
        Effect.gen(function* () {
          yield* old.insert("skill_sources", {
            id: "src1",
            url: "https://example.test/skills.git",
            git_ref: "main",
            name: "Team skills",
            commit_sha: "abc123",
            synced_at: AT,
            notes: `["skipped one"]`,
            created_at: AT,
            subdir: "skills",
          })
          yield* old.insert("agent_skills", {
            id: "k1",
            project_id: null,
            name: "deploy",
            content: "---\ndescription: Deploys\n---\nSteps",
            enabled: 1,
            created_at: AT,
            updated_at: AT,
            source_id: "src1",
            source_path: "deploy/SKILL.md",
          })
          yield* old.insert("agent_skills", { id: "k2", project_id: "j1", name: "local", content: "Local", enabled: 0, created_at: AT, updated_at: AT })
          yield* old.insert("agent_mcp_servers", {
            id: "m1",
            project_id: "j1",
            name: "docs",
            config: `{"type":"http","url":"https://example.test/mcp"}`,
            enabled: 1,
            auto_allow: 1,
            created_at: AT,
            updated_at: AT,
          })
          yield* old.insert("agent_tool_switches", { scope: "profile", scope_id: "p1", item_id: "k1", enabled: 0 })
          yield* old.insert("project_agent_tools", {
            project_id: "j1",
            disabled_skills: `["deploy"]`,
            disabled_mcp_servers: "[]",
            seen: `{"default":{"skills":[{"name":"deploy","at":"${AT}"}],"mcp_servers":[{"name":"docs","status":"connected","at":"${AT}"}],"at":"${AT}"}}`,
          })
        }),
      )
      expect(report.failures).toEqual([])
      expect(report.json).toEqual([])
      for (const table of ["skill_sources", "agent_mcp_servers", "agent_tool_switches", "project_agent_tools"])
        expect(report.tables[table]).toEqual({ old: 1, written: 1, withheld: 0 })
      expect(report.tables["agent_skills"]).toEqual({ old: 2, written: 2, withheld: 0 })
      const read = yield* Effect.gen(function* () {
        const repo = yield* AgentToolsRepo
        const j1 = ProjectId.make("j1")
        return {
          sources: yield* repo.sources,
          global: yield* repo.skills(null),
          project: yield* repo.skills(j1),
          servers: yield* repo.servers(j1),
          switches: yield* repo.switches("profile", "p1"),
          overrides: yield* repo.overrides(j1),
        }
      }).pipe(Effect.provide(onBoard(dataDir, AgentToolsRepo.layer)))
      expect(read.sources).toMatchObject([{ id: "src1", ref: "main", subdir: "skills", commit: "abc123", notes: ["skipped one"] }])
      expect(read.global).toMatchObject([
        { id: "k1", name: "deploy", description: "Deploys", enabled: true, source_id: "src1", source_path: "deploy/SKILL.md" },
      ])
      expect(read.project).toMatchObject([{ id: "k2", name: "local", enabled: false, source_id: null }])
      expect(read.servers).toMatchObject([{ id: "m1", config: { type: "http", url: "https://example.test/mcp" }, enabled: true, auto_allow: true }])
      expect(read.switches).toEqual({ k1: false })
      expect(read.overrides).toEqual({
        disabled_skills: ["deploy"],
        disabled_mcp_servers: [],
        seen: { default: { skills: [{ name: "deploy", at: AT }], mcp_servers: [{ name: "docs", status: "connected", at: AT }], at: AT } },
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
