import { describe, expect, it } from "@effect/vitest"
import type { HostAgentConfig } from "@huntaway/client"
import { type Agent, AgentConfigId, HostId, Timestamp } from "@huntaway/contracts"
import { effortOptions, inheritedModel, modelOptions, modelPlaceholder, type AgentModel } from "../../src/agents"

// What the pickers offer for each agent (HE-69): Claude's aliases for Claude Code, the listed models for Codex and an ACP
// agent, which skip Claude's when inheriting one.

const config = (agent: Agent): HostAgentConfig => ({
  host_id: HostId.make("host-1"),
  id: AgentConfigId.make(`config-${agent}`),
  name: agent,
  config_dir: "",
  agent,
  command: null,
  show_usage: false,
  restart_window: false,
  api_url: null,
  settings_api_url: null,
  has_api_key: false,
  has_management_key: false,
  created_at: Timestamp.make("2026-11-21T09:00:00.000Z"),
})

const GEMINI: ReadonlyArray<AgentModel> = [
  { id: "gemini-pro", name: "Gemini Pro", is_default: false, efforts: [], default_effort: null },
  { id: "gemini-flash", name: "", is_default: true, efforts: ["low", "high"], default_effort: "low" },
]

describe("agents' models", () => {
  it("an ACP config offers the models it lists, not Claude's aliases", () => {
    expect(modelOptions(config("acp"), GEMINI)).toEqual([
      { id: "gemini-pro", label: "Gemini Pro" },
      { id: "gemini-flash", label: "gemini-flash" },
    ])
    expect(modelOptions(config("claude"), null).map((m) => m.id)).toContain("opus")
  })

  it("an ACP config whose models are loading or couldn't be listed offers none: its default model", () => {
    expect(modelOptions(config("acp"), null)).toEqual([])
    expect(modelOptions(config("acp"), [])).toEqual([])
  })

  it("an ACP thread skips Claude's models when inheriting one, and falls back to its default", () => {
    expect(inheritedModel(config("acp"), GEMINI, "opus", null, "claude-opus-5-5")).toBe("gemini-flash")
    expect(inheritedModel(config("acp"), GEMINI, "opus", "gemini-pro")).toBe("gemini-pro")
    expect(inheritedModel(config("acp"), null, "sonnet")).toBeUndefined()
    expect(inheritedModel(config("claude"), null, "sonnet")).toBe("sonnet")
  })

  it("an ACP model's efforts are its own, or Claude's when it lists none", () => {
    expect(effortOptions(config("acp"), GEMINI, "gemini-flash")).toEqual(["low", "high"])
    expect(effortOptions(config("acp"), GEMINI, "gemini-pro")).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  it("the specific model field's placeholder is the agent's", () => {
    expect(modelPlaceholder(config("claude"))).toBeUndefined()
    expect(modelPlaceholder(config("codex"))).toContain("gpt")
    expect(modelPlaceholder(config("acp"))).toBe("model id, as the agent lists it")
  })
})
