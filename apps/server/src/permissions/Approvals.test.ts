import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { tempDir, TestBoard } from "@huntaway/testing"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { approvalWhat, sameJson } from "./Approvals.ts"

// `Approvals`' plain parts, and the preview `update_project` shows (`Projects.preview`). The approvals themselves, asked
// and answered through the board's tools, are in mcp/tools/approvals.test.ts.

describe("Approvals", () => {
  it("says what an approval asks for", () => {
    assert.strictEqual(approvalWhat("create_project", { repo_path: "/x" }), "adding /x as a project")
    assert.strictEqual(approvalWhat("delete_task", { delete: { key: "KIW-2" } }), "deleting KIW-2")
    const changes = [
      { field: "name", needs_approval: false },
      { field: "setup_script", needs_approval: true },
      { field: "permission_mode", needs_approval: true },
    ]
    assert.strictEqual(approvalWhat("update_project", { changes }), "changing setup_script, permission_mode")
  })

  it("compares settings as JSON, whatever the order of their keys", () => {
    assert.isTrue(sameJson({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 }))
    assert.isTrue(sameJson({ a: undefined }, {}))
    assert.isFalse(sameJson([1, 2], [2, 1]))
    assert.isFalse(sameJson({ a: "" }, { a: null }))
  })

  it.effect("a preview checks and stores a change as update would, and changes nothing", () =>
    Effect.gen(function* () {
      const p = yield* (yield* Profiles).create({ name: "personal", agent_access: [] })
      const projects = yield* Projects
      const kiw = yield* projects.create({ profile_id: p.id, name: "kiwicd", key: "KIW", repo_path: `${yield* tempDir}/kiwicd` })
      const after = yield* projects.preview(kiw.id, { setup_script: "npm ci", model: " ", status_scripts: { done: "  " } })
      assert.deepStrictEqual([after.setup_script, after.model, after.status_scripts], ["npm ci", null, {}])
      assert.deepStrictEqual(yield* projects.get(kiw.id), kiw)
      const refused = yield* Effect.flip(projects.preview(kiw.id, { review_rounds: 99 }))
      assert.strictEqual(refused._tag, "Invalid")
    }).pipe(Effect.provide(TestBoard())),
  )
})
