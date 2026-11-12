import { Predicate } from "effect"

// What an agent or the board wrote as JSON (a tool call's input, a request's metadata): `Schema.Unknown` on the wire by
// design, so the rows read the fields they show through these guards, and anything else reads as nothing.

/** A JSON object's fields. */
export type Fields = { readonly [key: string]: unknown }

/** `x`'s fields if it's an object (not an array), else none. */
export const fieldsOf = (x: unknown): Fields => (Predicate.isReadonlyObject(x) ? x : {})

/** `x` if it's a list, else an empty one. */
export const listOf = (x: unknown): ReadonlyArray<unknown> => (Array.isArray(x) ? x : [])

/** `x` if it's a string. */
export const stringOf = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined)

/** `x` as text, if it's a string, a number or a boolean; else empty. */
export const shown = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" || typeof x === "boolean" ? String(x) : "")

/** `x` as a number, if it's one or a string of one. */
export function numberOf(x: unknown): number | undefined {
  if (typeof x === "number") return Number.isFinite(x) ? x : undefined
  if (typeof x !== "string" || x.trim() === "") return undefined
  const n = Number(x)
  return Number.isFinite(n) ? n : undefined
}
