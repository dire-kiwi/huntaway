import { Schema } from "effect"
import { PenId, ProfileId, TaskId } from "./ids.ts"
import { Timestamp } from "./time.ts"

// A pen (huntaway's apps/server/src/wire/pens.ts): a profile's named set of tasks from any of its projects, which its
// board shows as a tab. Without `hidden` (the opposite of `active`, for boards from before it).

/** The colours a pen can have, in the order new pens get them. */
export const PenColor = Schema.Literals(["blue", "orange", "green", "pink", "violet", "teal", "amber", "red", "lime", "indigo"])
export type PenColor = typeof PenColor.Type

export const Pen = Schema.Struct({
  id: PenId,
  profile_id: ProfileId,
  name: Schema.String,
  /** Where its tab goes among the profile's pens, lowest first. */
  position: Schema.Finite,
  /** Shown as a tab; an inactive pen keeps its tasks. */
  active: Schema.Boolean,
  /** Its own thread, once it has been opened. */
  thread_id: Schema.NullOr(TaskId),
  color: PenColor,
  created_at: Timestamp,
  updated_at: Timestamp,
  /** How many tasks are in it (worked out). */
  task_count: Schema.Int,
})
export interface Pen extends Schema.Schema.Type<typeof Pen> {}

/** What `pens.create` takes (the old `POST /profiles/{id}/pens`): a new pen at the end of the tabs. */
export const NewPen = Schema.Struct({
  profile_id: ProfileId,
  /** Unique in the profile. */
  name: Schema.String,
  /** Default true. */
  active: Schema.optional(Schema.Boolean),
  /** Unset: one the profile's other pens do not have. */
  color: Schema.optional(Schema.NullOr(PenColor)),
})
export interface NewPen extends Schema.Schema.Type<typeof NewPen> {}

/** What `pens.update` takes (the old `PATCH /pens/{id}`): each field optional. */
export const PenPatch = Schema.Struct({
  name: Schema.optional(Schema.String),
  active: Schema.optional(Schema.Boolean),
  color: Schema.optional(PenColor),
  /** Its tab's place among the profile's pens, from 0. */
  index: Schema.optional(Schema.Int),
})
export interface PenPatch extends Schema.Schema.Type<typeof PenPatch> {}
