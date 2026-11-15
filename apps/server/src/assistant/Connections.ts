import { Context, Effect, Layer, Ref, Schedule } from "effect"
import type { ProfileId, Task, TaskId } from "@huntaway/contracts"
import { QuestionClosed, QuestionNotFound, Questions } from "../permissions/Questions.ts"
import { Runs } from "../runs/Runs.ts"
import type { SendRefused } from "../runs/Runs.ts"
import type { StoredRequest } from "../threads/model.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"
import { ThreadStore } from "../threads/ThreadStore.ts"
import type { RequestResolution } from "@huntaway/contracts"
import { connectedResolution, connectedText, connectionOf, connectionRequest, skippedResolution, skippedText, SWEEP_EVERY } from "./connectionText.ts"
import type { ConnectionKind, ConnectionState } from "./connectionText.ts"
import { Google } from "./Google.ts"

// The assistant's connection cards (HE-28; the plain parts are connectionText.ts): `request_connection` puts one in the
// thread (`ask`) when what it asks for isn't there; it's settled once, from its card (`check`, `skip`), by the board
// noticing the connection is made (`sweep`, every `SWEEP_EVERY` while any card is open), or by a message from the user
// (`Questions.settle`, as for questions: a card is a board question). Settling it sends the agent its message to carry on.

export interface ConnectionsShape {
  /** Whether `kind` is connected for the profile's assistant here: for Google, its card's status with the refresh token tried. */
  readonly state: (kind: ConnectionKind, profile: ProfileId) => Effect.Effect<ConnectionState>
  /** Puts a card for `kind` in `task`'s thread for MCP call `callId`, once for the call. */
  readonly ask: (task: TaskId, callId: string, kind: ConnectionKind, reason: string, problem: string | null) => Effect.Effect<void, TaskNotFound>
  /**
   * The card's Check again: what the connection's state is now, and if it's connected, the card settles and the agent is
   * told to carry on. Only the first settling counts.
   */
  readonly check: (task: TaskId, requestId: string) => Effect.Effect<ConnectionState, TaskNotFound | QuestionNotFound | QuestionClosed | SendRefused>
  /** The card's Skip: it settles, and the agent is told to carry on without it. */
  readonly skip: (task: TaskId, requestId: string) => Effect.Effect<Task, TaskNotFound | QuestionNotFound | QuestionClosed | SendRefused>
  /** Settles the open cards whose connection is made now; how many. */
  readonly sweep: Effect.Effect<number>
}

