import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vite-plus/test"
import { AutomationId } from "@huntaway/contracts"
import { AT, importOld, onBoard } from "../../../../tests/importLegacy/importOld.ts"
import { AutomationRepo } from "../../../automations/AutomationRepo.ts"
import type { LegacyBoard } from "@huntaway/testing"
import { convertAction, convertActiveHours, convertAutomation, convertTrigger } from "./automations.ts"
import type { OldAutomation } from "./automations.ts"

vi.mock("./index.ts", () => import("../../../../tests/importLegacy/families.ts"))

const PLAN_ACTION = `{"kind":"create_task","title":"Plan the week","task_type":"plan","start":true}`
const WEBHOOK = `{"kind":"webhook","filters":[{"path":"event","op":"equals","value":"push"}]}`

describe("automations: conversions", () => {
  it.each([
    [
      "a task type that is a label becomes the label, the rest defaulted",
      PLAN_ACTION,
      `{"claude_config_id":null,"description":"","effort":null,"kind":"create_task","labels":["plan"],"model":null,"start":true,"status":"todo","task_type":null,"title":"Plan the week"}`,
    ],
    [
      "a diagram with labels of its own keeps them",
      `{"kind":"create_task","title":"T","task_type":"diagram","labels":["artifact"]}`,
      `{"claude_config_id":null,"description":"","effort":null,"kind":"create_task","labels":["artifact","diagram"],"model":null,"start":false,"status":"todo","task_type":null,"title":"T"}`,
    ],
    [
      "scratch stays a task type",
      `{"kind":"create_task","title":"T","task_type":"scratch","status":"backlog"}`,
      `{"claude_config_id":null,"description":"","effort":null,"kind":"create_task","model":null,"start":false,"status":"backlog","task_type":"scratch","title":"T"}`,
    ],
    ["a message to the assistant gets its mode", `{"kind":"message_assistant","message":"Hi"}`, `{"kind":"message_assistant","message":"Hi","mode":"fresh"}`],
    ["one that doesn't read is kept as it was", `{"kind":"launch"}`, `{"kind":"launch"}`],
  ])("action: %s", (_, text, expected) => {
    expect(convertAction(text)).toBe(expected)
  })

  it.each([
    [
      "a webhook's coalescing defaulted",
      WEBHOOK,
      `{"coalesce_key":"","coalesce_seconds":0,"filters":[{"op":"equals","path":"event","value":"push"}],"kind":"webhook"}`,
    ],
    ["daily weekdays in lower case", `{"kind":"daily","time":"09:00","weekdays":["Mon","fri"]}`, `{"kind":"daily","time":"09:00","weekdays":["mon","fri"]}`],
    ["an interval as it is", `{"kind":"interval","every_minutes":30}`, `{"every_minutes":30,"kind":"interval"}`],
  ])("trigger: %s", (_, text, expected) => {
    expect(convertTrigger(text)).toBe(expected)
  })

  it.each([
    ["none", null, { value: null, unreadable: false }],
    ["weekdays left out are every day", `{"start":"09:00","end":"17:00"}`, { value: `{"end":"17:00","start":"09:00","weekdays":[]}`, unreadable: false }],
    [
      "weekdays in lower case",
      `{"start":"22:00","end":"02:00","weekdays":["SAT"]}`,
      { value: `{"end":"02:00","start":"22:00","weekdays":["sat"]}`, unreadable: false },
    ],
    ["unreadable ones are none, as the old reader had them", `{"start":9}`, { value: null, unreadable: true }],
  ])("active hours: %s", (_, text, expected) => {
    expect(convertActiveHours(text)).toEqual(expected)
  })

  const old: OldAutomation = {
    id: "a1",
    profile_id: "p1",
    project_id: "j1",
    name: "Hook",
    enabled: 1,
    trigger: WEBHOOK,
    action: PLAN_ACTION,
    token: "tok",
    secret: "sec",
    next_run_at: null,
    last_run_at: null,
    active_hours: null,
    precheck: null,
    budget_usd: 2,
    created_at: AT,
    updated_at: AT,
  }

  it("keeps the token and secret, so webhook URLs registered elsewhere still work", () => {
    expect(convertAutomation(old, null)).toMatchObject({ token: "tok", secret: "sec", budget_usd: 2 })
  })

  it("in a rehearsal, has a fresh token and no secret", () => {
    expect(convertAutomation(old, "fresh")).toMatchObject({ token: "fresh", secret: null })
  })
})

const fill = (old: LegacyBoard) =>
  Effect.gen(function* () {
    yield* old.insert("automations", {
      id: "a1",
      profile_id: "p1",
      project_id: "j1",
      name: "Plans",
      trigger: WEBHOOK,
      action: PLAN_ACTION,
      token: "old-token",
      secret: "old-secret",
      active_hours: `{"start":"09:00","end":"17:00"}`,
      created_at: AT,
      updated_at: AT,
    })
    yield* old.insert("automation_runs", {
      id: "ar1",
      automation_id: "a1",
      source: "webhook",
      status: "ok",
      task_id: "t1",
      delivery_id: "d1",
      payload: `{"body":{"ref":"main"},"headers":{},"query":{}}`,
      outcome: "quiet",
      cost_usd: 0.5,
      created_at: AT,
      finished_at: AT,
    })
  })

const readBack = (dataDir: string) =>
  Effect.gen(function* () {
    const repo = yield* AutomationRepo
    return { automation: yield* repo.get("a1"), runs: yield* repo.runs(AutomationId.make("a1"), 10) }
  }).pipe(Effect.provide(onBoard(dataDir, AutomationRepo.layer)))

describe("automations: import", () => {
  it.effect("an automation keeps its token and secret, its plan task type a label, and its runs", () =>
    Effect.gen(function* () {
      const { report, dataDir } = yield* importOld(fill)
      expect(report.failures).toEqual([])
      expect(report.json).toEqual([])
      expect(report.tables["automations"]).toEqual({ old: 1, written: 1, withheld: 0 })
      expect(report.tables["automation_runs"]).toEqual({ old: 1, written: 1, withheld: 0 })
      const { automation, runs } = yield* readBack(dataDir)
      expect(automation).toMatchObject({
        token: "old-token",
        secret: "old-secret",
        action: { kind: "create_task", task_type: null, labels: ["plan"], start: true },
        trigger: { kind: "webhook", coalesce_seconds: 0, coalesce_key: "" },
        active_hours: { start: "09:00", end: "17:00", weekdays: [] },
      })
      expect(runs.map((r) => [r.id, r.status, r.outcome, r.cost_usd, r.task_id, r.payload])).toEqual([
        ["ar1", "ok", "quiet", 0.5, "t1", `{"body":{"ref":"main"},"headers":{},"query":{}}`],
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("a rehearsal writes automations without their token and secret, counted as withheld", () =>
    Effect.gen(function* () {
      const { report, dataDir } = yield* importOld(fill, { rehearsal: true })
      expect(report.failures).toEqual([])
      expect(report.tables["automations"]).toEqual({ old: 1, written: 1, withheld: 1 })
      const { automation } = yield* readBack(dataDir)
      expect(automation?.secret).toBeNull()
      expect(automation?.token).toMatch(/^[0-9a-f]{64}$/)
      expect(automation?.action).toMatchObject({ labels: ["plan"] })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
