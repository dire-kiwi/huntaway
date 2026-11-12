import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { vi } from "vite-plus/test"
import type { LegacyBoard } from "@huntaway/testing"
import { AT, importOld, onBoard } from "../../../../tests/importLegacy/importOld.ts"
import { LinkRepo } from "../../../hosts/LinkRepo.ts"
import { TelemetryRepo } from "../../../platform/TelemetryRepo.ts"
import { PushRepo } from "../../../push/PushRepo.ts"
import { convertSsh, isWebSubscription } from "./hosts.ts"
import type { OldPushSubscription } from "./hosts.ts"

vi.mock("./index.ts", () => import("../../../../tests/importLegacy/families.ts"))

const sub = (kind: string): OldPushSubscription => ({
  id: "s",
  endpoint: "https://push.example.test/1",
  kind,
  p256dh: "k",
  auth: "a",
  name: "",
  device_id: null,
  events: "{}",
  created_at: AT,
  last_sent_at: null,
  last_error: null,
})

describe("hosts: conversions", () => {
  it.each([
    ["no target", null, { value: null, unreadable: false }],
    ["ports left out are 22 and 7878", `{"target":"me@box"}`, { value: `{"target":"me@box","ssh_port":22,"remote_port":7878}`, unreadable: false }],
    [
      "ports given are kept",
      `{"target":"me@box","ssh_port":2222,"remote_port":7900}`,
      { value: `{"target":"me@box","ssh_port":2222,"remote_port":7900}`, unreadable: false },
    ],
    ["one without its target was none to the old reader", `{"ssh_port":22}`, { value: null, unreadable: true }],
    ["text that is not JSON", "me@box", { value: null, unreadable: true }],
  ])("ssh: %s", (_, text, expected) => {
    expect(convertSsh(text)).toEqual(expected)
  })

  it.each([
    ["web", true],
    ["expo", false],
  ])("a %s subscription is imported: %s", (kind, expected) => {
    expect(isWebSubscription(sub(kind))).toBe(expected)
  })
})

const fill = (old: LegacyBoard) =>
  Effect.gen(function* () {
    yield* old.insert("links", { id: "host-b", name: "Box", mode: "ssh", url: null, token: "tok-b", created_at: AT, ssh: `{"target":"me@box"}`, uplink: 1 })
    yield* old.insert("links", { id: "host-c", name: "Laptop", mode: "outbound", url: "http://laptop:7878", token: "tok-c", last_seen: AT, created_at: AT })
    yield* old.insert("push_subscriptions", {
      id: "w1",
      endpoint: "https://push.example.test/w1",
      p256dh: "key",
      auth: "auth",
      name: "Firefox",
      // From before reports: the old reader has them off.
      events: `{"attention":true,"review":false}`,
      created_at: AT,
      kind: "web",
    })
    yield* old.insert("push_subscriptions", {
      id: "e1",
      endpoint: "ExponentPushToken[x]",
      p256dh: "",
      auth: "",
      events: "{}",
      created_at: AT,
      kind: "expo",
      device_id: "dev1",
    })
    yield* old.insert("device_tokens", { id: "dev1", name: "Phone", token_hash: "h", created_at: AT })
    yield* old.insert("push_answer_tokens", { token_hash: "h2", request_id: "r", host_id: "h", task_id: "t1", created_at: AT })
    // Sent rows are deleted; the sequence remembers them.
    for (const id of [5, 6, 9]) yield* old.insert("telemetry_outbox", { id, target: "events", row: `{"n":${id}}`, at: AT })
    yield* old.run(`DELETE FROM telemetry_outbox WHERE id = 9`)
  })

const readBack = (dataDir: string) =>
  Effect.gen(function* () {
    const links = yield* LinkRepo
    const push = yield* PushRepo
    const telemetry = yield* TelemetryRepo
    const before = yield* telemetry.rowsOf("events", 10)
    yield* telemetry.add("events", `{"n":"new"}`, AT)
    return { links: yield* links.list, subs: yield* push.list, before, after: yield* telemetry.rowsOf("events", 10) }
  }).pipe(Effect.provide(onBoard(dataDir, Layer.mergeAll(LinkRepo.layer, PushRepo.layer, TelemetryRepo.layer))))

describe("hosts: import", () => {
  it.effect("links, browsers' push subscriptions and the telemetry outbox read back as they were", () =>
    Effect.gen(function* () {
      const { report, dataDir } = yield* importOld(fill)
      expect(report.failures).toEqual([])
      expect(report.json).toEqual([])
      expect(report.tables["links"]).toEqual({ old: 2, written: 2, withheld: 0 })
      expect(report.tables["push_subscriptions"]).toEqual({ old: 1, written: 1, withheld: 0 })
      expect(report.tables["telemetry_outbox"]).toEqual({ old: 2, written: 2, withheld: 0 })
      expect(report.notes.map((n) => [n.table, n.error])).toEqual([
        ["push_subscriptions", "1 Expo push subscriptions not imported: they wait for the phone app"],
        ["device_tokens", "1 paired devices (device_tokens) not imported: they wait for the phone app"],
        ["push_answer_tokens", "1 push answer tokens not imported: they wait for the phone app"],
      ])
      const r = yield* readBack(dataDir)
      expect(r.links).toMatchObject([
        { id: "host-b", mode: "ssh", token: "tok-b", ssh: { target: "me@box", ssh_port: 22, remote_port: 7878 }, uplink: true },
        { id: "host-c", mode: "outbound", url: "http://laptop:7878", token: "tok-c", ssh: null, uplink: false, last_seen: AT },
      ])
      expect(r.subs).toMatchObject([
        { id: "w1", kind: "web", name: "Firefox", p256dh: "key", auth: "auth", events: { attention: true, review: false, reports: false } },
      ])
      expect(r.before.map((x) => x.id)).toEqual([5, 6])
      // The ids go on after the old sequence's, never reusing a sent one.
      expect(r.after.map((x) => x.id)).toEqual([5, 6, 10])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("a rehearsal writes no link, push subscription or telemetry row", () =>
    Effect.gen(function* () {
      const { report, dataDir } = yield* importOld(fill, { rehearsal: true })
      expect(report.failures).toEqual([])
      expect(report.tables["links"]).toEqual({ old: 2, written: 0, withheld: 2 })
      expect(report.tables["push_subscriptions"]).toEqual({ old: 1, written: 0, withheld: 1 })
      expect(report.tables["telemetry_outbox"]).toEqual({ old: 2, written: 0, withheld: 2 })
      const r = yield* readBack(dataDir)
      expect(r.links).toEqual([])
      expect(r.subs).toEqual([])
      expect(r.before).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
