import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { NotFound } from "../errors.ts"
import { TaskId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"
import { DocumentLabel } from "../task.ts"
import { Timestamp } from "../time.ts"
// 6.7: the assistant's morning brief, with its items.
import { BriefItem } from "../assistant.ts"

// A task's documents (docs/plan/06-server.md, Documents and docs; inventory 02, section 2.7; the old
// `GET /tasks/{id}/document?label=&version=`): the plan, artifact or diagram its agent writes in the task's own folder,
// a version for each turn that changed it. The board says when one changed with the task's `document_at`.

/** A version of a task's document. `open`: still being written in the agent's current turn. */
export const DocumentVersion = Schema.Struct({
  version: Schema.Int,
  open: Schema.Boolean,
  created_at: Timestamp,
  updated_at: Timestamp,
  /** Its length, in characters. */
  size: Schema.Int,
})
export type DocumentVersion = typeof DocumentVersion.Type

/** A task's labels' documents, and the assistant's morning brief (`brief`, 6.7). */
export const TaskDocumentLabel = Schema.Literals([...DocumentLabel.literals, "brief"])
export type TaskDocumentLabel = typeof TaskDocumentLabel.Type

/** A version of a task's document for a label, and the list of its versions (oldest first). */
export const TaskDocument = Schema.Struct({
  label: TaskDocumentLabel,
  /** Where its agent writes it, or null. */
  file: Schema.NullOr(Schema.String),
  versions: Schema.Array(DocumentVersion),
  /** The version given (null when there is none yet). */
  version: Schema.NullOr(Schema.Int),
  content: Schema.NullOr(Schema.String),
  /** 6.7: the brief's items to rate (those its run wrote the same day as the version shown); only the brief's. */
  items: Schema.optionalKey(Schema.Array(BriefItem)),
})
export type TaskDocument = typeof TaskDocument.Type

export class TaskDocumentRpcs extends RpcGroup.make(
  /**
   * A version of the task's document for `label` (its first label's unless given; the latest version unless given).
   * `NotFound` for a task or a version that isn't there.
   */
  Rpc.make("tasks.document", {
    payload: { id: TaskId, label: Schema.optional(TaskDocumentLabel), version: Schema.optional(Schema.Int) },
    success: TaskDocument,
    error: NotFound,
  }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
