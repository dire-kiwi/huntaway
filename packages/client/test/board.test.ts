import { describe, expect, it } from "@effect/vitest"
import { type BoardMessage, HostId, ProjectId, TaskId, Timestamp } from "@huntaway/contracts"
import {
  applyBoardEvent,
  emptyBoard,
  emptyHostBoard,
  type HostBoard,
  type HostPart,
  mergeBoards,
  type SessionView,
  withPatch,
  withPendingMarks,
} from "../src/index.ts"
import { info, project, snapshot, task } from "./fixtures.ts"

const A = HostId.make("host-a")
const B = HostId.make("host-b")
const T1 = TaskId.make("task-1")

const boardOf = (host: HostId, ...messages: ReadonlyArray<BoardMessage>): HostBoard =>
  [{ type: "hello", host_id: host, boot: "boot", seq: 1 } as const, ...messages].reduce<HostBoard>(applyBoardEvent, emptyHostBoard(host))

const live = (host: string): SessionView => ({ state: { _tag: "live" }, info: info(host) })

describe("mergeBoards", () => {
  it("merges the hosts' boards; a task id two hosts have is the first host's (the page's own)", () => {
    const parts: ReadonlyArray<HostPart> = [
      { host_id: A, session: live("host-a"), board: boardOf(A, snapshot({ tasks: [task({ title: "a's" })] })) },
      {
        host_id: B,
        session: live("host-b"),
        board: boardOf(B, snapshot({ tasks: [task({ title: "b's" }), task({ id: TaskId.make("task-b"), title: "only b's" })] })),
      },
    ]
    const board = mergeBoards(emptyBoard, parts, A)
    expect(board.tasks[T1]?.title).toBe("a's")
    expect(board.tasks[T1]?.host_id).toBe(A)
    expect(board.tasks["task-b"]?.host_id).toBe(B)
    expect(board.profiles.map((p) => p.host_id)).toEqual([A, B])
    expect(board.projects.map((p) => p.host_id)).toEqual([A, B])
    expect(Object.keys(board.hostSettings)).toEqual([A, B])
    expect(board.hosts.map((h) => [h.id, h.local, h.connected])).toEqual([
      [A, true, true],
      [B, false, true],
    ])
  })

  it("leaves out the tasks of archived projects, and sorts projects by name", () => {
    const P2 = ProjectId.make("project-2")
    const archivedAt = Timestamp.make("2026-11-03T00:00:00.000Z")
    const host = boardOf(
      A,
      snapshot({
        projects: [
          project({ name: "zeta" }),
          project({ id: ProjectId.make("project-3"), name: "Alpha 10" }),
          project({ id: ProjectId.make("project-4"), name: "alpha 9" }),
        ],
        archived_projects: [project({ id: P2, name: "Old", archived_at: archivedAt })],
        tasks: [task(), task({ id: TaskId.make("task-2"), project_id: P2 })],
      }),
    )
    const board = mergeBoards(emptyBoard, [{ host_id: A, session: live("host-a"), board: host }], A)
    expect(Object.keys(board.tasks)).toEqual([T1])
    expect(board.projects.map((p) => p.name)).toEqual(["alpha 9", "Alpha 10", "zeta"])
    expect(board.archived.map((p) => p.name)).toEqual(["Old"])
  })

  it("says whether the page is signed in, connected and loaded from its own host's session", () => {
    const board = boardOf(A, snapshot())
    const with_ = (session: SessionView, b: HostBoard | undefined) => mergeBoards(emptyBoard, [{ host_id: A, session, board: b }], A)
    const connecting = with_({ state: { _tag: "connecting" }, info: null }, undefined)
    expect([connecting.authed, connecting.connected, connecting.loaded]).toEqual([null, false, false])
    const loaded = with_(live("host-a"), board)
    expect([loaded.authed, loaded.connected, loaded.loaded]).toEqual([true, true, true])
    const offline = with_({ state: { _tag: "offline", since: 0, error: "dropped" }, info: info("host-a") }, board)
    expect([offline.authed, offline.connected, offline.loaded, Object.keys(offline.tasks)]).toEqual([true, false, true, [T1]])
    const refused = with_({ state: { _tag: "unauthorized" }, info: null }, undefined)
    expect([refused.authed, refused.connected]).toEqual([false, false])
    expect(mergeBoards(emptyBoard, [], null).authed).toBeNull()
  })

  it("keeps the lists and records that did not change, so selectors of them see no change", () => {
    const first = boardOf(A, snapshot({ tasks: [task(), task({ id: TaskId.make("task-2") })] }))
    const parts = (b: HostBoard): ReadonlyArray<HostPart> => [{ host_id: A, session: live("host-a"), board: b }]
    const before = mergeBoards(emptyBoard, parts(first), A)
    const next = applyBoardEvent(first, { type: "task", seq: 2, task: task({ id: TaskId.make("task-2"), title: "Changed" }) })
    const after = mergeBoards(before, parts(next), A)
    expect(after.tasks).not.toBe(before.tasks)
    expect(after.tasks[T1]).toBe(before.tasks[T1])
    expect(after.projects).toBe(before.projects)
    expect(after.hosts).toBe(before.hosts)
    expect(mergeBoards(after, parts(next), A).tasks).toBe(after.tasks)
  })

  it("an optimistic patch shows the task's new status, place, star and pen, and nothing else", () => {
    const board = mergeBoards(emptyBoard, [{ host_id: A, session: live("host-a"), board: boardOf(A, snapshot()) }], A)
    const moved = withPatch(board, { host_id: A, id: T1 }, { status: "in_progress", position: 7, starred: true, title: "Not shown until it is saved" })
    expect(moved.tasks[T1]).toMatchObject({ status: "in_progress", position: 7, starred: true, title: "A task" })
    // Another host's task with that id is not this one.
    expect(withPatch(board, { host_id: B, id: T1 }, { status: "done" })).toBe(board)
  })

  it("star and reminder saves in flight show on the host's task, in order, each on its own", () => {
    const board = mergeBoards(emptyBoard, [{ host_id: A, session: live("host-a"), board: boardOf(A, snapshot()) }], A)
    expect(withPendingMarks(board.tasks, [])).toBe(board.tasks)
    // A snooze, then a clear while the snooze saves: the clear shows, and takes the note with it.
    const snooze = { host_id: A, id: T1, patch: { remind_at: "2026-11-12T10:00:00.000Z", reminder: "Think it over" } }
    const clear = { host_id: A, id: T1, patch: { remind_at: null } }
    expect(withPendingMarks(board.tasks, [snooze])[T1]).toMatchObject({ remind_at: "2026-11-12T10:00:00.000Z", reminder: "Think it over" })
    expect(withPendingMarks(board.tasks, [snooze, clear])[T1]).toMatchObject({ remind_at: null, reminder: null })
    // A star on top of what the host says (a rename meanwhile stays); another host's task with that id is not this one.
    const renamed = mergeBoards(
      emptyBoard,
      [{ host_id: A, session: live("host-a"), board: boardOf(A, snapshot({ tasks: [task({ title: "Renamed meanwhile" })] })) }],
      A,
    ).tasks
    expect(withPendingMarks(renamed, [{ host_id: A, id: T1, patch: { starred: true } }])[T1]).toMatchObject({ starred: true, title: "Renamed meanwhile" })
    expect(withPendingMarks(board.tasks, [{ host_id: B, id: T1, patch: { starred: true } }])[T1]?.starred).toBe(false)
  })
})
