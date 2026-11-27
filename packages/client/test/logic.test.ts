import { describe, expect, it } from "@effect/vitest"
import { type Host, HostId, LinkId, ProfileId, PROTOCOL, TaskId, Timestamp } from "@huntaway/contracts"
import {
  afterSend,
  AGENTS,
  agentInfo,
  agentSuffix,
  askerName,
  assistantHome,
  boardHosts,
  hostHas,
  isArchived,
  listsModels,
  outOfUsage,
  setMergeWaits,
  splitAttachments,
  usableHost,
  withAttachments,
} from "../src/index.ts"
import { config, profile, task } from "./fixtures.ts"

const host = (id: string, more: Partial<Host> = {}): Host => ({
  id: HostId.make(id),
  name: id,
  local: id === "hub",
  connected: true,
  mode: id === "hub" ? "local" : "ssh",
  agents: true,
  url: null,
  version: null,
  protocol: PROTOCOL,
  capabilities: [],
  commit: null,
  updates_from: null,
  last_seen: null,
  last_message_at: null,
  uplink: false,
  ...more,
})

/** A profile on a host, named "personal". */
const onHost = <T extends object>(x: T, host_id: string): T & { readonly host_id: string } => ({ ...x, host_id })
const at = (host_id: string, id: string, assistant_host: string | null = null) =>
  onHost(profile({ id: ProfileId.make(id), name: "personal", assistant_host: assistant_host === null ? null : LinkId.make(assistant_host) }), host_id)

describe("the old client's pure helpers", () => {
  it("files listed after a message are split back off it", () => {
    const a = { id: "0a1b", name: "shot.png", path: "/d/attachments/0a1b/shot.png" }
    const b = { id: "2c3d", name: "log.txt", path: "/d/attachments/2c3d/log.txt" }
    const sent = withAttachments("Look at these", [a, b])
    expect(sent).toBe("Look at these\n\nAttached files:\n- /d/attachments/0a1b/shot.png\n- /d/attachments/2c3d/log.txt")
    expect(splitAttachments(sent)).toEqual({ text: "Look at these", files: [a, b] })
    // Two queued messages joined into one, each with its list.
    expect(splitAttachments(`${withAttachments("One", [a])}\n\n${withAttachments("", [b])}`)).toEqual({ text: "One", files: [a, b] })
    // A list of paths that aren't attachments stays as written.
    expect(splitAttachments("Attached files:\n- /etc/passwd")).toEqual({ text: "Attached files:\n- /etc/passwd", files: [] })
    // What was typed while it was sending stays.
    expect(afterSend("hello and more", "hello")).toBe("and more")
    expect(afterSend("changed", "hello")).toBe("changed")
  })

  it("a profile's assistant is on its assistant host, or else the board's own host", () => {
    const hosts = [host("hub"), host("home"), host("laptop")]
    // No setting: the board's own host's profile, else the first connected host that has one.
    expect(assistantHome([at("laptop", "pl"), at("hub", "ph")], hosts, "personal")).toEqual({ hostId: "hub", profileId: "ph" })
    expect(assistantHome([at("laptop", "pl")], hosts, "personal")).toEqual({ hostId: "laptop", profileId: "pl" })
    expect(assistantHome([at("laptop", "pl")], [host("hub"), host("laptop", { connected: false })], "personal")).toBeUndefined()
    // The board's own profile picks the host, and its profile of that name there.
    const placed = [at("hub", "ph", "home"), at("home", "pr"), at("laptop", "pl")]
    expect(assistantHome(placed, hosts, "personal")).toEqual({ hostId: "home", profileId: "pr" })
    // Rather than falling back to another host, it says why it can't be opened there.
    expect(assistantHome(placed, [host("hub"), host("home", { connected: false }), host("laptop")], "personal")).toEqual({
      hostId: "home",
      unavailable: "offline",
    })
    expect(assistantHome(placed, [host("hub"), host("laptop")], "personal")).toEqual({ hostId: "home", unavailable: "offline" })
    expect(assistantHome([placed[0] ?? at("hub", "ph")], hosts, "personal")).toEqual({ hostId: "home", unavailable: "no_profile" })
    // Another host's setting doesn't count, nor does one naming the board's own host.
    expect(assistantHome([at("hub", "ph"), at("laptop", "pl", "home")], hosts, "personal")).toEqual({ hostId: "hub", profileId: "ph" })
    expect(assistantHome([at("hub", "ph", "hub")], hosts, "personal")).toEqual({ hostId: "hub", profileId: "ph" })
  })

  it("a host has the named capabilities it reported; the board's own host has them all", () => {
    const now = host("other", { capabilities: ["some_feature"] })
    expect(hostHas(now, "some_feature")).toBe(true)
    expect(hostHas(now, "another_feature")).toBe(false)
    expect(hostHas(host("hub"), "some_feature")).toBe(true)
    expect(hostHas(undefined, "some_feature")).toBe(false)
  })

  it("a host on another protocol is not usable; the board's own host is always on the board", () => {
    expect(usableHost(host("other"))).toBe(true)
    expect(usableHost(host("other", { protocol: PROTOCOL + 1 }))).toBe(false)
    expect(usableHost(host("other", { agents: false }))).toBe(false)
    const hub = host("hub", { agents: false })
    expect(boardHosts([hub, host("other", { connected: false }), host("third")]).map((h) => h.id)).toEqual(["hub", "third"])
  })

  it("a task done two days ago is archived, and a usage limit holds until it resets", () => {
    const now = Date.parse("2026-11-05T00:00:00.000Z")
    expect(isArchived(task({ status: "done", done_at: Timestamp.make("2026-11-02T00:00:00.000Z") }), now)).toBe(true)
    expect(isArchived(task({ status: "done", done_at: Timestamp.make("2026-11-04T00:00:00.000Z") }), now)).toBe(false)
    expect(isArchived(task({ status: "todo", done_at: null }), now)).toBe(false)
    expect(outOfUsage(task({ limit_reset_at: Timestamp.make("2026-11-05T01:00:00.000Z") }), now)).toBe(true)
    expect(outOfUsage(task({ limit_reset_at: Timestamp.make("2026-11-04T23:00:00.000Z") }), now)).toBe(false)
  })
})

