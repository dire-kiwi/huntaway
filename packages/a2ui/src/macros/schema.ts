// Copyright 2024 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0. Unless required by
// applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language
// governing permissions and limitations under the License.
//
// Ported to TypeScript for Huntaway (HE-77) from A2UI's Python agent SDK at commit 5ff1b05f:
// python/a2ui_agent/src/a2ui/transformers/macros/macro.py (`_map_type_hint_to_schema` and the slot predicates it and
// processor.py share). A parameter type's JSON Schema, as Python synthesizes it from an annotation (v1.0 only: a single
// child is `Child`, never v0.9's `ComponentId`).

import { unionMembers } from "./params.ts"
import type { ParamType } from "./params.ts"

/** Where the common types are referenced from in a synthesized schema. */
export const DEFAULT_COMMON_REF_PREFIX = "common_types.json#/$defs/"

type Kind = ParamType["kind"]

/** Whether `type` or one of its union members is of one of `kinds` (Python's `_is_type_from`). */
export const isTypeFrom = (type: ParamType, kinds: ReadonlyArray<Kind>): boolean => unionMembers(type).some((m) => kinds.includes(m.kind))

/** A single child slot: `Child`, or a union of them. */
export const isSingleChildSlot = (type: ParamType): boolean => {
  if (type.kind === "child") return true
  if (type.kind !== "union") return false
  const members = unionMembers(type)
  return members.length > 0 && members.every(isSingleChildSlot)
}

/** A child list slot: `Sequence[Child]`, `DynamicChildList` or `ChildList` (or a union with one). */
export const isChildListSlot = (type: ParamType): boolean => {
  if (type.kind === "dynamicChildList") return true
  if (type.kind === "array") return isSingleChildSlot(type.items)
  if (type.kind !== "union" && type.kind !== "childList") return false
  const members = unionMembers(type)
  return members.length > 0 && members.every((m) => isChildListSlot(m) || isSingleChildSlot(m)) && members.some(isChildListSlot)
}

const isExpr = (type: ParamType): boolean => type.kind === "dataBinding" || type.kind === "functionCall"
const PRIMITIVE: ReadonlyArray<Kind> = ["string", "integer", "number", "boolean"]

const DYNAMIC_REFS: Partial<Record<Kind, string>> = {
  dynamicValue: "DynamicValue",
  dynamicStringList: "DynamicStringList",
  dynamicString: "DynamicString",
  dynamicNumber: "DynamicNumber",
  dynamicBoolean: "DynamicBoolean",
}

const DIRECT_REFS: Partial<Record<Kind, string>> = {
  dataBinding: "DataBinding",
  action: "Action",
  checkRule: "CheckRule",
  accessibility: "AccessibilityAttributes",
  functionCall: "FunctionCall",
  extensions: "Extensions",
}

const PRIMITIVE_TYPES: Partial<Record<Kind, string>> = { string: "string", integer: "integer", number: "number", boolean: "boolean" }

/** The JSON Schema of a parameter of type `type`, with `description` when there is one. */
export function typeSchema(type: ParamType, description?: string, refPrefix: string = DEFAULT_COMMON_REF_PREFIX): Record<string, unknown> {
  const described = (schema: Record<string, unknown>): Record<string, unknown> => (description ? { ...schema, description } : schema)
  const ref = (name: string): Record<string, unknown> => described({ $ref: `${refPrefix}${name}` })

  const dynamic = DYNAMIC_REFS[type.kind]
  if (dynamic !== undefined) return ref(dynamic)

  if (type.kind === "union" || type.kind === "childList") {
    const members = unionMembers(type)
    if (members.length === 1 && members[0] !== undefined) return typeSchema(members[0], description, refPrefix)
    const exprs = members.filter(isExpr)
    const values = members.filter((m) => !isExpr(m))
    const valueKinds = new Set(values.map((m) => m.kind))
    const only = (kinds: ReadonlyArray<Kind>): boolean => values.every((m) => kinds.includes(m.kind))
    const childList = (ms: ReadonlyArray<ParamType>): boolean => ms.every((m) => isChildListSlot(m) || isSingleChildSlot(m)) && ms.some(isChildListSlot)
    if (exprs.length > 0 && values.length > 0) {
      if (only(["string"])) return ref("DynamicString")
      if (only(["integer", "number"])) return ref("DynamicNumber")
      if (only(["boolean"])) return ref("DynamicBoolean")
      if (PRIMITIVE.every((k) => valueKinds.has(k))) return ref("DynamicValue")
      if (childList(values)) return ref("ChildList")
      const [single] = values
      if (values.length === 1 && single?.kind === "array" && single.items.kind === "string") return ref("DynamicStringList")
      if (values.every(isSingleChildSlot)) return ref("Child")
    }
    if (childList(members)) return ref("ChildList")
    if (members.every(isSingleChildSlot)) return ref("Child")
    return described({ oneOf: members.map((m) => typeSchema(m, undefined, refPrefix)) })
  }

  if (type.kind === "literal") {
    const values = type.values
    if (values.every((v) => typeof v === "string")) return described({ type: "string", enum: [...values] })
    if (values.every((v) => typeof v === "number")) return described({ type: "number", enum: [...values] })
    return described({ enum: [...values] })
  }

  const direct = DIRECT_REFS[type.kind]
  if (direct !== undefined) return ref(direct)
  if (isChildListSlot(type)) return ref("ChildList")
  if (isSingleChildSlot(type)) return ref("Child")

  if (type.kind === "object") {
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const field of type.fields) {
      properties[field.name] = typeSchema(field.type, field.description, refPrefix)
      if (field.required) required.push(field.name)
    }
    const schema: Record<string, unknown> = { type: "object", properties }
    if (required.length > 0) schema["required"] = required
    if (type.closed) schema["additionalProperties"] = false
    return described(schema)
  }

  const primitive = PRIMITIVE_TYPES[type.kind]
  if (primitive !== undefined) return described({ type: primitive })

  if (type.kind === "array") return described({ type: "array", items: typeSchema(type.items, undefined, refPrefix) })
  if (type.kind === "any") return described({})
  if (type.kind === "record" || type.kind === "literalObject") {
    const values = type.kind === "record" ? type.values : undefined
    return described(
      values === undefined || values.kind === "any" ? { type: "object" } : { type: "object", additionalProperties: typeSchema(values, undefined, refPrefix) },
    )
  }
  return described({ type: "string" })
}
