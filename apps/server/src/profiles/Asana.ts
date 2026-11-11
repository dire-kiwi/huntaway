import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { AsanaTask } from "@huntaway/contracts"
import { ServerConfig } from "../platform/ServerConfig.ts"

// 6.11: Asana, for linking a task to the Asana task it's for (the old `integrations/asana.ts`). A profile connects with
// a personal access token (`profiles.update`'s `asana_token`, checked here with `me`); the link dialog finds tasks with
// Asana's typeahead search across the user's workspaces, or by a pasted task URL. The link itself is the task's
// `external_links`. Asana's address is `ServerConfig.asanaUrl`, so tests and test servers talk to a fake.

/** How many tasks a search finds at most in each workspace (Asana's typeahead takes up to 100). */
const SEARCH_RESULTS = 25

const TASK_FIELDS = "name,completed,permalink_url,notes,assignee.name,projects.name,workspace.name"

/** Why a call to Asana failed, in words for the user. `Unauthorized`: Asana turned the token down. */
export class AsanaFailed extends Schema.TaggedError<AsanaFailed, { readonly brand: unique symbol }>()("AsanaFailed", {
  kind: Schema.Literals(["Unauthorized", "NotFound", "Other"]),
  message: Schema.String,
}) {}

const failed = (kind: "Unauthorized" | "NotFound" | "Other", other = "") =>
  new AsanaFailed({
    kind,
    message:
      kind === "Unauthorized"
        ? "Asana didn't accept the token; check it in Asana's developer console, or connect again"
        : kind === "NotFound"
          ? "Asana has no such task, or the token can't see it"
          : `Asana: ${other}`,
  })

/** Asana is off for the profile, or it isn't connected. */
export class AsanaOff extends Schema.TaggedError<AsanaOff, { readonly brand: unique symbol }>()("AsanaOff", { reason: Schema.String }) {}

/** The Asana user a token belongs to. */
export interface AsanaUser {
  readonly name: string
  readonly email: string | null
  /** Workspace gids. */
  readonly workspaces: ReadonlyArray<string>
}

/** How the profile shows who it's connected as. */
export const asanaLabel = (u: AsanaUser): string => (u.email !== null && u.email !== "" && u.email !== u.name ? `${u.name} (${u.email})` : u.name)

// What Asana answers, read leniently: a field of the wrong kind is as good as missing.
const Text = Schema.optional(Schema.NullOr(Schema.Unknown))
const ApiTask = Schema.Struct({
  gid: Schema.String,
  name: Text,
  completed: Text,
  permalink_url: Text,
  notes: Text,
  assignee: Text,
  projects: Text,
  workspace: Text,
})
const ApiUser = Schema.Struct({ name: Text, email: Text, workspaces: Text })
const Envelope = Schema.Struct({ data: Schema.optional(Schema.Unknown), errors: Schema.optional(Schema.Unknown) })

const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const nameOf = (v: unknown): string | null => (typeof v === "object" && v !== null && "name" in v ? str(v.name) : null)
const gidOf = (v: unknown): string | null => (typeof v === "object" && v !== null && "gid" in v ? str(v.gid) : null)

/** An Asana task from what the API answered, or null for one without a gid. */
export const asanaTask = (v: unknown): AsanaTask | null =>
  Option.match(Schema.decodeUnknownOption(ApiTask)(v), {
    onNone: () => null,
    onSome: (t) => ({
      gid: t.gid,
      name: str(t.name) ?? "",
      url: str(t.permalink_url) ?? `https://app.asana.com/0/0/${t.gid}`,
      completed: typeof t.completed === "boolean" ? t.completed : false,
      notes: str(t.notes) ?? "",
      assignee: nameOf(t.assignee),
      projects: Array.isArray(t.projects) ? t.projects.map(nameOf).filter((n): n is string => n !== null) : [],
      workspace: nameOf(t.workspace),
    }),
  })

/** `s` if it's a gid (digits). */
const asGid = (s: string | undefined) => (s !== undefined && /^[0-9]+$/.test(s) ? s : null)

/**
 * The task an Asana task URL (or a bare gid of 10 digits or more) names: `https://app.asana.com/0/<project>/<task>`
 * (`/f` after it, or `/0/<project>/<task>/<subtask>`), or the newer
 * `https://app.asana.com/1/<workspace>/project/<project>/task/<task>`.
 */
