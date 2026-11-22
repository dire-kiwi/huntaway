// Copyright 2024 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0. Unless required by
// applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language
// governing permissions and limitations under the License.
//
// Ported to TypeScript for Huntaway (HE-77) from A2UI's Python agent SDK at commit 5ff1b05f:
// python/a2ui_agent/src/a2ui/transformers/macros/processor.py (`_coerce_value`, `_coerce_action` and the predicates
// they use), with the part of Pydantic's validation of the v1.0 models they rely on (unknown keys and explicit nulls
// refused). v1.0 only: bindings are `{"@path"}` and calls `{"@call"}`.
//
// One difference from Python: a parameter of a primitive type (`string`, `integer`, `number`, `boolean`, a literal)
// must get a value of that type. Python passes any primitive through and leaves the check to the builder models it
// is handed to; here `render`'s argument is typed, so the check is made before it is called.

import { AccessibilityAttributes, Action, ActionEvent, CheckRule, ComponentRef, DataBinding, DynamicChildList, FunctionCall } from "../builder/models.ts"
import type { AccessibilityLive, DynamicBoolean, DynamicString, DynamicValue } from "../builder/models.ts"
import { unionMembers } from "./params.ts"
import type { ParamType } from "./params.ts"
import { isSingleChildSlot, isTypeFrom } from "./schema.ts"

/** A JSON object. */
export type JsonObject = Readonly<Record<string, unknown>>

/** Whether `value` is a JSON object (not an array, not null). */
export const isJsonObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value)

/** The keys of `value` other than `allowed`, refused as Pydantic's `extra="forbid"` does. */
const refuseExtra = (value: JsonObject, allowed: ReadonlyArray<string>, model: string): void => {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k))
  if (extra.length > 0) throw new TypeError(`${model} does not accept ${extra.map((k) => `'${k}'`).join(", ")}.`)
}

/** The value under the first of `keys` that is present; an explicit null is refused, as the spec models do. */
const pick = (value: JsonObject, keys: ReadonlyArray<string>, model: string): unknown => {
  for (const key of keys) {
    if (key in value) {
      const v = value[key]
      if (v === null) throw new TypeError(`${model}.${key} must not be null.`)
      return v
    }
  }
  return undefined
}

const needString = (v: unknown, where: string): string => {
  if (typeof v !== "string") throw new TypeError(`${where} must be a string.`)
  return v
}

const optionalString = (v: unknown, where: string): string | undefined => (v === undefined ? undefined : needString(v, where))

/** `DataBinding.model_validate`: `{"@path": …}` (or `{"path": …}`). */
export const dataBindingFromWire = (value: JsonObject): DataBinding => {
  refuseExtra(value, ["@path", "path"], "DataBinding")
  return new DataBinding(needString(pick(value, ["@path", "path"], "DataBinding"), "DataBinding.path"))
}

/** `FunctionCall.model_validate`: `{"@call": …, "args"?: {…}, "catalogId"?: …}`. */
export const functionCallFromWire = (value: JsonObject): FunctionCall => {
  refuseExtra(value, ["@call", "call", "args", "catalogId", "catalog_id"], "FunctionCall")
  const call = needString(pick(value, ["@call", "call"], "FunctionCall"), "FunctionCall.call")
  const args = pick(value, ["args"], "FunctionCall")
  if (args !== undefined && !isJsonObject(args)) throw new TypeError("FunctionCall.args must be an object.")
  return new FunctionCall(call, args, { catalogId: optionalString(pick(value, ["catalogId", "catalog_id"], "FunctionCall"), "FunctionCall.catalogId") })
}

const isBindingShape = (value: JsonObject): boolean => {
  const keys = Object.keys(value)
  return keys.length === 1 && (keys[0] === "@path" || keys[0] === "path")
}

/** A binding or a call, as the `DataBinding | FunctionCall` fields validate one. */
const expressionFromWire = (value: unknown, where: string): DataBinding | FunctionCall => {
  if (!isJsonObject(value)) throw new TypeError(`${where} must be a data binding or a function call.`)
  return isBindingShape(value) ? dataBindingFromWire(value) : functionCallFromWire(value)
}

const dynamicStringFromWire = (value: unknown, where: string): DynamicString => (typeof value === "string" ? value : expressionFromWire(value, where))
const dynamicBooleanFromWire = (value: unknown, where: string): DynamicBoolean => (typeof value === "boolean" ? value : expressionFromWire(value, where))

