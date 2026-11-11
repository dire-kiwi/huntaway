import { Context, Effect, Layer, Ref, Schema } from "effect"
import type { Task } from "@huntaway/contracts"

// 6.7: what a launch takes from the assistant area (huntaway's runner/launch.ts, its assistant parts): the assistant and
// its routine threads work in the assistant's workspace, checked to be its own (a symlink in its place could be another
// assistant's), and are told its memory as its files say now, last in their instructions; the assistant's prompt run
// reads its routines' reports since its last turn, which are read once its agent has started with them. The assistant
// area sits below `runs/` in the dependency order, so it registers here when its layer is built, as the areas below
// answer agents' requests through `AgentRequests`. Until it does (and in tests that build no assistant), a launch is as
// any thread's.

/** The assistant's workspace isn't its own (or a routine thread's assistant is gone): the run doesn't start. */
export class WorkspaceRefused extends Schema.TaggedError<WorkspaceRefused, { readonly brand: unique symbol }>()("WorkspaceRefused", {
  reason: Schema.String,
}) {}

/** Where a run of the assistant (or a routine thread) works, and what it's told of its memory. */
export interface WorkspaceRun {
  readonly cwd: string
  readonly memory: string
}

/** The reports a prompt run of the assistant starts with, and what marks them read once its agent has started. */
export interface ReportsRun {
  readonly preface: string
  readonly started: Effect.Effect<void>
}

/** What the assistant area offers a launch. */
export interface AssistantLauncher {
  /** For the assistant or one of its routine threads: its workspace and memory. Null for other threads. */
  readonly workspace: (task: Task) => Effect.Effect<WorkspaceRun | null, WorkspaceRefused>
  /** For the assistant's prompt run (not a compaction): the routines' reports it hasn't read, if any. */
  readonly reports: (task: Task) => Effect.Effect<ReportsRun | null>
}

export interface AssistantLaunchShape extends AssistantLauncher {
  readonly register: (launcher: AssistantLauncher) => Effect.Effect<void>
}

const NONE: AssistantLauncher = { workspace: () => Effect.succeed(null), reports: () => Effect.succeed(null) }

export class AssistantLaunch extends Context.Service<AssistantLaunch, AssistantLaunchShape>()("huntaway-server/runs/AssistantLaunch") {
  static readonly layer = Layer.effect(
    AssistantLaunch,
    Effect.gen(function* () {
      const launcher = yield* Ref.make<AssistantLauncher>(NONE)
      return AssistantLaunch.of({
        register: (l) => Ref.set(launcher, l),
        workspace: (task) => Effect.flatMap(Ref.get(launcher), (l) => l.workspace(task)),
        reports: (task) => Effect.flatMap(Ref.get(launcher), (l) => l.reports(task)),
      })
    }),
  )
}
