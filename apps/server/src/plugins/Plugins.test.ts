import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Result, Option, Redacted, Schema } from "effect"
import { Tool } from "effect/ai"
import { SqlClient } from "effect/sql"
import { boardScopes, PluginRpcs, TaskId } from "@huntaway/contracts"
import type { SessionShape } from "@huntaway/contracts"
import { definePlugin, Page, PluginError, PluginHost, PluginImport, pluginTool } from "@huntaway/plugin"
import type { Plugin } from "@huntaway/plugin"
import notes from "@huntaway/plugin/example/notes"
import { TestBoard } from "@huntaway/testing"
import { caller, ok as okText, refused, since } from "../docs/tests/docs.ts"
import { McpServers } from "../mcp/McpServers.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Plugins } from "./Plugins.ts"
import { pluginPaths } from "./start.ts"

// HE-34: plugins (docs/plan/15-plugins.md), through the example `notes` plugin and a few made here: each starts on its
// own database with its migrations, its MCP server is the board's like gh's (calls through `ToolCalls`, the run's
// context given), its pages and calls answer for a session, and one that fails to start leaves the others running.

const board: SessionShape = { kind: "board", scopes: boardScopes, device_id: null, via_link: null }
const reader: SessionShape = { ...board, kind: "device", scopes: new Set(["read"]) }

const run = <A, E, R>(effect: Effect.Effect<A, E, R>, plugins: ReadonlyArray<Plugin> = [notes]) =>
  effect.pipe(Effect.scoped, Effect.provide(TestBoard({}, plugins)))

/** A plugin tool's answer: its JSON, which the board gives as text. */
const ok = (...args: Parameters<typeof okText>) =>
  Effect.flatMap(okText(...args), (text) => Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text)).pipe(Effect.orDie)

/** A value as JSON text, to look for something in it. */
const jsonText = (v: unknown) => Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(v).pipe(Effect.orDie)

/** Why an effect failed: its error's tag, and its reason if it has one. */
const why = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.result(effect), (r) => (Result.isFailure(r) ? [r.failure._tag, "reason" in r.failure ? r.failure.reason : null] : ["succeeded", null]))

/** Tools for the plugins made here, for the parts `notes` doesn't use. */
const Echo = Tool.make("echo", { parameters: Schema.Struct({ text: Schema.String }), success: Schema.String })
const Secret = Tool.make("secret", { parameters: Schema.Struct({}), success: Schema.String })

