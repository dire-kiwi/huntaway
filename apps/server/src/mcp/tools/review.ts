import { Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import { Reviews } from "../../review/Reviews.ts"
import { ForPlanning, ForReviewers, Rerunnable, ReviewersOnly, ToolError } from "../tool.ts"
import { boardTool } from "./common.ts"

// What a reviewer reports (docs/plan/inventory/03-mcp.md; the old mcp.ts `submit_review_tool` and mcp/tools/dispatch.ts):
// `submit_review`, offered to review threads only. Its verdict is recorded on the reviewer's part of the review and acted
// on when the reviewer's run ends (`Reviews.finished`). A workflow step's verdict is the workflow engine's (6.6).

export const SubmitReview = Tool.make("submit_review", {
  description: "Report the outcome of your review. Call it once, when the review is complete. Serious issues are sent to the task's agent to fix.",
  parameters: Schema.Struct({
    verdict: Schema.Literals(["pass", "needs_fixes"]).annotate({
      description: "needs_fixes if anything must be fixed before merging (list it in serious_issues); pass if it's ready to merge as far as correctness goes",
    }),
    summary: Schema.String.annotate({
      description: "A few sentences: what you reviewed and what you found, including minor issues and suggestions worth mentioning",
    }),
    serious_issues: Schema.Array(Schema.String).annotate({
      description:
        "Problems that must be fixed before merging: bugs that cause wrong behaviour, crashes, data loss, security holes, or a broken build or tests. One entry per issue: where (file:line), what goes wrong, and how to fix it. Empty if there are none. Style, nits and optional suggestions don't belong here.",
    }),
    minor_issues: Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        description:
          "Minor issues and suggestions that don't block merging but may be worth a follow-up: one short entry each. Empty if there are none. Mention them in the summary too.",
      }),
    ),
  }),
  success: Schema.Struct({ ok: Schema.Boolean, note: Schema.String }),
})
  // It records the verdict on the reviewer's part (a run submitting again replaces it), so a call cut short runs again.
  .annotate(Rerunnable, true)
  .annotate(ForReviewers, true)
  .annotate(ReviewersOnly, true)
  .annotate(ForPlanning, true)

/** A list given as one string is a list of one, as the old tool took it (an empty one is none). */
const asList = (v: unknown): unknown => (typeof v === "string" ? (v.trim() === "" ? [] : [v]) : v)

/** The reviewers' tool's handler. */
export const reviewTools = Effect.gen(function* () {
  const reviews = yield* Reviews
  const submitReview = boardTool(
    SubmitReview,
    (params, caller) =>
      reviews.submit(caller.task, caller.run.id, params).pipe(Effect.catchTag("ReviewRefused", (e) => Effect.fail(ToolError.other(e.reason)))),
    {
      prepare: (args) => ({
        ...args,
        ...("serious_issues" in args ? { serious_issues: asList(args["serious_issues"]) } : {}),
        ...("minor_issues" in args ? { minor_issues: asList(args["minor_issues"]) } : {}),
      }),
    },
  )
  return { submitReview }
})