/** A `DynamicValue`: a binding or a call; any other object is a literal one, which no `@` directive may start a key of. */
const dynamicValueFromWire = (value: unknown, where: string): DynamicValue => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return value
  if (!isJsonObject(value)) throw new TypeError(`${where} must be a dynamic value.`)
  if ("@path" in value) return dataBindingFromWire(value)
  if ("@call" in value) return functionCallFromWire(value)
  const directive = Object.keys(value).find((k) => k.startsWith("@") && !k.startsWith("@@"))
  if (directive !== undefined) throw new TypeError(`${where} cannot contain the reserved directive '${directive}'.`)
  return value
}

/** `ActionEvent.model_validate`: `{name, userMessage?, context?}`. */
export const actionEventFromWire = (value: JsonObject): ActionEvent => {
  refuseExtra(value, ["name", "userMessage", "user_message", "context"], "ActionEvent")
  const name = needString(pick(value, ["name"], "ActionEvent"), "ActionEvent.name")
  const userMessage = pick(value, ["userMessage", "user_message"], "ActionEvent")
  const context = pick(value, ["context"], "ActionEvent")
  if (context !== undefined && !isJsonObject(context)) throw new TypeError("ActionEvent.context must be an object.")
  return new ActionEvent(name, {
    userMessage: userMessage === undefined ? undefined : dynamicStringFromWire(userMessage, "ActionEvent.userMessage"),
    context:
      context === undefined ? undefined : Object.fromEntries(Object.entries(context).map(([k, v]) => [k, dynamicValueFromWire(v, `ActionEvent.context.${k}`)])),
  })
}

/** `Action.model_validate`: `{"event": {…}}` or `{"functionCall": {…}}`, exactly one. */
const actionModelFromWire = (value: JsonObject): Action => {
  refuseExtra(value, ["event", "functionCall", "function_call"], "Action")
  const event = pick(value, ["event"], "Action")
  const call = pick(value, ["functionCall", "function_call"], "Action")
  if ((event === undefined) === (call === undefined)) throw new TypeError("Action requires exactly one of 'event' or 'function_call'.")
  if (event !== undefined) {
    if (!isJsonObject(event)) throw new TypeError("Action.event must be an object.")
    return new Action({ event: actionEventFromWire(event) })
  }
  if (!isJsonObject(call)) throw new TypeError("Action.functionCall must be an object.")
  return new Action({ functionCall: functionCallFromWire(call) })
}

/**
 * An `Action` from the shapes inference output uses for one, which all mean the same: the wire form
 * `{"event": {"name": …}}`, the abbreviated `{"event": "name", "userMessage"?, "context"?}`, a bare event body
 * `{"name", "context"?, "userMessage"?}`, and a bare call `{"@call": …}`. Anything else (`{"functionCall": …}`) is
 * the wire form, validated as it is.
 */
export const actionFromWire = (value: JsonObject): Action => {
  const hasCall = "functionCall" in value || "function_call" in value
  const inner = value["event"]
  if (typeof inner === "string" && !hasCall) {
    const rest = Object.fromEntries(Object.entries(value).filter(([k]) => k !== "event"))
    return new Action({ event: actionEventFromWire({ ...rest, name: inner }) })
  }
  if (!("event" in value) && !hasCall) {
    if ("@call" in value) return new Action({ functionCall: functionCallFromWire(value) })
    return new Action({ event: actionEventFromWire(value) })
  }
  return actionModelFromWire(value)
}

/** `CheckRule.model_validate`: `{condition, message?}`. */
export const checkRuleFromWire = (value: JsonObject): CheckRule => {
  refuseExtra(value, ["condition", "message"], "CheckRule")
  const condition = pick(value, ["condition"], "CheckRule")
  if (condition === undefined) throw new TypeError("CheckRule requires a 'condition'.")
  return new CheckRule(expressionFromWire(condition, "CheckRule.condition"), optionalString(pick(value, ["message"], "CheckRule"), "CheckRule.message"))
}

const LIVE: ReadonlyArray<AccessibilityLive> = ["off", "polite", "assertive"]
const isLive = (v: unknown): v is AccessibilityLive => LIVE.some((l) => l === v)

