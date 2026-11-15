import { DateTime, Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import { HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { definePlugin, Page, pluginCall, PluginError, PluginHost, pluginTool } from "../src/index.ts"
import type { CallContext } from "../src/index.ts"

// An example plugin, and the one the API's tests and the demo board run (docs/plan/15-plugins.md): agents keep notes
// with its MCP server (`mcp__notes__add_note`, `list_notes`), people read them on its page (`/notes/<profile id>`),
// beside a task (its panel on the task's page), and delete them from the page. Every part of the API in one file:
// migrations, tools, pages, calls, events, a route and the board's services.

const Note = Schema.Struct({
  id: Schema.Int,
  profile_id: Schema.String,
  task_id: Schema.NullOr(Schema.String),
  task_key: Schema.NullOr(Schema.String),
  text: Schema.String,
  created_at: Schema.String,
})
type Note = typeof Note.Type

const decodeNotes = Schema.decodeUnknownEffect(Schema.Array(Note))

export const AddNote = Tool.make("add_note", {
  description: "Keep a note for the user on the board's Notes page, beside your task. Give its text; the reply has the note's link.",
  parameters: Schema.Struct({ text: Schema.String.annotate({ description: "The note, as plain text" }) }),
  success: Schema.Struct({ id: Schema.Int, url: Schema.String }),
})

export const ListNotes = Tool.make("list_notes", {
  description: "List the notes your profile keeps (newest first), or only your task's with mine: true.",
  parameters: Schema.Struct({ mine: Schema.optionalKey(Schema.Boolean.annotate({ description: "Only this task's notes" })) }),
  success: Schema.Array(Note),
}).annotate(Tool.Readonly, true)

const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

const STYLE = `<style>
body{margin:0;padding:20px 24px;background:var(--color-bg);color:var(--color-fg);font:14px/1.5 var(--font-sans, system-ui)}
h1{font-size:18px;margin:0 0 12px} ul{list-style:none;padding:0;margin:0}
li{border:1px solid var(--color-line-strong);border-radius:8px;padding:8px 12px;margin:0 0 8px;background:var(--color-panel-2)}
.meta{color:var(--color-muted);font-size:12px} a{color:var(--color-accent)} button{font:inherit;cursor:pointer}
</style>`

const list = (notes: ReadonlyArray<Note>, deletable: boolean) =>
  notes.length === 0
    ? `<p class="meta">No notes yet.</p>`
    : `<ul>${notes
        .map(
          (n) =>
            `<li><div>${escape(n.text)}</div><div class="meta">${escape(n.created_at)}` +
            (n.task_id === null ? "" : ` · <a href="/t/${encodeURIComponent(n.task_id)}">${escape(n.task_key ?? "task")}</a>`) +
            (deletable ? ` · <button data-delete="${n.id}">Delete</button>` : "") +
            `</div></li>`,
        )
        .join("")}</ul>`

/** The page's script: Delete asks the board to call the plugin; the page is rendered again on the `notes` event. */
const SCRIPT = `<script>
addEventListener("click", (e) => {
  const id = e.target instanceof Element ? e.target.getAttribute("data-delete") : null
  if (id) huntaway.call("delete", { id: Number(id) }).catch((err) => alert(err.message))
})
</script>`

export default definePlugin({
  id: "notes",
  name: "Notes",
  version: "0.1.0",
  description: "Notes agents keep for you, per profile and beside their task.",
  migrations: [
    {
      name: "0001-notes",
      run: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE notes (
          id INTEGER PRIMARY KEY,
          profile_id TEXT NOT NULL,
          task_id TEXT,
          task_key TEXT,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT`
        yield* sql`CREATE INDEX notes_profile ON notes(profile_id, id)`
      }),
    },
  ],
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const host = yield* PluginHost

    const notesOf = (profile: string, task: string | null = null) =>
      Effect.flatMap(
        task === null
          ? sql`SELECT * FROM notes WHERE profile_id = ${profile} ORDER BY id DESC`
          : sql`SELECT * FROM notes WHERE profile_id = ${profile} AND task_id = ${task} ORDER BY id DESC`,
        decodeNotes,
      ).pipe(Effect.orDie)

    const add = Effect.fn("notes.add")(function* (text: string, call: CallContext) {
      if (text.trim() === "") return yield* PluginError.invalid("a note needs some text")
      const now = DateTime.formatIso(yield* DateTime.now)
      const rows = yield* sql<{ readonly id: number }>`INSERT INTO notes (profile_id, task_id, task_key, text, created_at)
        VALUES (${call.profile.id}, ${call.task.id}, ${call.task.key}, ${text}, ${now}) RETURNING id`.pipe(Effect.orDie)
      const id = rows[0]?.id ?? 0
      yield* host.emit({ topic: "notes", profile_id: call.profile.id, data: { id }, reload: true })
      return { id, url: yield* host.pageUrl(call.profile.id) }
    })

    const page = (profile: string) =>
      Effect.gen(function* () {
        const p = yield* host.profile(profile)
        if (p === null) return yield* PluginError.notFound(`no profile ${profile}`)
        return Page.html(`${STYLE}<h1>Notes · ${escape(p.name)}</h1>${list(yield* notesOf(p.id), true)}${SCRIPT}`, { title: `Notes · ${p.name}` })
      })

    return {
      mcp: {
        instructions: (run) => Effect.succeed(`Notes kept here are shown to the user on the board, under the profile ${run.profile.name}.`),
        preApproved: true,
        tools: [
          pluginTool(AddNote, ({ text }, call) => add(text, call)),
          pluginTool(ListNotes, ({ mine }, call) => notesOf(call.profile.id, mine === true ? call.task.id : null)),
        ],
      },
      pages: {
        nav: { title: "Notes" },
        settings: { title: "Notes" },
        task: true,
        render: (request) =>
          Effect.gen(function* () {
            if (request.slot === "task") {
              const task = request.task_id === null ? null : yield* host.task(request.task_id)
              if (task === null) return Page.empty
              const notes = yield* notesOf(task.profile_id, task.id)
              return notes.length === 0 ? Page.empty : Page.html(`${STYLE}<h1>Notes</h1>${list(notes, false)}`)
            }
            if (request.slot === "settings") {
              const counts = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM notes`.pipe(Effect.orDie)
              return Page.html(`${STYLE}<p>This host keeps ${counts[0]?.n ?? 0} notes in the plugin's own database.</p>`)
            }
            // `/notes` is the first profile's; `/notes/<profile id>` another's.
            const profile = request.path.split("/").find(Boolean)
            if (profile !== undefined) return yield* page(profile)
            const first = (yield* host.profiles)[0]
            return first === undefined ? Page.html(`${STYLE}<p class="meta">No profiles.</p>`) : Page.redirect(first.id)
          }),
      },
      calls: {
        delete: pluginCall({
          scope: "operate",
          payload: Schema.Struct({ id: Schema.Int }),
          success: Schema.Struct({ deleted: Schema.Boolean }),
          handle: ({ id }) =>
            Effect.gen(function* () {
              const rows = yield* sql<{ readonly profile_id: string }>`DELETE FROM notes WHERE id = ${id} RETURNING profile_id`.pipe(Effect.orDie)
              const gone = rows[0]
              if (gone !== undefined) yield* host.emit({ topic: "notes", profile_id: gone.profile_id, reload: true })
              return { deleted: gone !== undefined }
            }),
        }),
      },
      routes: [
        {
          method: "GET",
          path: "/count",
          handle: () =>
            Effect.map(sql<{ readonly n: number }>`SELECT count(*) AS n FROM notes`.pipe(Effect.orDie), (rows) =>
              HttpServerResponse.jsonUnsafe({ notes: rows[0]?.n ?? 0 }),
            ),
        },
      ],
    }
  }),
})
