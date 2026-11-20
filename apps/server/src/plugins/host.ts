import { Effect, Option, Redacted, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { ProfileId, ProjectId, TaskId } from "@huntaway/contracts"
import type { Profile, Project, Task } from "@huntaway/contracts"
import { PluginError } from "@huntaway/plugin"
import type { PluginHostShape, PluginProfile, PluginProject, PluginTask } from "@huntaway/plugin"
import { Events } from "../platform/Events.ts"
import { Identity } from "../platform/Identity.ts"
import { Listening } from "../platform/Listening.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { Runs } from "../runs/Runs.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { TaskRefs } from "../tasks/TaskRefs.ts"

// HE-34: the board's services as a plugin sees them (`PluginHost`, docs/plan/15-plugins.md, The board's services):
// plain values in, plain values out, its failures as `PluginError`s. One per plugin, made by `Plugins` as it starts it.

export const asProfile = (p: Profile): PluginProfile => ({ id: p.id, name: p.name })
export const asProject = (p: Project): PluginProject => ({ id: p.id, key: p.key, name: p.name, profile_id: p.profile_id, repo_path: p.repo_path })
export const asTask = (t: Task): PluginTask => ({
  id: t.id,
  key: t.key,
  title: t.title,
  kind: t.kind,
  status: t.status,
  profile_id: t.profile_id,
  project_id: t.project_id,
})

/** The table a plugin's secrets are kept in, in its own database (the board's, not the plugin's: it isn't migrated by it). */
export const SECRETS_TABLE = "huntaway_secrets"

const SecretRow = Schema.Struct({ value: Schema.String })
const decodeSecrets = Schema.decodeUnknownEffect(Schema.Array(SecretRow))

/** The board's address for links: its Public URL setting, else its own on this machine; no trailing `/`. */
export const boardUrlOf = (publicUrl: string | null | undefined, port: number): string => {
  const set = publicUrl?.trim() ?? ""
  return (set === "" ? `http://127.0.0.1:${port}` : set).replace(/\/+$/, "")
}

/** A secret's profile key: '' for the plugin's own. */
const key = (profile: string | null) => profile ?? ""

/** What makes each plugin's `PluginHost`: the board's services, taken once. */
export const makeHosts = Effect.gen(function* () {
  const identity = yield* Identity
  const listening = yield* Listening
  const settings = yield* HostSettings
  const profiles = yield* ProfileRepo
  const projects = yield* ProjectRepo
  const refs = yield* TaskRefs
  const runs = yield* Runs
  const events = yield* Events

  // The bound port, not `--port`: a test server's `--port 0` would make every link (an upload URL, HE-63) `:0`.
  const boardUrl = Effect.zipWith(settings.get, listening.port, (s, port) => boardUrlOf(s.public_url, port))

  return (plugin: string, filesDir: string, sql: SqlClient.SqlClient): PluginHostShape => {
    return {
      plugin,
      hostId: identity.hostId,
      hostName: identity.hostName,
      filesDir,
      boardUrl,
      pageUrl: (path) => Effect.map(boardUrl, (url) => `${url}/${plugin}/${path.replace(/^\/+/, "")}`),
      profiles: Effect.map(profiles.list, (all) => all.map(asProfile)),
      profile: (id) => Effect.map(profiles.get(ProfileId.make(id)), (p) => Option.getOrNull(Option.map(p, asProfile))),
      task: (ref) =>
        refs
          .resolve(ref)
          .pipe(Effect.map(asTask), Effect.catchTags({ TaskNotFound: () => Effect.succeed(null), TaskRefAmbiguous: () => Effect.succeed(null) })),
      project: (id) => Effect.map(projects.get(ProjectId.make(id)), (p) => Option.getOrNull(Option.map(p, asProject))),
      sendToTask: (task, text) =>
        runs.send(TaskId.make(task), { text, source: "board" }).pipe(
          Effect.asVoid,
          Effect.catchTags({
            TaskNotFound: () => Effect.fail(PluginError.notFound(`task ${task} is gone`)),
            SendRefused: (e) => Effect.fail(e.reason === "no_agents" ? PluginError.unavailable(e.detail) : PluginError.conflict(e.detail)),
          }),
        ),
      emit: (event) =>
        events.emit({
          type: "plugin",
          plugin,
          topic: event.topic,
          profile_id: event.profile_id === undefined || event.profile_id === null ? null : ProfileId.make(event.profile_id),
          data: event.data ?? null,
          reload: event.reload === true,
        }),
      secrets: {
        get: (profile, name) =>
          sql`SELECT value FROM ${sql(SECRETS_TABLE)} WHERE profile_id = ${key(profile)} AND name = ${name}`.pipe(
            Effect.flatMap(decodeSecrets),
            Effect.orDie,
            Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), (r) => Redacted.make(r.value, { label: `${plugin}:${name}` }))),
          ),
        set: (profile, name, value) =>
          sql`INSERT INTO ${sql(SECRETS_TABLE)} (profile_id, name, value) VALUES (${key(profile)}, ${name}, ${Redacted.isRedacted(value) ? Redacted.value(value) : value})
            ON CONFLICT (profile_id, name) DO UPDATE SET value = excluded.value`.pipe(Effect.orDie, Effect.asVoid),
        remove: (profile, name) =>
          sql`DELETE FROM ${sql(SECRETS_TABLE)} WHERE profile_id = ${key(profile)} AND name = ${name}`.pipe(Effect.orDie, Effect.asVoid),
      },
    }
  }
})