/** `AccessibilityAttributes.model_validate`: `{label?, description?, live?, hidden?}`. */
export const accessibilityFromWire = (value: JsonObject): AccessibilityAttributes => {
  refuseExtra(value, ["label", "description", "live", "hidden"], "AccessibilityAttributes")
  const label = pick(value, ["label"], "AccessibilityAttributes")
  const description = pick(value, ["description"], "AccessibilityAttributes")
  const live = pick(value, ["live"], "AccessibilityAttributes")
  const hidden = pick(value, ["hidden"], "AccessibilityAttributes")
  if (live !== undefined && !isLive(live)) throw new TypeError("AccessibilityAttributes.live must be 'off', 'polite' or 'assertive'.")
  return new AccessibilityAttributes({
    label: label === undefined ? undefined : dynamicStringFromWire(label, "AccessibilityAttributes.label"),
    description: description === undefined ? undefined : dynamicStringFromWire(description, "AccessibilityAttributes.description"),
    live,
    hidden: hidden === undefined ? undefined : dynamicBooleanFromWire(hidden, "AccessibilityAttributes.hidden"),
  })
}

/** `DynamicChildList.model_validate`, its template id a `ComponentRef`. */
const dynamicChildListFromWire = (value: JsonObject): DynamicChildList => {
  refuseExtra(value, ["path", "data_model_path", "dataModelPath", "template", "componentId"], "DynamicChildList")
  const path = needString(pick(value, ["path", "data_model_path", "dataModelPath"], "DynamicChildList"), "DynamicChildList.path")
  const template = needString(pick(value, ["template", "componentId"], "DynamicChildList"), "DynamicChildList.componentId")
  return new DynamicChildList(path, new ComponentRef(template))
}

const isSequenceOf = (type: ParamType, test: (items: ParamType) => boolean): boolean => unionMembers(type).some((m) => m.kind === "array" && test(m.items))

/** `Sequence[Child]` (or a union with one). */
const isComponentSequence = (type: ParamType): boolean => isSequenceOf(type, isSingleChildSlot)
/** `Sequence[CheckRule]` (or a union with one). */
const isCheckRuleSequence = (type: ParamType): boolean => isSequenceOf(type, (items) => isTypeFrom(items, ["checkRule"]))

/** Takes only maps: `Extensions`, `dict`, `dict[str, V]`, or a union of them. */
const isDictOnly = (type: ParamType): boolean => {
  const members = unionMembers(type)
  return members.length > 0 && members.every((m) => m.kind === "extensions" || m.kind === "record" || m.kind === "literalObject")
}

/** Admits a map of any shape: `Any`, `Extensions`, `dict…`, or a union with one. */
const permitsArbitraryDict = (type: ParamType): boolean =>
  unionMembers(type).some((m) => m.kind === "any" || m.kind === "extensions" || m.kind === "record" || m.kind === "literalObject")

/** The element type of `Sequence[E]` (or of a union holding one). */
const sequenceElementType = (type: ParamType): ParamType | undefined => {
  for (const m of unionMembers(type)) if (m.kind === "array") return m.items
  return undefined
}

const ANY: ParamType = { kind: "any" }

/** The value type of `dict[str, V]` (or of a union holding one): `Any` for `dict` and `Extensions`. */
const dictValueType = (type: ParamType): ParamType | undefined => {
  const values: ParamType[] = []
  for (const m of unionMembers(type)) {
    if (m.kind === "extensions" || m.kind === "literalObject") return ANY
    if (m.kind === "record") {
      if (m.values === undefined || m.values.kind === "any") return ANY
      values.push(m.values)
    }
  }
  const [first] = values
  if (first === undefined) return undefined
  return values.length === 1 ? first : { kind: "union", members: values }
}

/** Coerces a sub-model: its fields by their types, then its own checks (unknown keys, required fields, defaults). */
const objectFromWire = (value: JsonObject, type: Extract<ParamType, { kind: "object" }>, where: string, macro: string): unknown => {
  const known = new Map(type.fields.map((f) => [f.name, f]))
  if (type.closed) refuseExtra(value, [...known.keys()], where)
  const out: Record<string, unknown> = {}
  for (const field of type.fields) {
    if (field.name in value) {
      const v = value[field.name]
      if (v === null) throw new TypeError(`${where}.${field.name} must not be null.`)
      out[field.name] = coerceValue(v, field.type, `${where}.${field.name}`, macro)
    } else if (field.required) throw new TypeError(`${where} requires '${field.name}'.`)
    else if (field.hasDefault) out[field.name] = field.default
  }
  return type.build === undefined ? out : type.build(out)
}