// HE-69: a third agent, any that speaks the Agent Client Protocol (Google's Antigravity by default).
describe("agents", () => {
  it("each agent has its own name, folder and variable, and only Claude Code takes Claude's aliases", () => {
    expect(AGENTS.map((a) => a.id)).toEqual(["claude", "codex", "acp"])
    expect(agentInfo("acp")).toMatchObject({ dir: "~/.gemini", env: "GEMINI_HOME", short: "ACP" })
    expect(agentInfo("acp").label).toContain("Antigravity")
    expect(agentInfo("codex").dir).toBe("~/.codex")
    expect(agentInfo("claude").env).toBe("CLAUDE_CONFIG_DIR")
    expect([listsModels("claude"), listsModels("codex"), listsModels("acp")]).toEqual([false, true, true])
  })

  it("a config's name is followed by its agent unless it's Claude Code's", () => {
    expect([agentSuffix(config()), agentSuffix(config({ agent: "codex" })), agentSuffix(config({ agent: "acp" })), agentSuffix(undefined)]).toEqual([
      "",
      " (Codex)",
      " (ACP)",
      "",
    ])
    expect([askerName("claude"), askerName("codex"), askerName("acp"), askerName(undefined)]).toEqual(["Claude", "Codex", "The agent", "Claude"])
  })
})

/** Task `id`, following set A. */
const setFollower = (id: string, more: Parameters<typeof task>[0]) => task({ id: TaskId.make(id), key: id, lead_id: TaskId.make("a"), ...more })
const setLead = (more: Parameters<typeof task>[0] = {}) => task({ id: TaskId.make("a"), key: "API-1", status: "ready_for_merge", merging: true, ...more })

describe("setMergeWaits (HE-119)", () => {
  const lead = setLead()
  const follower = setFollower
  const set = [
    lead,
    follower("b", { status: "in_review" }),
    follower("c", { status: "ready_for_merge", merging: true }),
    follower("d", { status: "ready_for_merge", merging: true, merge_approval: "pending" }),
    follower("e", { status: "done", resolution: "not_done" }),
    task({ id: TaskId.make("x"), status: "todo" }),
  ]
  it("the open tasks of its set not in Ready for merge, or waiting there for approval", () => {
    expect(setMergeWaits(lead, set).map((t) => t.id)).toEqual(["b", "d"])
    expect(setMergeWaits(follower("c", { status: "ready_for_merge", merging: true }), set).map((t) => t.id)).toEqual(["b", "d"])
  })
  it("none while it isn't queued to merge, or for a task in no set", () => {
    expect(setMergeWaits(setLead({ running: true }), set)).toEqual([])
    expect(setMergeWaits(setLead({ status: "in_review" }), set)).toEqual([])
    expect(setMergeWaits(task({ id: TaskId.make("y"), status: "ready_for_merge", merging: true }), set)).toEqual([])
  })
})
