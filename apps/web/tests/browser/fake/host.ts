// The fake host for the component checks (docs/plan/09-frontend.md, Tests): `fakeHost(board)` is an in-memory host
// that the page's session connects to in place of the websocket (mount.tsx installs its transport). It answers
// `board.watch` from the board (builders.ts) and the events a check emits, the task basics as the server does, and
// what a check adds with `on`. It keeps every call; one it has no handler for fails the check (mount.tsx's cleanUp)
// unless it is `allow`ed: the fake says what it does not know rather than answer something made up.
import { Effect, Layer, Predicate, Queue, Stream } from "effect"
import {
  type BoardEventInput,
  type BoardMessage,
  type BoardSnapshot,
  type Health,
  type HostInfo,
  NotFound,
  PROTOCOL,
  type Task,
  TaskId,
} from "@huntaway/contracts"
import { HostClient, HostSession, type HostTask, type Methods, type Transport } from "@huntaway/client"
import { type Board, changed } from "./builders"

/** What a handler gives: the answer, or an Effect of it (to fail with a tagged error, or answer late with `delay`). */
type Answer<M extends keyof Methods> = Methods[M]["success"] | Effect.Effect<Methods[M]["success"], Methods[M]["error"]>
type Handler<M extends keyof Methods> = (payload: Methods[M]["payload"]) => Answer<M>

/** A call the fake host had: its method and payload. */
export interface FakeCall {
  readonly method: string
  readonly payload: unknown
}

export interface FakeHost {
  readonly board: Board
  /** Every call but `board.watch`, oldest first. */
  readonly calls: ReadonlyArray<FakeCall>
  /** Calls with no handler that were not allowed: they fail the check. */
  readonly missed: ReadonlyArray<string>
  /** What the page's session connects through (mount.tsx installs it). */
  readonly transport: Transport
  /** Answers `method` with `handler`, in place of a default or an earlier one. */
  on<M extends keyof Methods>(method: M, handler: Handler<M>): FakeHost
  /** Calls with no handler that are expected (a part of the component the check does not look at), by method name. */
  allow(pattern: RegExp): FakeHost
  /** The payloads sent with `method`, oldest first. */
  sent<M extends keyof Methods>(method: M): Array<Methods[M]["payload"]>
  /** Sends `event` to the page as the host's board stream does, numbered after the last. */
  emit(event: BoardEventInput): void
  /** Changes a task on the board and sends its `task` event; gives the task as it is now. */
  update(id: string, change: Partial<Task>): HostTask
}

/** Waits `ms` before going on: `server.on("tasks.update", (p) => delay(200).pipe(Effect.as(task)))` answers late. */
export const delay = (ms: number): Effect.Effect<void> => Effect.sleep(ms)

const isFlat = (f: unknown): f is HostClient["Service"] => typeof f === "function"

/** What the client sends with `method`: its payload (the client's own types made it so). */
const isPayload = <M extends keyof Methods>(_method: M, p: unknown): p is Methods[M]["payload"] => p === undefined || typeof p === "object"

/** A handler's answer as an Effect. */
const asEffect = <A, E>(out: A | Effect.Effect<A, E>): Effect.Effect<A, E> => (Effect.isEffect(out) ? out : Effect.succeed(out))

const isNumbered = (u: unknown): u is BoardMessage & { readonly seq: number } => Predicate.hasProperty(u, "type") && Predicate.hasProperty(u, "seq")

const installed: { current: FakeHost | null } = { current: null }

/** The fake host made last, which `mount` connects the page to (and `cleanUp` takes away). */
export const current = (): FakeHost | null => installed.current
export const uninstall = (): void => {
  installed.current = null
}

