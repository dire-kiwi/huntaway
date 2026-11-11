import { Clock, DateTime, Effect, Layer, Schedule } from "effect"
import { Timestamp } from "@huntaway/contracts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { LaunchFacts } from "./LaunchFacts.ts"
import { RunRepo } from "./RunRepo.ts"
import { Runs } from "./Runs.ts"

// Compacting idle Claude sessions (docs/plan/07-agents.md, Services; inventory 01, section 6; huntaway's
// runner/send.ts `auto_compact`): a session idle this long is compacted while its prompt cache (an hour) is still warm,
// so compacting is cheap and the next prompt starts from a small context. At start, then every minute.

/** A session idle this long is compacted. */
export const AUTO_COMPACT_AFTER_MINUTES = 50
/** Past this, the cache has expired: compacting would cost as much as it saves. */
export const AUTO_COMPACT_UNTIL_MINUTES = 60

const minutesAgo = (now: number, minutes: number) => Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(now - minutes * 60_000)))

/** One pass: compact the Claude sessions whose last run ended between 60 and 50 minutes ago. */
export const compactIdle = Effect.gen(function* () {
  const config = yield* ServerConfig
  if (config.noAgents) return
  const runs = yield* Runs
  const repo = yield* RunRepo
  const tasks = yield* TaskRepo
  const facts = yield* LaunchFacts
  const now = yield* Clock.currentTimeMillis
  for (const id of yield* repo.idleSessions(minutesAgo(now, AUTO_COMPACT_AFTER_MINUTES), minutesAgo(now, AUTO_COMPACT_UNTIL_MINUTES))) {
    const task = yield* tasks.get(id)
    // Compacting while the prompt cache is warm is a Claude saving.
    if (task === null || (yield* facts.config(task))?.agent === "codex") continue
    yield* runs
      .compact(id, `Compacting the conversation after ${AUTO_COMPACT_AFTER_MINUTES} minutes idle`)
      .pipe(Effect.catch((e) => Effect.logWarning(`task=${id} auto-compact failed: ${e._tag}`)))
  }
}).pipe(Effect.withSpan("Compaction.compactIdle"))

/** The loop, as long as the server runs. */
export const Compaction = Layer.effectDiscard(
  compactIdle.pipe(
    Effect.catchCause((cause) => Effect.logWarning("finding idle sessions failed", cause)),
    Effect.repeat(Schedule.spaced("60 seconds")),
    Effect.annotateLogs({ module: "runs" }),
    Effect.forkScoped,
  ),
)
