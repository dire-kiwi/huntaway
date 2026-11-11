import { Context, Effect, Layer } from "effect"
import type { Timestamp } from "@huntaway/contracts"
import { minorNoted } from "./model.ts"
import { ReviewRepo } from "./ReviewRepo.ts"
import type { StatRow } from "./ReviewRepo.ts"

// What reviewers reported, kept for statistics (docs/plan/inventory/04-git-review.md 2.19; huntaway's review/stats.ts):
// a row in `review_stats` for each `submit_review`, for the task reviewed, with how many serious and minor issues it
// listed and the effort the work reviewed was done at, so issues can be told by model and effort. A task's `review` only
// has its latest round. Each row has its round's start, which every reviewer's submission in it shares; a reviewer that
// submits twice in a run is kept once, with what it submitted last. The old backfills (migrations 79 and 82) are the
// old database's: the importer brings their rows as they are.

/** A submission: its row, without `minor_noted`, which its summary decides with the minor issues it listed. */
export type Submission = Omit<StatRow, "minor_noted"> & { readonly summary: string | null }

export interface ReviewStatsShape {
  /** Keep a submission made at `at` (its run's earlier one replaced). The `review` telemetry event joins with telemetry. */
  readonly record: (s: Submission, at: Timestamp) => Effect.Effect<void>
}

export class ReviewStats extends Context.Service<ReviewStats, ReviewStatsShape>()("huntaway-server/review/ReviewStats") {
  static readonly layer = Layer.effect(
    ReviewStats,
    Effect.gen(function* () {
      const repo = yield* ReviewRepo
      return ReviewStats.of({
        record: Effect.fn("ReviewStats.record")(function* (s: Submission, at: Timestamp) {
          const { summary, ...row } = s
          yield* repo.addStat({ ...row, minor_noted: minorNoted(s.minor, summary) }, at)
        }),
      })
    }),
  )
}
