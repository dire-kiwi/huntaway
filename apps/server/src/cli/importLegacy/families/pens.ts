import { Effect, Schema } from "effect"
import type { PenColor } from "@huntaway/contracts"
import { penColorOf } from "../../../tasks/penChecks.ts"

// `pens` → `pens` (docs/plan/11-migration.md, Table by table): as they are, `hidden` dropped. Two legacy forms
// (docs/plan/inventory/09-data-model.md, section 9, item 8): `hidden` is the mirror of `active` kept for a release
// from before migration 110, and where the two agree that release changed `hidden` alone, so `active` is `1 - hidden`
// (the old `open` repairs it so on every start); and `color` was '' before migration 108 and reads as blue.

const def = <S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(schema: S, value: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)))

/** An old `pens` row, as it is there. */
export const OldPen = Schema.Struct({
  id: Schema.String,
  profile_id: Schema.String,
  name: Schema.String,
  position: Schema.Finite,
  active: def(Schema.Finite, 1),
  hidden: def(Schema.Finite, 0),
  thread_id: def(Schema.NullOr(Schema.String), null),
  color: def(Schema.String, ""),
  created_at: Schema.String,
  updated_at: Schema.String,
})
export type OldPen = typeof OldPen.Type

/** A `pens` row of the new board. */
export type NewPen = {
  readonly id: string
  readonly profile_id: string
  readonly name: string
  readonly position: number
  readonly active: 0 | 1
  readonly color: PenColor
  readonly thread_id: string | null
  readonly created_at: string
  readonly updated_at: string
}

/** An old pen as the new board keeps it. */
export const convertPen = (old: OldPen): NewPen => {
  const active = old.active !== 0
  const hidden = old.hidden !== 0
  return {
    id: old.id,
    profile_id: old.profile_id,
    name: old.name,
    position: old.position,
    active: active === hidden ? (hidden ? 0 : 1) : active ? 1 : 0,
    color: penColorOf(old.color),
    thread_id: old.thread_id,
    created_at: old.created_at,
    updated_at: old.updated_at,
  }
}
