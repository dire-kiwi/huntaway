import { Context, Effect, Layer, Stream } from "effect"
import type { BoardMessage, BoardSnapshot, Project } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import type { Since } from "../platform/Events.ts"
import { Identity } from "../platform/Identity.ts"
import { Permissions } from "../permissions/Permissions.ts"
import { AgentConfigs } from "../profiles/AgentConfigs.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Usage } from "../profiles/Usage.ts"
import { Projects } from "../projects/Projects.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { PenRepo } from "../tasks/PenRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"

export interface BoardShape {
  /** Everything the board holds for this host, read in one transaction, as at `seq`. */
  readonly snapshot: (seq: number) => Effect.Effect<BoardSnapshot>
  /**
   * `board.watch` (docs/plan/05-protocol.md, The board): `hello`, then the events after `since` when this boot can
   * replay them, else a snapshot; then every event. Ends with `resync` if the subscriber falls too far behind.
   */
  readonly watch: (since: Since | undefined) => Stream.Stream<BoardMessage>
}

/** The board's subscription. It reads every area, so it sits in `lifecycle/`, above them all. */
export class Board extends Context.Service<Board, BoardShape>()("huntaway-server/lifecycle/Board") {
  static readonly layer = Layer.effect(
    Board,
    Effect.gen(function* () {
      const db = yield* Db
      const events = yield* Events
      const identity = yield* Identity
      const profiles = yield* Profiles
      const configs = yield* AgentConfigs
      const projects = yield* Projects
      const settings = yield* HostSettings
      const tasks = yield* TaskRepo
      const pens = yield* PenRepo
      const usage = yield* Usage
      const permissions = yield* Permissions

      const snapshot = Effect.fn("Board.snapshot")(function* (seq: number) {
        return yield* db.tx(
          Effect.gen(function* () {
            const allProfiles = yield* profiles.list
            const active: Array<Project> = []
            const archived: Array<Project> = []
            for (const profile of allProfiles) {
              active.push(...(yield* projects.list(profile.id, false).pipe(Effect.orDie)))
              archived.push(...(yield* projects.list(profile.id, true).pipe(Effect.orDie)))
            }
            const snap: BoardSnapshot = {
              type: "snapshot",
              seq,
              profiles: allProfiles,
              configs: yield* configs.list,
              projects: active,
              archived_projects: archived,
              tasks: yield* tasks.all,
              pens: yield* pens.all,
              settings: yield* settings.get,
              usage: yield* usage.snapshot,
              approvals: yield* permissions.approvals,
            }
            return snap
          }),
        )
      })

      const watch = (since: Since | undefined): Stream.Stream<BoardMessage> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const watching = yield* events.watch(since)
            const hello: BoardMessage = { type: "hello", host_id: identity.hostId, boot: events.boot, seq: watching.seq }
            const first: ReadonlyArray<BoardMessage> = watching.replay ?? [yield* snapshot(watching.seq)]
            return Stream.concat(Stream.fromIterable([hello, ...first]), watching.live)
          }),
        )

      return Board.of({ snapshot, watch })
    }),
  )
}
