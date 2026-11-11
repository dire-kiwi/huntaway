import { assert } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { CallId, TaskId } from "@huntaway/contracts"
import type { Profile, Project, Task } from "@huntaway/contracts"
import { fakeAgent, tempDir } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { Actor } from "../../../platform/Changes.ts"
import { Profiles } from "../../../profiles/Profiles.ts"
import { Projects } from "../../../projects/Projects.ts"
import { Tasks } from "../../../tasks/Tasks.ts"
import type { ToolResult } from "../../tool.ts"
import { ToolCalls } from "../../ToolCalls.ts"

// What the board tools' tests share (the old mcp/tools/testing.ts): profiles and projects to call on, an agent of a
// profile's to call as (a run of a task of its), and a call through `ToolCalls`, so the gates run as for any call.

const AT = "2026-11-12T00:00:00.000Z"

/** A profile. */
export const profile = (name: string, agentAccess: ReadonlyArray<string> = []) =>
  Effect.flatMap(Profiles, (profiles) => profiles.create({ name, agent_access: agentAccess })).pipe(Effect.orDie)

/** Lets the agents of the profiles named in `names` use `p`'s board. */
export const grant = (p: Profile, names: ReadonlyArray<string>) =>
  Effect.flatMap(Profiles, (profiles) => profiles.update(p.id, { agent_access: names })).pipe(Effect.orDie)

/** A project of `p`'s on a new folder, with key `key`. */
export const project = (p: Profile, name: string, key: string) =>
  Effect.gen(function* () {
    const dir = yield* tempDir
    return yield* (yield* Projects).create({ profile_id: p.id, name, key, repo_path: `${dir}/${name}` })
  }).pipe(Effect.orDie)

/** A task in project `p`, made by the user (not started). */
export const task = (p: Project, title: string, fields: { readonly use_worktree?: boolean } = {}) =>
  Effect.flatMap(Tasks, (tasks) => tasks.create({ project_id: p.id, title, use_worktree: fields.use_worktree ?? false }, Actor.user)).pipe(Effect.orDie)

/** Sets columns of a task's row, as the old tests' `db.update_task` did. */
export const setTask = (id: string, columns: Readonly<Record<string, string | number | null>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE tasks SET ${sql.update(columns)} WHERE id = ${id}`
  }).pipe(Effect.orDie)

/** The profile's assistant (`A-1`), a thread in no project that is left out of lists. */
export const assistant = (p: Profile) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const id = TaskId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4())
    yield* sql`INSERT INTO tasks (id, profile_id, title, status, task_type, number, last_activity_at, created_at, updated_at)
      VALUES (${id}, ${p.id}, 'Assistant', 'todo', 'assistant', 1, ${AT}, ${AT}, ${AT})`
    return id
  }).pipe(Effect.orDie)

/** An agent of `p`'s to call as: a run of its assistant (made if need be), which no list shows, so it is out of the way. */
export const agentOf = (p: Profile) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const found = yield* sql<{ readonly id: TaskId }>`SELECT id FROM tasks WHERE profile_id = ${p.id} AND task_type = 'assistant'`.pipe(Effect.orDie)
    return yield* fakeAgent({ task: found[0]?.id ?? (yield* assistant(p)) })
  })

/** An agent of task `t`'s to call as. */
export const agentOn = (t: Task) => fakeAgent({ task: t.id })

/** A call of `tool` by `agent`, through `ToolCalls`, with a fresh call id unless `id` is given. */
export const call = (agent: FakeAgent, tool: string, args: unknown, id?: string) =>
  Effect.gen(function* () {
    const callId = CallId.make(id ?? (yield* (yield* SecureRandom.SecureRandom).uuidV4()))
    return yield* (yield* ToolCalls).call({ call_id: callId, run: agent.run.id, server: "huntaway", tool, args })
  })

const AnObject = Schema.Record(Schema.String, Schema.Unknown)
const Objects = Schema.Array(AnObject)

/** What a call gave, as an object. */
export const ok = (result: ToolResult): Readonly<Record<string, unknown>> => {
  if (result._tag === "Err") return assert.fail(`it failed: ${result.message}`)
  return Schema.is(AnObject)(result.value) ? result.value : assert.fail("not an object")
}

/** What a call gave, as a list of objects. */
export const list = (result: ToolResult): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  if (result._tag === "Err") return assert.fail(`it failed: ${result.message}`)
  return Schema.is(Objects)(result.value) ? result.value : assert.fail("not a list")
}

/** The message a call failed with. */
export const err = (result: ToolResult): string => (result._tag === "Err" ? result.message : assert.fail(`it didn't fail: ${String(result.value)}`))

/** `<profile>:<field>` of each, as the old tests' `keys`. */
export const keys = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>, field: string) => rows.map((r) => `${String(r["profile"])}:${String(r[field])}`)

/** What is at `path` in a JSON value (undefined if it isn't there). */
export const at = (v: unknown, ...path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>((x, k) => (typeof x === "object" && x !== null && !Array.isArray(x) ? Object.entries(x).find(([n]) => n === k)?.[1] : undefined), v)

/** By text, for sorting. */
export const byText = (a: unknown, b: unknown) => String(a).localeCompare(String(b))

/** The task a result is. */
export const idOf = (v: Readonly<Record<string, unknown>>) => TaskId.make(str(v, "id"))

/** A string field of a result. */
export const str = (v: Readonly<Record<string, unknown>>, field: string): string => {
  const s = v[field]
  return typeof s === "string" ? s : assert.fail(`${field} is not a string: ${String(s)}`)
}