describe("plugins", () => {
  it.effect("start on a database of their own, brought up to date with their migrations", () =>
    run(
      Effect.gen(function* () {
        const list = yield* (yield* Plugins).list
        assert.deepStrictEqual(list, [
          {
            id: "notes",
            name: "Notes",
            version: "0.1.0",
            description: "Notes agents keep for you, per profile and beside their task.",
            nav: { title: "Notes" },
            settings: { title: "Notes" },
            task: true,
            mcp: { tools: ["add_note", "list_notes"] },
            error: null,
          },
        ])
        const paths = pluginPaths((yield* DataDir).root, "notes")
        const fs = yield* FileSystem.FileSystem
        assert.isTrue(yield* fs.exists(paths.database))
        assert.isTrue(yield* fs.exists(paths.files))
        assert.strictEqual(((yield* fs.stat(paths.dir)).mode & 0o777).toString(8), "700")
        // Not in the board's database.
        const sql = yield* SqlClient.SqlClient
        const tables = yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master WHERE name = 'notes'`
        assert.deepStrictEqual(tables, [])
      }),
    ),
  )
})

describe("a plugin's server", () => {
  it.effect("is called through the board's dispatcher, as the run's agent", () =>
    run(
      Effect.gen(function* () {
        const c = yield* caller("ivan", "Board")
        const events = yield* since
        const r = yield* ok(c, "add_note", { text: "Remember the milk" }, "notes")
        assert.deepStrictEqual(Object.keys(Object(r)).toSorted(), ["id", "url"])
        assert.match(String(Object(r).url), new RegExp(`^http://127\\.0\\.0\\.1:\\d+/notes/${c.profile.id}$`))
        const mine = yield* ok(c, "list_notes", { mine: true }, "notes")
        assert.strictEqual(Array.isArray(mine) ? mine.length : -1, 1)
        assert.deepStrictEqual(
          (yield* events.seen).filter((e) => e["type"] === "plugin"),
          [{ type: "plugin", plugin: "notes", topic: "notes", profile_id: c.profile.id, data: { id: 1 }, reload: true }],
        )
        const servers = yield* McpServers
        assert.deepStrictEqual(yield* servers.defined, [{ name: "notes", preApproved: true }])
        assert.isTrue(yield* servers.known("notes"))
        assert.isFalse(yield* servers.known("nope"))
        // A wrong argument is the dispatcher's to refuse, as for any server.
        assert.match(yield* refused(c, "add_note", { txt: "x" }, "notes"), /has no argument "txt"/)
        assert.match(yield* refused(c, "add_note", { text: " " }, "notes"), /a note needs some text/)
      }),
    ),
  )

  it.effect("tells each run its instructions and the tools it's offered", () =>
    run(
      Effect.gen(function* () {
        const c = yield* caller("ivan", "Board")
        const servers = yield* McpServers
        const init = yield* servers.answer("notes", false, { id: 1, method: "initialize", params: {} }, null, c.agent.run.id)
        assert.include(yield* jsonText(init), "under the profile ivan")
        const listed = yield* servers.answer("notes", false, { id: 2, method: "tools/list", params: {} }, null, c.agent.run.id)
        assert.include(yield* jsonText(listed), '"readOnlyHint":true')
      }),
    ),
  )

  it.effect("offers a tool to the runs it says, and refuses it to the others", () => {
    const picky = definePlugin({
      id: "picky",
      name: "Picky",
      version: "1",
      make: Effect.succeed({
        mcp: {
          tools: [
            pluginTool(Echo, ({ text }, call) => Effect.succeed(`${call.task.key} ${call.project?.name ?? "-"}: ${text}`), {
              offer: (r) => Effect.succeed(r.project !== null),
            }),
          ],
        },
      }),
    })
    return run(
      Effect.gen(function* () {
        const inProject = yield* caller("ivan", "Board")
        const assistant = yield* caller("other")
        assert.strictEqual(yield* ok(inProject, "echo", { text: "hi" }, "picky"), "BOA-1 Board: hi")
        assert.match(yield* refused(assistant, "echo", { text: "hi" }, "picky"), /isn't offered to this run/)
        const servers = yield* McpServers
        assert.notInclude(
          yield* jsonText(yield* servers.answer("picky", false, { id: 1, method: "tools/list", params: {} }, null, assistant.agent.run.id)),
          "echo",
        )
      }),
      [picky],
    )
  })
})

describe("a plugin's pages and calls", () => {
  it.effect("render for a session, in their slots", () =>
    run(
      Effect.gen(function* () {
        const c = yield* caller("ivan", "Board")
        yield* ok(c, "add_note", { text: "Ship <it>" }, "notes")
        const plugins = yield* Plugins
        const page = (slot: "page" | "settings" | "task", path: string, task_id: string | null = null) =>
          plugins.page({ plugin: "notes", slot, path, query: {}, task_id: task_id === null ? null : TaskId.make(task_id) }, board)
        assert.deepStrictEqual(yield* page("page", ""), { type: "redirect", path: c.profile.id })
        const shown = yield* page("page", c.profile.id)
        assert.strictEqual(shown.type, "html")
        assert.include(yield* jsonText(shown), "Ship &lt;it&gt;")
        assert.include(yield* jsonText(yield* page("task", "", c.task)), "Ship &lt;it&gt;")
        // Another task's page has nothing of the plugin's.
        const other = yield* caller("x", "Else")
        assert.deepStrictEqual(yield* page("task", "", other.task), { type: "html", title: null, html: "", empty: true })
        assert.include(yield* jsonText(yield* page("settings", "")), "keeps 1 notes")
        assert.deepStrictEqual(yield* why(page("page", "no-such-profile")), ["PluginFailed", "not_found"])
        assert.deepStrictEqual(yield* why(plugins.page({ plugin: "nope", slot: "page", path: "", query: {}, task_id: null }, board)), ["NotFound", null])
      }),
    ),
  )

  it.effect("are refused to a session without the call's scope", () =>
    run(
      Effect.gen(function* () {
        const c = yield* caller("ivan", "Board")
        yield* ok(c, "add_note", { text: "x" }, "notes")
        const plugins = yield* Plugins
        assert.deepStrictEqual(yield* why(plugins.call("notes", "delete", { id: 1 }, reader)), ["Forbidden", null])
        assert.deepStrictEqual(yield* why(plugins.call("notes", "delete", { id: "one" }, board)), ["PluginFailed", "invalid"])
        assert.deepStrictEqual(yield* plugins.call("notes", "delete", { id: 1 }, board), { deleted: true })
        assert.deepStrictEqual(yield* plugins.call("notes", "delete", { id: 1 }, board), { deleted: false })
        assert.deepStrictEqual(yield* why(plugins.call("notes", "toString", {}, board)), ["NotFound", null])
      }),
    ),
  )
})

describe("a plugin that can't start", () => {
  it.effect("is listed with why, and the others start", () => {
    const broken = definePlugin({
      id: "broken",
      name: "Broken",
      version: "1",
      migrations: [{ name: "0001", run: Effect.flatMap(SqlClient.SqlClient, (sql) => sql`CREATE TABLE oops (`) }],
      make: Effect.succeed({}),
    })
    const refusing = definePlugin({ id: "refusing", name: "Refusing", version: "1", make: Effect.fail(PluginError.failed("no config")) })
    const reserved = definePlugin({ id: "docs", name: "Docs", version: "1", make: Effect.succeed({}) })
    const misnamed = definePlugin({ id: "My-Plugin", name: "Mine", version: "1", make: Effect.succeed({}) })
    return run(
      Effect.gen(function* () {
        const list = yield* (yield* Plugins).list
        assert.deepStrictEqual(
          list.map((p) => [p.id, p.error === null ? null : p.error.slice(0, 40)]),
          [
            ["broken", list[0]?.error?.slice(0, 40) ?? "?"],
            ["refusing", "no config"],
            ["docs", "docs is one of the board's own names, so"],
            ["My-Plugin", "a plugin's id is a lowercase letter, the"],
            ["notes", null],
          ],
        )
        assert.isNotNull(list[0]?.error)
        assert.isFalse(yield* (yield* McpServers).known("broken"))
        // The list encodes as `plugins.list` answers it, the plugin with a bad id included, so the board can say why.
        const rpc = PluginRpcs.requests.get("plugins.list")
        assert.isDefined(rpc)
        const encoded = yield* Schema.encodeUnknownEffect(rpc?.successSchema ?? Schema.Never)(list)
        assert.deepStrictEqual(encoded, list)
      }),
      [broken, refusing, reserved, misnamed, notes],
    )
  })
})

describe("the board's services", () => {
  it.effect("keep a plugin's secrets, per profile, in its own database", () => {
    const keeper = definePlugin({
      id: "keeper",
      name: "Keeper",
      version: "1",
      make: Effect.gen(function* () {
        const host = yield* PluginHost
        yield* host.secrets.set("p1", "token", Redacted.make("s3cret"))
        yield* host.secrets.set(null, "token", "own")
        return {
          mcp: {
            tools: [
              pluginTool(Secret, (_, call) =>
                Effect.map(host.secrets.get(call.profile.id === "p1" ? "p1" : null, "token"), (v) =>
                  Option.match(v, { onNone: () => "none", onSome: Redacted.value }),
                ),
              ),
            ],
          },
        }
      }),
    })
    return run(
      Effect.gen(function* () {
        const c = yield* caller("ivan", "Board")
        assert.strictEqual(yield* ok(c, "secret", {}, "keeper"), "own")
        const sql = yield* SqlClient.SqlClient
        assert.deepStrictEqual(yield* sql`SELECT name FROM sqlite_master WHERE name = 'huntaway_secrets'`, [])
      }),
      [keeper],
    )
  })

  it.effect("let a migration copy only the board's tables listed for the plugin", () => {
    let said = ""
    const copier = definePlugin({
      id: "copier",
      name: "Copier",
      version: "1",
      migrations: [
        {
          name: "0001-copy",
          run: Effect.gen(function* () {
            const importer = yield* PluginImport
            said = `${importer.tables.length}:${yield* importer.rows("tasks").pipe(
              Effect.as("read"),
              Effect.catchTag("PluginError", (e) => Effect.succeed(e.reason)),
            )}`
          }),
        },
      ],
      make: Effect.succeed({ pages: { render: () => Effect.succeed(Page.html(said)) } }),
    })
    return run(
      Effect.gen(function* () {
        const page = yield* (yield* Plugins).page({ plugin: "copier", slot: "page", path: "", query: {}, task_id: null }, board)
        assert.deepStrictEqual(page, { type: "html", title: null, html: "0:not_found", empty: false })
      }),
      [copier],
    )
  })
})
