import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { BriefFeedback, BriefRating, GoogleStatus, MemoryDiff, MemoryFileContent, MemoryHistory, MemoryOverview, MemoryWrite } from "../assistant.ts"
import { Automation, Weekday } from "../automation.ts"
import { Conflict, Invalid, NotFound, Unavailable } from "../errors.ts"
import { HostId, ProfileId, TaskId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"
import { Task } from "../task.ts"

// The profile's assistant (the old `/profiles/{id}/assistant…` routes, 71–80, and `/tasks/{id}/tracked/remove`):
// docs/plan/05-protocol.md's `assistant` group. Every method makes the assistant the first time it's needed. `Conflict`
// (`in_use`) for a profile whose assistant runs on another host (its memory is there), `Unavailable` for a workspace that
// isn't its own (a symlink in its place). A change of a file is committed to the workspace's history.
//
// A profile's assistant can run on a linked host of its own (`assistant_host`, 7.4): `get` and `send` on the hub are
// sent there, to its profile of the same name (`Unavailable` while it is offline or a build behind, `Conflict`
// `no_profile` when it has none), and answer with that host's task and its `host_id`. `here` asks a host for its own
// assistant, whatever its profile says (the old `?local=1`): what the hub asks of the assistant's host, and what a
// board asks of the host it found the assistant on (`assistantHome` in @huntaway/client).

const profile = { profile_id: ProfileId }
const here = { here: Schema.optionalKey(Schema.Boolean) }

/** The profile's assistant, with the host it's on. */
export const AssistantTask = Schema.Struct({ ...Task.fields, host_id: HostId })
export interface AssistantTask extends Schema.Schema.Type<typeof AssistantTask> {}
const Errors = Schema.Union([NotFound, Invalid, Conflict, Unavailable])

export class AssistantRpcs extends RpcGroup.make(
  /** The profile's assistant, made the first time it's asked for. */
  Rpc.make("assistant.get", { payload: { ...profile, ...here }, success: AssistantTask, error: Errors }).annotate(RequiredScope, "read"),
  /** Sends the user's message to the assistant (starting its agent or steering it), settling its pending questions. */
  Rpc.make("assistant.send", { payload: { ...profile, ...here, text: Schema.String }, success: AssistantTask, error: Errors }).annotate(
    RequiredScope,
    "operate",
  ),
  /** Its workspace's files, and how much of each a run is told. */
  Rpc.make("assistant.memory", { payload: profile, success: MemoryOverview, error: Errors }).annotate(RequiredScope, "read"),
  /** A file in its workspace, now or as it was in commit `rev`. */
  Rpc.make("assistant.memoryFile", {
    payload: { ...profile, path: Schema.String, rev: Schema.optionalKey(Schema.NullOr(Schema.String)) },
    success: MemoryFileContent,
    error: Errors,
  }).annotate(RequiredScope, "read"),
  /**
   * Writes a file (making it and its folders), committed as the user's. `expected`: what the editor opened (null or left
   * out for a file that wasn't there), so a save over what the assistant wrote meanwhile is `Conflict`
   * (`changed_meanwhile`); `force` writes it anyway.
   */
  Rpc.make("assistant.writeMemoryFile", {
    payload: {
      ...profile,
      path: Schema.String,
      content: Schema.String,
      expected: Schema.optionalKey(Schema.NullOr(Schema.String)),
      force: Schema.optionalKey(Schema.Boolean),
    },
    success: MemoryWrite,
    error: Errors,
  }).annotate(RequiredScope, "operate"),
  /** The workspace's commits (or a file's), newest first, the last 200. */
  Rpc.make("assistant.memoryHistory", {
    payload: { ...profile, path: Schema.optionalKey(Schema.NullOr(Schema.String)) },
    success: MemoryHistory,
    error: Errors,
  }).annotate(RequiredScope, "read"),
  /** What a commit changed (in one file). */
  Rpc.make("assistant.memoryDiff", {
    payload: { ...profile, rev: Schema.String, path: Schema.optionalKey(Schema.NullOr(Schema.String)) },
    success: MemoryDiff,
    error: Errors,
  }).annotate(RequiredScope, "read"),
  /** Puts a file back as it was in a commit, committed as the user's (what it says now is committed first). */
  Rpc.make("assistant.restoreMemory", { payload: { ...profile, path: Schema.String, rev: Schema.String }, success: MemoryWrite, error: Errors }).annotate(
    RequiredScope,
    "operate",
  ),
  /** Sends another assistant's answer to the import prompt to the assistant, as data, to fold into its memory. */
  Rpc.make("assistant.importMemory", { payload: { ...profile, text: Schema.String }, success: Task, error: Errors }).annotate(RequiredScope, "operate"),
  /** Whether Google is connected for the assistant here; `check` also tries the account's refresh token with Google. */
  Rpc.make("assistant.google", { payload: { ...profile, check: Schema.optionalKey(Schema.Boolean) }, success: GoogleStatus, error: Errors }).annotate(
    RequiredScope,
    "read",
  ),
  /** Adds the host's Google server (unless it has one called `google`) and switches it on for the profile. */
  Rpc.make("assistant.setupGoogle", { payload: profile, success: GoogleStatus, error: Errors }).annotate(RequiredScope, "settings"),
  /** Adds the morning brief routine, on `weekdays` (Monday to Friday) at `time` (`HH:MM`, 07:30) in the host's time zone. */
  Rpc.make("assistant.addBrief", {
    payload: { ...profile, time: Schema.optionalKey(Schema.NullOr(Schema.String)), weekdays: Schema.optionalKey(Schema.NullOr(Schema.Array(Weekday))) },
    success: Automation,
    error: Errors,
  }).annotate(RequiredScope, "settings"),
  /**
   * Rates one of the brief's items (`kind`, and its `topic`, else its `text`): it becomes (or changes, or with `clear`
   * drops) a line under "Morning brief preferences" in MEMORY.md, committed as the user's.
   */
  Rpc.make("assistant.briefFeedback", {
    payload: {
      ...profile,
      rating: BriefRating,
      kind: Schema.optionalKey(Schema.NullOr(Schema.String)),
      topic: Schema.optionalKey(Schema.NullOr(Schema.String)),
      text: Schema.optionalKey(Schema.NullOr(Schema.String)),
    },
    success: BriefFeedback,
    error: Errors,
  }).annotate(RequiredScope, "operate"),
  /** Takes items off an assistant's tracked work list, as its details do. `Invalid` for a task that isn't an assistant. */
  Rpc.make("tasks.removeTracked", {
    payload: { id: TaskId, ids: Schema.Array(Schema.String) },
    success: Task,
    error: Schema.Union([NotFound, Invalid]),
  }).annotate(RequiredScope, "operate"),
).middleware(Auth) {}
