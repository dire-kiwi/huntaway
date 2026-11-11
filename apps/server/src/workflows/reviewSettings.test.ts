import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { ProjectPatch, Workflow, WorkflowNode } from "@huntaway/contracts"
import { toJson } from "../platform/columns.ts"
import { Projects } from "../projects/Projects.ts"
import { AT, onBoard, PROJECT, setProject, settle, workable } from "./tests/board.ts"
import { Workflows } from "./Workflows.ts"

// The Review tab's reviews moved into a workflow (huntaway's integrations/workflows/review_settings.test.ts): turning a
// project's `use_workflows` on (through `Projects`, the reactor making the move) moves its automatic reviews, rounds of
// fixes and summaries into a workflow, with its reviewers and its profile's summarizers.
//
// Not ported: "projects that used workflows have their reviews moved once" tests the one-time move at startup of every
// project that used workflows before (setting `workflows_reviews_moved`), which this port drops: there are no such
// projects to move (docs/plan/06-server.md, Workflows).

/** Changes the project as the user does, and waits for what follows. */
const change = (patch: ProjectPatch) =>
  Effect.gen(function* () {
    yield* (yield* Projects).update(PROJECT, patch)
    yield* settle
  })

const own = Effect.flatMap(Workflows, (w) => w.list(PROJECT))

/** The workflow's nodes by id. */
const nodes = (w: Workflow): Readonly<Record<string, WorkflowNode>> => Object.fromEntries(w.graph.nodes.map((n) => [n.id, n]))

/** What an agent step has, as the old tests read it. */
const agentOf = (n: WorkflowNode | undefined) => (n?.kind === "agent" ? n : assert.fail(`not an agent step: ${n?.id ?? "none"}`))

describe("the Review tab's reviews as a workflow", () => {
  // HA-277: a project that uses workflows has no automatic reviews of the board's, so turning it on moves the Review
  // tab's reviews, fix rounds and summaries into a workflow, with its reviewers and its profile's summarizers.
  it.effect("turning use_workflows on moves the Review tab's reviews into a workflow", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO agent_configs ${sql.insert({ id: "cfg", name: "Other", config_dir: "/other", agent: "claude", created_at: AT })}`
        const summarizers = yield* toJson([{ claude_config_id: null, model: "haiku", effort: null, name: "Short", skills: ["brief"] }])
        yield* sql`UPDATE profiles SET claude_config_ids = '["cfg"]', summarizers = ${summarizers} WHERE id = 'p'`
        yield* setProject({
          use_workflows: 0,
          auto_review: 1,
          auto_summary: 1,
          review_rounds: 3,
          reviewers: yield* toJson([
            { claude_config_id: "cfg", model: null, effort: "high", prompt: "Look for races." },
            // A config that's gone since: the task's.
            { claude_config_id: "gone", model: "opus", effort: null },
          ]),
        })
        yield* change({ use_workflows: true })
        const all = yield* own
        assert.strictEqual(all.length, 1)
        const w = all[0] ?? assert.fail("no workflow")
        assert.deepStrictEqual([w.name, w.enabled], ["Review and summarise", true])
        const n = nodes(w)
        const start = n["start"]
        assert.deepStrictEqual([start?.kind, start?.kind === "column" ? start.status : null], ["column", "in_review"])
        assert.strictEqual(n["changed"]?.kind === "condition" ? n["changed"].check : null, "changed")
        const r1 = agentOf(n["reviewer1"])
        assert.deepStrictEqual([r1.claude_config_id, r1.effort, r1.prompt, r1.output], ["cfg", "high", "Look for races.", "verdict"])
        const r2 = agentOf(n["reviewer2"])
        assert.deepStrictEqual([r2.claude_config_id, r2.model], [undefined, "opus"])
        assert.strictEqual(n["fix"]?.kind === "send_to_task" ? n["fix"].max_rounds : null, 3)
        const s = agentOf(n["summary"])
        assert.deepStrictEqual([s.name, s.model, s.skills, s.join, s.output], ["Short", "haiku", ["brief"], "all", "text"])
        const has = (from: string, port: string, to: string) => w.graph.edges.some((e) => e.from === from && e.port === port && e.to === to)
        assert.isTrue(has("start", "done", "changed") && has("changed", "yes", "reviewer1") && has("changed", "yes", "reviewer2"))
        assert.isTrue(has("reviewer1", "issues", "fix") && has("reviewer2", "pass", "summary"))
        // It has one: off and on again moves nothing more.
        yield* change({ use_workflows: false })
        yield* change({ use_workflows: true })
        assert.strictEqual((yield* own).length, 1)
        // Nor with the automatic reviews off.
        yield* change({ use_workflows: false, auto_review: false })
        yield* (yield* Workflows).delete(w.id)
        yield* change({ use_workflows: true })
        assert.strictEqual((yield* own).length, 0)
        // Without summaries, it's only the review.
        yield* change({ use_workflows: false, auto_review: true, auto_summary: false, reviewers: [] })
        yield* change({ use_workflows: true })
        const [r] = yield* own
        assert.strictEqual(r?.name, "Review")
        assert.deepStrictEqual(r?.graph.nodes.map((x) => x.id).toSorted(), ["changed", "fix", "reviewer", "start"])
      }),
    ),
  )

  // HA-277 review: a reviewer's settings are checked less than a workflow's agent steps (up to 20 skills, any effort or
  // model through update_project, a prompt's length in characters): the move keeps what a step can have, rather than
  // leaving the project with workflows and no reviews.
  it.effect("moving reviews keeps what an agent step can have", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        const skills = Array.from({ length: 12 }, (_, i) => `/skill${i + 1}`)
        yield* setProject({
          use_workflows: 0,
          auto_review: 1,
          auto_summary: 0,
          reviewers: yield* toJson([{ claude_config_id: null, model: "--dangerous flag", effort: "turbo", skills, prompt: "é".repeat(15_000) }]),
        })
        yield* change({ use_workflows: true })
        const w = (yield* own)[0] ?? assert.fail("the reviews weren't moved")
        const r = agentOf(nodes(w)["reviewer"])
        assert.deepStrictEqual(
          r.skills,
          skills.slice(0, 10).map((x) => x.slice(1)),
        )
        assert.deepStrictEqual([r.effort, r.model], [undefined, undefined])
        assert.isTrue(new TextEncoder().encode(r.prompt).length <= 20_000 && r.prompt.length === 10_000 && !r.prompt.includes("�"))
      }),
    ),
  )
})
