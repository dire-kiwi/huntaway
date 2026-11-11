import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted, Schema } from "effect"
import { ASANA_TOKEN, fakeAsana, TestBoard } from "@huntaway/testing"
import { Asana, asanaLabel, taskGid } from "./Asana.ts"
import { ProfileRepo } from "./ProfileRepo.ts"
import { Profiles } from "./Profiles.ts"

// The old integrations/asana.test.ts and api/profiles.test.ts' `profiles_connect_to_asana_and_search_it`, against the
// fake Asana of @huntaway/testing.

const json = (value: unknown) => Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(Effect.orDie)
const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.flip(effect)

const names = (ts: ReadonlyArray<{ readonly name: string }>) => ts.map((t) => t.name)

/** `body` on a board whose Asana is the fake. */
const withAsana = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const url = yield* fakeAsana()
    return yield* body.pipe(Effect.provide(TestBoard({ asanaUrl: url })))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe("Asana", () => {
  // searches_every_workspace_and_finds_tasks_by_url
  it.live("searches every workspace and finds tasks by URL", () =>
    withAsana(
      Effect.gen(function* () {
        const asana = yield* Asana
        const user = yield* asana.me(ASANA_TOKEN)
        assert.deepStrictEqual([asanaLabel(user), user.workspaces], ["Ivy (ivy@example.com)", ["100", "200"]])
        assert.strictEqual((yield* failure(asana.me("nope"))).kind, "Unauthorized")
        // Open tasks first, each workspace's in Asana's order.
        assert.deepStrictEqual(names(yield* asana.search(ASANA_TOKEN, "")), ["Fix signup", "Write docs", "Fix login"])
        assert.deepStrictEqual(names(yield* asana.search(ASANA_TOKEN, " fix ")), ["Fix signup", "Fix login"])
        const found = yield* asana.search(ASANA_TOKEN, "https://app.asana.com/0/1/1002/f")
        assert.strictEqual(found.length, 1)
        const t = found[0]
        assert.deepStrictEqual([t?.gid, t?.url, t?.notes], ["1002", "https://app.asana.com/0/1/1002", "Notes for Fix signup"])
        assert.deepStrictEqual([t?.assignee, t?.projects, t?.workspace], ["Ivy", ["Web"], "Acme"])
        assert.strictEqual((yield* failure(asana.search(ASANA_TOKEN, "https://app.asana.com/0/1/5555"))).kind, "NotFound")
      }),
    ),
  )

  // reads_task_urls
  it("reads task URLs", () => {
    assert.strictEqual(taskGid("https://app.asana.com/0/1200000000000001/1200000000000002"), "1200000000000002")
    assert.strictEqual(taskGid("https://app.asana.com/0/1200000000000001/1200000000000002/f"), "1200000000000002")
    assert.strictEqual(taskGid("https://app.asana.com/0/0/1200000000000002?focus=true"), "1200000000000002")
    assert.strictEqual(taskGid("https://app.asana.com/1/1111111111/project/2222222222/task/3333333333"), "3333333333")
    assert.strictEqual(taskGid("https://app.asana.com/1/1111111111/task/3333333333?focus=true"), "3333333333")
    assert.strictEqual(taskGid("1200000000000002"), "1200000000000002")
    // A project, not a task.
    assert.strictEqual(taskGid("https://app.asana.com/0/1200000000000001"), null)
    assert.strictEqual(taskGid("https://app.asana.com/1/1111111111/project/2222222222/list"), null)
    // Words and short numbers are searched for.
    assert.strictEqual(taskGid("fix login"), null)
    assert.strictEqual(taskGid("2024"), null)
    assert.strictEqual(taskGid("https://example.com/0/1/2"), null)
  })

  // profiles_connect_to_asana_and_search_it
  it.live("a profile connects to Asana and searches it", () =>
    withAsana(
      Effect.gen(function* () {
        const profiles = yield* Profiles
        const repo = yield* ProfileRepo
        const p = yield* profiles.create({ name: "work" })
        const search = profiles.asanaTasks(p.id, "fix")
        const why = Effect.map(failure(search), (e) => (e._tag === "AsanaOff" ? e.reason : e._tag))
        assert.strictEqual(yield* why, "the work profile isn't connected to Asana")

        // A token Asana turns down isn't kept.
        const refused = yield* failure(profiles.update(p.id, { asana_token: "nope" }))
        assert.strictEqual(refused._tag, "Invalid")
        assert.include(refused._tag === "Invalid" ? refused.reason : "", "didn't accept the token")
        assert.strictEqual(yield* repo.asanaToken(p.id), null)

        // One it takes is, with who it's for; the board sees only that.
        const v = yield* profiles.update(p.id, { asana_token: ` ${ASANA_TOKEN} ` })
        assert.strictEqual(v.asana_user, "Ivy (ivy@example.com)")
        assert.isFalse((yield* json(v)).includes("asana_token"))
        const token = yield* repo.asanaToken(p.id)
        assert.strictEqual(token === null ? null : Redacted.value(token), ASANA_TOKEN)
        assert.isFalse((yield* json(yield* profiles.list)).includes(ASANA_TOKEN))
        assert.strictEqual((yield* profiles.update(p.id, { name: "job" })).asana_user, "Ivy (ivy@example.com)", "kept when other fields change")

        const found = yield* search
        assert.deepStrictEqual(
          found.map((t) => t.name),
          ["Fix signup", "Fix login"],
        )
        assert.strictEqual(found[0]?.url, "https://app.asana.com/0/1/1002")
        // A URL for a task the token can't see finds nothing.
        assert.deepStrictEqual(yield* profiles.asanaTasks(p.id, "https://app.asana.com/0/1/7777"), [])

        // Turned off, it keeps its token but finds nothing, until it's turned on again.
        const off = yield* profiles.update(p.id, { asana_enabled: false })
        assert.deepStrictEqual([off.asana_enabled, off.asana_user], [false, "Ivy (ivy@example.com)"])
        assert.strictEqual(yield* why, "Asana is turned off for the job profile (Settings → Profiles)")
        assert.strictEqual((yield* profiles.update(p.id, { name: "work" })).asana_enabled, false, "kept when other fields change")
        assert.strictEqual((yield* profiles.update(p.id, { asana_enabled: true })).asana_enabled, true)
        assert.strictEqual((yield* search).length, 2)

        const cleared = yield* profiles.update(p.id, { asana_token: null })
        assert.strictEqual(cleared.asana_user, null)
        assert.strictEqual(yield* repo.asanaToken(p.id), null)
        assert.strictEqual((yield* failure(search))._tag, "AsanaOff")
      }),
    ),
  )
})
