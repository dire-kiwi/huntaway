import { describe, expect, it } from "@effect/vitest"
import { AgentConfigId, type BoardMessage, HostId, PenId, ProfileId, ProjectId, TaskId, Timestamp } from "@huntaway/contracts"
import { applyBoardEvent, emptyHostBoard, type HostBoard } from "../src/index.ts"
import { config, pen, profile, project, settings, snapshot, task, usage } from "./fixtures.ts"

const H = HostId.make("host-a")
const T1 = TaskId.make("task-1")
const T2 = TaskId.make("task-2")
const LATER = Timestamp.make("2026-11-02T09:00:00.000Z")

const fold = (messages: ReadonlyArray<BoardMessage>, from: HostBoard = emptyHostBoard(H)): HostBoard => messages.reduce(applyBoardEvent, from)

const loaded = (): HostBoard =>
  fold([{ type: "hello", host_id: H, boot: "boot-1", seq: 1 }, snapshot({ tasks: [task(), task({ id: T2, number: 2, key: "DEMO-2" })] })])

describe("applyBoardEvent", () => {
  it("takes the host and boot from hello, and everything from the snapshot, tagged with the host", () => {
    const board = loaded()
    expect(board.host_id).toBe(H)
    expect(board.boot).toBe("boot-1")
    expect(board.seq).toBe(1)
    expect([...board.tasks.keys()]).toEqual([T1, T2])
    expect(board.tasks.get(T1)?.host_id).toBe(H)
    expect(board.profiles.map((p) => [p.name, p.host_id])).toEqual([["Default", H]])
    expect(board.configs.map((c) => c.host_id)).toEqual([H])
    expect(board.projects.map((p) => p.key)).toEqual(["DEMO"])
  })

  it("applies each kind of event", () => {
    const board = loaded()
    const archivedAt = Timestamp.make("2026-11-03T00:00:00.000Z")
    const P2 = ProjectId.make("project-2")
    const steps: ReadonlyArray<[BoardMessage, (b: HostBoard) => void]> = [
      [{ type: "task", seq: 2, task: task({ title: "Renamed", updated_at: LATER }) }, (b) => expect(b.tasks.get(T1)?.title).toBe("Renamed")],
      [{ type: "task", seq: 3, task: task({ id: TaskId.make("task-3"), title: "New" }) }, (b) => expect(b.tasks.get(TaskId.make("task-3"))?.title).toBe("New")],
      [{ type: "task_deleted", seq: 4, id: T2, project_id: ProjectId.make("project-1") }, (b) => expect(b.tasks.has(T2)).toBe(false)],
      [
        { type: "project", seq: 5, project: project({ id: P2, name: "Other", key: "OTH" }) },
        (b) => expect(b.projects.map((p) => p.key)).toEqual(["DEMO", "OTH"]),
      ],
      [
        { type: "project", seq: 6, project: project({ id: P2, name: "Other", key: "OTH", archived_at: archivedAt }) },
        (b) => {
          expect(b.projects.map((p) => p.key)).toEqual(["DEMO"])
          expect(b.archived.map((p) => p.key)).toEqual(["OTH"])
        },
      ],
      [
        { type: "project", seq: 7, project: project({ id: P2, name: "Other", key: "OTH" }) },
        (b) => {
          expect(b.projects.map((p) => p.key)).toEqual(["DEMO", "OTH"])
          expect(b.archived).toEqual([])
        },
      ],
      [
        { type: "project_deleted", seq: 8, id: ProjectId.make("project-1") },
        (b) => {
          expect(b.projects.map((p) => p.key)).toEqual(["OTH"])
          // Its tasks go with it.
          expect([...b.tasks.keys()]).toEqual([])
        },
      ],
      [
        {
          type: "profiles_changed",
          seq: 9,
          profiles: [profile({ name: "Renamed" })],
          configs: [config(), config({ id: AgentConfigId.make("config-2"), name: "Two" })],
        },
        (b) => {
          expect(b.profiles.map((p) => p.name)).toEqual(["Renamed"])
          expect(b.configs.map((c) => c.name)).toEqual(["Claude", "Two"])
        },
      ],
      [{ type: "settings_changed", seq: 10, settings: settings({ default_model: "opus" }) }, (b) => expect(b.settings.default_model).toBe("opus")],
      [
        { type: "pens", seq: 11, profile_id: ProfileId.make("profile-1"), pens: [pen()] },
        (b) => expect(b.pens.map((p) => [p.name, p.host_id])).toEqual([["Pen", H]]),
      ],
      [{ type: "usage", seq: 12, usage: usage({ plan: "max" }) }, (b) => expect(b.usage.get(config().id)?.plan).toBe("max")],
      // A task's checkpoints changed: what shows its turns reads them again.
      [{ type: "checkpoints", seq: 13, task_id: T1 }, (b) => expect(b.checkpoints.get(T1)).toBe(13)],
    ]
    let b = board
    for (const [event, check] of steps) {
      b = applyBoardEvent(b, event)
      check(b)
      expect(b.seq).toBe(event.seq)
    }
  })

  it("replaces only the pens of the profile an event is about", () => {
    const other = ProfileId.make("profile-2")
    const b = fold(
      [
        { type: "pens", seq: 2, profile_id: ProfileId.make("profile-1"), pens: [pen()] },
        { type: "pens", seq: 3, profile_id: other, pens: [pen({ id: PenId.make("pen-2"), profile_id: other, name: "Theirs" })] },
        { type: "pens", seq: 4, profile_id: ProfileId.make("profile-1"), pens: [] },
      ],
      loaded(),
    )
    expect(b.pens.map((p) => p.name)).toEqual(["Theirs"])
  })

  it("applies events in the order of their numbers: one at or below the board's is ignored", () => {
    const newer = applyBoardEvent(loaded(), { type: "task", seq: 5, task: task({ title: "Newer", updated_at: LATER }) })
    // A late event (an older change that arrives after a newer one), and a repeat, change nothing.
    expect(applyBoardEvent(newer, { type: "task", seq: 4, task: task({ title: "Older" }) })).toBe(newer)
    expect(applyBoardEvent(newer, { type: "task", seq: 5, task: task({ title: "Again" }) })).toBe(newer)
    expect(newer.tasks.get(T1)?.title).toBe("Newer")
  })

  it("a task deleted stays deleted when a late event about it comes after", () => {
    const deleted = applyBoardEvent(loaded(), { type: "task_deleted", seq: 6, id: T1, project_id: ProjectId.make("project-1") })
    const late = applyBoardEvent(deleted, { type: "task", seq: 5, task: task({ title: "From before the delete" }) })
    expect(late.tasks.has(T1)).toBe(false)
  })

  it("keeps every object that did not change identical", () => {
    const board = loaded()
    const next = applyBoardEvent(board, { type: "task", seq: 2, task: task({ id: T2, number: 2, key: "DEMO-2", title: "Changed" }) })
    expect(next.tasks.get(T1)).toBe(board.tasks.get(T1))
    expect(next.tasks.get(T2)).not.toBe(board.tasks.get(T2))
    expect(next.projects).toBe(board.projects)
    expect(next.profiles).toBe(board.profiles)
    // An event that says what the board has already changes its number and nothing else.
    const same = applyBoardEvent(next, { type: "task", seq: 3, task: task() })
    expect(same.tasks).toBe(next.tasks)
    expect(same.seq).toBe(3)
    // A snapshot (after a reconnect) keeps what it repeats.
    const again = applyBoardEvent(same, snapshot({ seq: 9, tasks: [task(), task({ id: T2, number: 2, key: "DEMO-2", title: "Changed again" })] }))
    expect(again.tasks.get(T1)).toBe(board.tasks.get(T1))
    expect(again.tasks.get(T2)?.title).toBe("Changed again")
    expect(again.projects).toBe(board.projects)
    expect(again.settings).toBe(board.settings)
    expect(again.seq).toBe(9)
  })

  it("a snapshot replaces the board, whatever its number (a new boot starts again)", () => {
    const b = applyBoardEvent(fold([{ type: "task", seq: 50, task: task({ title: "Old boot" }) }], loaded()), {
      type: "hello",
      host_id: H,
      boot: "boot-2",
      seq: 0,
    })
    expect(b.seq).toBe(50)
    const fresh = applyBoardEvent(b, snapshot({ seq: 2, tasks: [] }))
    expect(fresh.boot).toBe("boot-2")
    expect(fresh.seq).toBe(2)
    expect(fresh.tasks.size).toBe(0)
  })

  it("resync, a repeated hello and a kind this version does not know change nothing", () => {
    const board = loaded()
    expect(applyBoardEvent(board, { type: "resync", seq: 7 })).toBe(board)
    expect(applyBoardEvent(board, { type: "hello", host_id: H, boot: "boot-1", seq: 7 })).toBe(board)
    // A newer host's kind: not in the contract's union, so it can only come from outside the type system.
    const unknown: unknown = { type: "something_newer", seq: 7 }
    const after = isMessage(unknown) ? applyBoardEvent(board, unknown) : board
    expect(after.tasks).toBe(board.tasks)
    expect(after.projects).toBe(board.projects)
  })
})

/** Lets a message of a kind the contract does not have through, as a newer host's would come. */
function isMessage(u: unknown): u is BoardMessage {
  return typeof u === "object" && u !== null && "type" in u
}