export function fakeHost(b: Board): FakeHost {
  const handlers = new Map<string, (payload: unknown) => Effect.Effect<unknown, { readonly _tag: string }>>()
  const calls: Array<FakeCall> = []
  const missed: Array<string> = []
  const allowed: Array<RegExp> = []
  const open = new Set<Queue.Queue<BoardMessage>>()
  const log = { seq: 1 }
  const boot = "fake-boot"

  const snapshot = (): BoardSnapshot => ({
    type: "snapshot",
    seq: log.seq,
    profiles: b.profiles,
    configs: b.claudeConfigs,
    projects: b.projects.filter((p) => !p.archived_at),
    archived_projects: b.projects.filter((p) => !!p.archived_at),
    tasks: b.tasks,
    pens: b.pens,
    settings: b.settings,
    usage: [],
    approvals: [],
  })

  // `hello` and a snapshot of the board as it is now, then every event emitted.
  const watch = Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<BoardMessage>()
      open.add(queue)
      yield* Queue.offerAll(queue, [{ type: "hello", host_id: b.host.id, boot, seq: log.seq }, snapshot()])
      return Stream.fromQueue(queue).pipe(Stream.ensuring(Effect.sync(() => open.delete(queue))))
    }),
  )

  const answer = (method: string, payload: unknown): unknown => {
    calls.push({ method, payload })
    const handler = handlers.get(method)
    if (handler) return handler(payload)
    if (!allowed.some((a) => a.test(method))) missed.push(method)
    return Effect.die(new Error(`the fake host has no handler for ${method}`))
  }

  const flat = (method: string, payload: unknown): unknown => (method === "board.watch" ? watch : answer(method, payload))
  const layer = Layer.mergeAll(Layer.effect(HostClient, isFlat(flat) ? Effect.succeed(flat) : Effect.die(new Error("not a client"))), HostSession.layer(true))

  const host: FakeHost = {
    board: b,
    calls,
    missed,
    transport: () => layer,
    on(method, handler) {
      handlers.set(method, (payload) => (isPayload(method, payload) ? asEffect(handler(payload)) : Effect.die(new Error(`not a payload of ${method}`))))
      return host
    },
    allow(pattern) {
      allowed.push(pattern)
      return host
    },
    sent(method) {
      return calls.flatMap((c) => (c.method === method && isPayload(method, c.payload) ? [c.payload] : []))
    },
    emit(event) {
      log.seq += 1
      const message = { ...event, seq: log.seq }
      if (!isNumbered(message)) return
      for (const queue of open) Queue.offerUnsafe(queue, message)
    },
    update(id, change) {
      const i = b.tasks.findIndex((t) => t.id === id)
      const task = changed<HostTask>(b.get(id), change)
      if (i >= 0) b.tasks[i] = task
      host.emit({ type: "task", task })
      return task
    },
  }

  // What the board's own data answers, as the server does.
  const health: Health = { ok: true, host_id: b.host.id, version: "0.0.0-test", protocol: PROTOCOL, capabilities: [], commit: null }
  const info: HostInfo = {
    host_id: b.host.id,
    host_name: b.host.name,
    build_id: "test",
    version: "0.0.0-test",
    protocol: PROTOCOL,
    capabilities: [...b.host.capabilities],
    read_only: false,
    commit: null,
    updates_from: null,
    agents: b.host.agents ?? true,
    agent_clis: [],
    data_dir: "/data",
    hostname: "test",
    home: null,
  }
  const task = (idOrKey: string) => {
    const found = b.tasks.find((t) => t.id === idOrKey || t.key === idOrKey)
    return found ? Effect.succeed(found) : Effect.fail(new NotFound({ what: "task", id: idOrKey }))
  }
  host
    .on("public.health", () => health)
    .on("host.info", () => info)
    .on("profiles.list", () => b.profiles)
    .on("configs.list", () => b.claudeConfigs)
    .on("projects.list", ({ archived, profile_id }) => b.projects.filter((p) => p.profile_id === profile_id && !!p.archived_at === (archived === true)))
    .on("projects.get", ({ id }) => {
      const found = b.projects.find((p) => p.id === id)
      return found ? Effect.succeed(found) : Effect.fail(new NotFound({ what: "project", id }))
    })
    .on("tasks.get", ({ id }) => task(id))
    .on("tasks.update", ({ id, patch }) =>
      Effect.map(task(id), (t) => {
        // The patch's fields that a task has, as they are (the server's checks are its own tests').
        const fields = Object.fromEntries(Object.entries(patch).filter(([k]) => k in t))
        return host.update(t.id, fields)
      }),
    )
    .on("tasks.create", ({ task: input }) => {
      const where = b.projects.find((p) => p.id === input.project_id) ?? null
      const made = b.task(
        {
          title: input.title || (input.description ?? "").split("\n")[0] || "Untitled",
          description: input.description ?? "",
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
        where,
      )
      host.emit({ type: "task", task: made })
      return made
    })
    .on("tasks.delete", ({ id }) =>
      Effect.map(task(id), (t) => {
        b.tasks.splice(b.tasks.indexOf(t), 1)
        host.emit({ type: "task_deleted", id: TaskId.make(t.id), project_id: t.project_id })
      }),
    )
    // 4.5: a preview the fake can't reach, and work that is merged (a check gives its own).
    .on("board.previewStatus", () => ({ up: false, status: null }))
    .on("tasks.unmerged", () => ({ unmerged: false }))
  installed.current = host
  return host
}