export class Connections extends Context.Service<Connections, ConnectionsShape>()("huntaway-server/assistant/Connections") {
  static readonly layer = Layer.effect(
    Connections,
    Effect.gen(function* () {
      const google = yield* Google
      const questions = yield* Questions
      const threads = yield* Threads
      const readers = yield* ThreadReaders
      const store = yield* ThreadStore
      const tasks = yield* TaskRepo
      const runs = yield* Runs
      // Whether a card may be open: the sweep reads the threads only then (true at start, for those from before).
      const maybeOpen = yield* Ref.make(true)

      /** Google: its card's status, with the refresh token tried with Google (a token it turns away isn't connected). */
      const googleState = Effect.fnUntraced(function* (profile: ProfileId) {
        const st = yield* google.status(profile, true).pipe(Effect.result)
        if (st._tag === "Failure") {
          const e = st.failure
          const failed: ConnectionState = { connected: false, account: null, problem: e._tag === "Conflict" ? e.detail : "this profile isn't on this host" }
          return failed
        }
        const s = st.success
        const connected = s.connected && s.verified !== false
        const out: ConnectionState = { connected, account: connected ? s.account : null, problem: connected ? null : (s.problem ?? s.verify_error ?? null) }
        return out
      })

      /** How each kind's state is read: another kind (an MCP server switched off for the profile, say) adds its own. */
      const states: { readonly [K in ConnectionKind]: (profile: ProfileId) => Effect.Effect<ConnectionState> } = { google: googleState }

      const state = Effect.fn("Connections.state")(function* (kind: ConnectionKind, profile: ProfileId) {
        return yield* states[kind](profile)
      })

      const ask = Effect.fn("Connections.ask")(function* (task: TaskId, callId: string, kind: ConnectionKind, reason: string, problem: string | null) {
        if (yield* readers.asked(task, callId)) return
        yield* threads.openRequest(task, connectionRequest(kind, reason, problem, callId))
        yield* Ref.set(maybeOpen, true)
      })

      /** The card `requestId` of `task`'s thread, still open: its connection and its task. */
      const openCard = Effect.fnUntraced(function* (task: TaskId, requestId: string) {
        const t = yield* tasks.get(task)
        if (t === null) return yield* new TaskNotFound({ id: task })
        const stored = yield* store.request(task, requestId)
        const kind = stored === null ? null : connectionOf(stored.request)
        if (stored === null || kind === null || stored.request.type !== "question") {
          return yield* new QuestionNotFound({ task_id: task, request_id: requestId })
        }
        yield* stillOpen(task, stored)
        return { task: t, kind, stored }
      })

      /** The card, if it's still open and the conversation hasn't moved past it. */
      const stillOpen = Effect.fnUntraced(function* (task: TaskId, stored: StoredRequest) {
        if (stored.request.resolution !== undefined) return yield* new QuestionClosed({ reason: "answered", detail: "this card has been settled already" })
        if (stored.write_no !== null && (yield* readers.movedOn(task, stored.write_no))) {
          return yield* new QuestionClosed({ reason: "moved_on", detail: "the conversation has moved on since this was asked" })
        }
        return stored
      })

      /** Settles the card (the compare and set: of two at once, one wins) and tells the agent `text`. */
      const settle = Effect.fnUntraced(function* (task: TaskId, stored: StoredRequest, resolution: RequestResolution, text: string) {
        yield* threads
          .resolveRequest(task, stored.request.id, resolution)
          .pipe(Effect.catchTag("RequestNotOpen", () => Effect.fail(new QuestionClosed({ reason: "answered", detail: "this card has been settled already" }))))
        const sent = yield* runs.send(task, { text, source: "board" }).pipe(
          // Open again, as it was, when the message can't be sent.
          Effect.tapError(() => threads.openRequest(task, stored.request).pipe(Effect.ignore)),
        )
        // Anything else it was waiting on is settled by this message.
        yield* questions.settle(task, "replied")
        return sent
      })

      const check = Effect.fn("Connections.check")(function* (task: TaskId, requestId: string) {
        const card = yield* openCard(task, requestId)
        const now = yield* state(card.kind, card.task.profile_id)
        if (now.connected) yield* settle(task, card.stored, connectedResolution(now.account), connectedText(card.kind, now.account))
        return now
      })

      const skip = Effect.fn("Connections.skip")(function* (task: TaskId, requestId: string) {
        const card = yield* openCard(task, requestId)
        return yield* settle(task, card.stored, skippedResolution, skippedText(card.kind))
      })

      const sweep = Effect.gen(function* () {
        if (!(yield* Ref.getAndSet(maybeOpen, false))) return 0
        const open = yield* store.openConnections
        if (open.length > 0) yield* Ref.set(maybeOpen, true)
        let settled = 0
        // Each profile's state is read once a pass.
        const seen = new Map<string, ConnectionState>()
        for (const { task_id, stored } of open) {
          const kind = connectionOf(stored.request)
          const t = yield* tasks.get(task_id)
          if (kind === null || t === null) continue
          const key = `${kind}\u0000${t.profile_id}`
          const now = seen.get(key) ?? (yield* state(kind, t.profile_id))
          seen.set(key, now)
          if (!now.connected) continue
          const done = yield* stillOpen(task_id, stored).pipe(
            Effect.andThen(settle(task_id, stored, connectedResolution(now.account), connectedText(kind, now.account))),
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
          if (done) settled += 1
        }
        return settled
      }).pipe(Effect.withSpan("Connections.sweep"))

      return Connections.of({ state, ask, check, skip, sweep })
    }),
  )

  /** The board's own look at the open cards' connections: at start, then every `SWEEP_EVERY`. */
  static readonly watcher = Layer.effectDiscard(
    Effect.gen(function* () {
      const connections = yield* Connections
      yield* connections.sweep.pipe(
        Effect.catchCause((cause) => Effect.logWarning("checking connections failed", cause)),
        Effect.repeat(Schedule.spaced(SWEEP_EVERY)),
        Effect.annotateLogs({ module: "assistant" }),
        Effect.forkScoped,
      )
    }),
  )
}