export const taskGid = (q: string): string | null => {
  if (new TextEncoder().encode(q).length >= 10) {
    const g = asGid(q)
    if (g !== null) return g
  }
  const rest = q.startsWith("https://") ? q.slice(8) : q.startsWith("http://") ? q.slice(7) : null
  if (rest === null || !rest.startsWith("app.asana.com/")) return null
  const parts = (rest.slice("app.asana.com/".length).split(/[?#]/)[0] ?? "").split("/").filter((p) => p !== "")
  const i = parts.lastIndexOf("task")
  if (i >= 0) return asGid(parts[i + 1])
  if (parts.length >= 2 && parts[0] === "0") {
    for (const p of parts.slice(2).toReversed()) {
      const g = asGid(p)
      if (g !== null) return g
    }
  }
  return null
}

export interface AsanaShape {
  /** Who a token belongs to, which also checks it. */
  readonly me: (token: string) => Effect.Effect<AsanaUser, AsanaFailed>
  readonly task: (token: string, gid: string) => Effect.Effect<AsanaTask, AsanaFailed>
  /**
   * The tasks a search finds: the task a pasted URL (or gid) names, or else those whose names match `q` in each of the
   * user's workspaces (with `q` empty, those Asana ranks first), open ones first.
   */
  readonly search: (token: string, q: string) => Effect.Effect<ReadonlyArray<AsanaTask>, AsanaFailed>
}

/** Asana's API, as the profile's token. */
export class Asana extends Context.Service<Asana, AsanaShape>()("huntaway-server/profiles/Asana") {
  static readonly layer = Layer.effect(
    Asana,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const config = yield* ServerConfig

      /** Asana's `data` for a GET of `path`, or why there's none. */
      const get = (token: string, path: string, query: ReadonlyArray<readonly [string, string]>) =>
        Effect.gen(function* () {
          if (!URL.canParse(`${config.asanaUrl}${path}`)) return yield* failed("Other", `bad URL ${config.asanaUrl}${path}`)
          const url = new URL(`${config.asanaUrl}${path}`)
          for (const [k, v] of query) url.searchParams.append(k, v)
          const res = yield* client.execute(HttpClientRequest.get(url.toString(), { headers: { authorization: `Bearer ${token}` } })).pipe(
            Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.fail(failed("Other", "Asana took more than 15 seconds")) }),
            Effect.mapError((e) => (Schema.is(AsanaFailed)(e) ? e : failed("Other", e.message))),
          )
          const body = yield* res.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Envelope)),
            Effect.orElseSucceed(() => ({ data: undefined, errors: undefined })),
          )
          if (res.status >= 200 && res.status <= 299) return body.data ?? null
          if (res.status === 401) return yield* failed("Unauthorized")
          if (res.status === 403 || res.status === 404) return yield* failed("NotFound")
          const first: unknown = Array.isArray(body.errors) ? body.errors[0] : undefined
          const message = typeof first === "object" && first !== null && "message" in first ? str(first.message) : null
          return yield* failed("Other", message ?? `HTTP ${res.status}`)
        }).pipe(Effect.scoped)

      const me = Effect.fn("Asana.me")(function* (token: string) {
        const v = Option.getOrNull(Schema.decodeUnknownOption(ApiUser)(yield* get(token, "/users/me", [["opt_fields", "name,email,workspaces"]])))
        return {
          name: str(v?.name) ?? "",
          email: str(v?.email),
          workspaces: Array.isArray(v?.workspaces) ? v.workspaces.map(gidOf).filter((g): g is string => g !== null) : [],
        }
      })

      const task = Effect.fn("Asana.task")(function* (token: string, gid: string) {
        const t = asanaTask(yield* get(token, `/tasks/${gid}`, [["opt_fields", TASK_FIELDS]]))
        if (t === null) return yield* failed("NotFound")
        return t
      })

      const search = Effect.fn("Asana.search")(function* (token: string, given: string) {
        const q = given.trim()
        const gid = taskGid(q)
        if (gid !== null) return [yield* task(token, gid)]
        const user = yield* me(token)
        const found = yield* Effect.forEach(
          user.workspaces,
          (w) =>
            get(token, `/workspaces/${w}/typeahead`, [
              ["resource_type", "task"],
              ["query", q],
              ["count", String(SEARCH_RESULTS)],
              ["opt_fields", TASK_FIELDS],
            ]),
          { concurrency: 4 },
        )
        const tasks = found.flatMap((list) => (Array.isArray(list) ? list.map(asanaTask).filter((t): t is AsanaTask => t !== null) : []))
        // Stable, so each workspace's keep Asana's order.
        return tasks.toSorted((a, b) => Number(a.completed) - Number(b.completed))
      })

      return Asana.of({ me, task, search })
    }),
  )
}