/** A primitive parameter's value must be of its type (see the header). */
const checkPrimitive = (value: unknown, type: ParamType, where: string, macro: string): void => {
  const fail = (expected: string): never => {
    throw new TypeError(
      `Parameter '${where}' of macro '${macro}' expects ${expected}, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}.`,
    )
  }
  if (type.kind === "string" && typeof value !== "string") fail("a string")
  if (type.kind === "integer" && !(typeof value === "number" && Number.isInteger(value))) fail("an integer")
  if (type.kind === "number" && typeof value !== "number") fail("a number")
  if (type.kind === "boolean" && typeof value !== "boolean") fail("a boolean")
  if (type.kind === "literal" && !type.values.some((v) => v === value)) fail(`one of ${JSON.stringify(type.values)}`)
}

/** Coerces a JSON wire argument to the builder value its parameter type declares (Python's `_coerce_value`). */
export function coerceValue(value: unknown, type: ParamType, where: string, macro: string): unknown {
  const isAny = type.kind === "any"

  // 1. A single child slot: a component id becomes a ComponentRef.
  if (typeof value === "string" && isSingleChildSlot(type)) return new ComponentRef(value)

  // 2. A list of child slots: ids become ComponentRefs.
  if (Array.isArray(value) && isComponentSequence(type)) return value.map((x: unknown) => (typeof x === "string" ? new ComponentRef(x) : x))

  if (isJsonObject(value)) {
    // 3. A template: {"path": "/…", "componentId": "…"}.
    const keys = Object.keys(value)
    if (
      !isDictOnly(type) &&
      ((isTypeFrom(type, ["dynamicChildList"]) && ("componentId" in value || "template" in value)) ||
        (isAny && keys.length === 2 && "path" in value && "componentId" in value && Object.values(value).every((v) => typeof v === "string" && v !== "")))
    ) {
      return dynamicChildListFromWire(value)
    }
    // 4. A data binding: {"@path": "/…"}.
    if (keys.length === 1 && typeof value["@path"] === "string" && (isTypeFrom(type, ["dataBinding"]) || isAny) && !isDictOnly(type)) {
      return new DataBinding(value["@path"])
    }
  }

  // 5. Action shorthands. Action itself has none; the ones a model naturally writes are mapped here.
  if (isTypeFrom(type, ["action"])) {
    if (typeof value === "string") return Action.event(value)
    if (isJsonObject(value)) return actionFromWire(value)
  }

  if (isJsonObject(value)) {
    // 6. A function call: {"@call": "…", …}.
    if ("@call" in value && (isTypeFrom(type, ["functionCall"]) || isAny) && !isDictOnly(type)) return functionCallFromWire(value)
    // 7. A check rule.
    if (isTypeFrom(type, ["checkRule"])) return checkRuleFromWire(value)
  }
  if (Array.isArray(value) && isCheckRuleSequence(type)) return value.map((x: unknown) => (isJsonObject(x) ? checkRuleFromWire(x) : x))

  if (isJsonObject(value)) {
    // 8. Accessibility attributes.
    if (isTypeFrom(type, ["accessibility"])) return accessibilityFromWire(value)
    // 9. Structured sub-models (TabItem, ChoicePickerOption, IconNameSvgPath, ActionEvent…): the first branch that takes it.
    const branches = unionMembers(type).filter((m): m is Extract<ParamType, { kind: "object" }> => m.kind === "object")
    let lastError: Error | undefined
    for (const branch of branches) {
      try {
        return objectFromWire(value, branch, where, macro)
      } catch (error) {
        lastError = error instanceof Error ? error : new TypeError(String(error))
      }
    }
    if (lastError !== undefined && !permitsArbitraryDict(type)) throw lastError
  }

  // 10. Typed sequences (Sequence[TabItem]…), item by item.
  if (Array.isArray(value)) {
    const element = sequenceElementType(type)
    if (element !== undefined && element.kind !== "any") return value.map((item: unknown, i) => coerceValue(item, element, `${where}[${i}]`, macro))
  }

  if (isJsonObject(value)) {
    // 11. Typed string-keyed maps (dict[str, Child], dict[str, DynamicString]…), value by value.
    const valueType = dictValueType(type)
    if (valueType !== undefined && valueType.kind !== "any") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, coerceValue(v, valueType, `${where}['${k}']`, macro)]))
    }
    if (!permitsArbitraryDict(type)) throw new TypeError(`Parameter '${where}' of macro '${macro}' expects ${type.kind}, got dict.`)
  }

  checkPrimitive(value, type, where, macro)
  return value
}
