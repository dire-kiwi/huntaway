// Copyright 2024 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0. Unless required by
// applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language
// governing permissions and limitations under the License.
//
// Ported to TypeScript for Huntaway (HE-77) from A2UI's Python agent SDK at commit 5ff1b05f:
// python/a2ui_agent/src/a2ui/transformers/macros/macro.py (the type annotations `@macro` reads). TypeScript has no
// runtime annotations, so a macro declares its parameters with these descriptors, one for each row of the README's
// type table; each carries the TypeScript type of the value `render` gets. schema.ts maps them to JSON Schema and
// coerce.ts coerces wire arguments to them, as Python does for the annotations.

import { ActionEvent, DataBinding, FunctionCall } from "../builder/models.ts"
import type {
  AccessibilityAttributes,
  Action,
  CheckRule,
  Child,
  ChildList,
  DynamicBoolean,
  DynamicChildList,
  DynamicNumber,
  DynamicString,
  DynamicStringList,
  DynamicValue,
  Extensions,
} from "../builder/models.ts"
import type { ChoicePickerOption, IconNameSvgPath, TabItem } from "../builder/basic.ts"

/** The parameter types that take no arguments. */
export type SimpleKind =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "any"
  | "child"
  | "dynamicChildList"
  | "action"
  | "dataBinding"
  | "functionCall"
  | "checkRule"
  | "accessibility"
  | "extensions"
  | "literalObject"
  | "dynamicString"
  | "dynamicNumber"
  | "dynamicBoolean"
  | "dynamicStringList"
  | "dynamicValue"
  | "childList"

/** A field of a sub-model (`object`) type. */
export interface ObjectField {
  readonly name: string
  readonly type: ParamType
  readonly description: string | undefined
  readonly required: boolean
  readonly hasDefault: boolean
  readonly default: unknown
}

/** A parameter's type: what Python reads from an annotation. */
export type ParamType =
  | { readonly kind: SimpleKind }
  | { readonly kind: "literal"; readonly values: ReadonlyArray<LiteralValue> }
  | { readonly kind: "array"; readonly items: ParamType }
  | { readonly kind: "record"; readonly values: ParamType | undefined }
  | {
      readonly kind: "object"
      readonly fields: ReadonlyArray<ObjectField>
      /** Whether keys other than the fields are refused (Pydantic's `extra="forbid"`): `additionalProperties: false`. */
      readonly closed: boolean
      /** Makes the value from its coerced fields (a sub-model's class); a plain object when absent. */
      readonly build?: ((fields: Readonly<Record<string, unknown>>) => unknown) | undefined
    }
  | { readonly kind: "union"; readonly members: ReadonlyArray<ParamType> }

export type LiteralValue = string | number | boolean

/** Whether a parameter must be given, has a default, or may be left out. */
export type Presence = "required" | "default" | "optional"

declare const VALUE: unique symbol

/** A macro parameter: its type, description and presence, and the TypeScript type `T` of the value `render` gets. */
export interface Param<T, M extends Presence = Presence> {
  readonly type: ParamType
  readonly description: string | undefined
  readonly presence: M
  readonly default: unknown
  /** The value's type, for inference only. */
  readonly [VALUE]?: T
}

/** Any parameter. */
export type AnyParam = Param<unknown>

/** The parameters of a macro, by name. */
export type Params = Readonly<Record<string, AnyParam>>

/** The value type of a parameter. */
export type ValueOf<P> = P extends Param<infer T, infer M> ? (M extends "optional" ? T | undefined : T) : never

/** What `render` gets: every parameter, an optional one left out as `undefined`. */
export type RenderArgs<P extends Params> = { readonly [K in keyof P]: ValueOf<P[K]> }

type OptionalKeys<P extends Params> = { [K in keyof P]: P[K] extends Param<unknown, "required"> ? never : K }[keyof P]
type RequiredKeys<P extends Params> = Exclude<keyof P, OptionalKeys<P>>

/** The arguments of a direct call of a macro: those with a default, or optional, may be left out. */
export type CallArgs<P extends Params> = { readonly [K in RequiredKeys<P>]: ValueOf<P[K]> } & { readonly [K in OptionalKeys<P>]?: ValueOf<P[K]> | undefined }

/** A parameter's presence options: a default value, or optional (left out as `undefined`). */
export type ParamOptions<T> = { readonly default: T } | { readonly optional: true }

/** Makes a parameter of one type, as required, with a default, or optional. */
export interface ParamFactory<T> {
  (description?: string): Param<T, "required">
  (description: string | undefined, options: { readonly default: T }): Param<T, "default">
  (description: string | undefined, options: { readonly optional: true }): Param<T, "optional">
}

const make = <T, M extends Presence>(type: ParamType, description: string | undefined, options: ParamOptions<T> | undefined): Param<T, M> => {
  const presence = options === undefined ? "required" : "default" in options ? "default" : "optional"
  const param: Param<unknown> = { type, description, presence, default: options !== undefined && "default" in options ? options.default : undefined }
  return narrow<T, M>(param)
}

// The phantom type and the presence are known statically from the factory's overloads; at runtime a parameter is the
// same record whatever they are.
function narrow<T, M extends Presence>(param: Param<unknown>): Param<T, M>
function narrow(param: Param<unknown>): Param<unknown> {
  return param
}

function factory<T>(type: ParamType): ParamFactory<T> {
  function create(description?: string): Param<T, "required">
  function create(description: string | undefined, options: { readonly default: T }): Param<T, "default">
  function create(description: string | undefined, options: { readonly optional: true }): Param<T, "optional">
  function create(description?: string, options?: ParamOptions<T>): Param<T> {
    return make<T, Presence>(type, description, options)
  }
  return create
}

const simple = (kind: SimpleKind): ParamType => ({ kind })

/** The members of a union, flattened: nested unions and the aliases that are unions (`DynamicString`…) open up. */
export const unionMembers = (type: ParamType): ReadonlyArray<ParamType> => {
  if (type.kind === "union") return type.members.flatMap(unionMembers)
  const alias = ALIASES[type.kind]
  return alias === undefined ? [type] : alias
}

const DATA_BINDING = simple("dataBinding")
const FUNCTION_CALL = simple("functionCall")

/** The aliases Python writes as unions, as their members. */
const ALIASES: Partial<Record<ParamType["kind"], ReadonlyArray<ParamType>>> = {
  dynamicString: [simple("string"), DATA_BINDING, FUNCTION_CALL],
  dynamicNumber: [simple("integer"), simple("number"), DATA_BINDING, FUNCTION_CALL],
  dynamicBoolean: [simple("boolean"), DATA_BINDING, FUNCTION_CALL],
  dynamicStringList: [{ kind: "array", items: simple("string") }, DATA_BINDING, FUNCTION_CALL],
  dynamicValue: [
    simple("string"),
    simple("number"),
    simple("integer"),
    simple("boolean"),
    { kind: "array", items: simple("any") },
    simple("literalObject"),
    DATA_BINDING,
    FUNCTION_CALL,
  ],
  childList: [{ kind: "array", items: simple("child") }, simple("dynamicChildList")],
}

type Fields = Readonly<Record<string, AnyParam>>
type ObjectValue<F extends Fields> = { readonly [K in RequiredKeys<F>]: ValueOf<F[K]> } & { readonly [K in OptionalKeys<F>]?: ValueOf<F[K]> }

const objectType = (fields: Fields, closed: boolean, build?: (fields: Readonly<Record<string, unknown>>) => unknown): ParamType => ({
  kind: "object",
  fields: Object.entries(fields).map(([name, p]) => ({
    name,
    type: p.type,
    description: p.description,
    required: p.presence === "required",
    hasDefault: p.presence === "default",
    default: p.default,
  })),
  closed,
  build,
})

const str = (v: unknown): v is string => typeof v === "string"

/** The `ActionEvent` sub-model of the v1.0 common types, which coerces to an `ActionEvent`. */
const ACTION_EVENT_FIELDS: Fields = {
  name: make<string, "required">(simple("string"), "The name of the action to be dispatched to the agent.", undefined),
  userMessage: make<DynamicString, "optional">(
    simple("dynamicString"),
    "An optional human-readable message describing the action performed by the user, resolved by the renderer and included in the outbound action message.",
    { optional: true },
  ),
  context: make<Readonly<Record<string, DynamicValue>>, "optional">(
    { kind: "record", values: simple("dynamicValue") },
    "A JSON object containing the key-value pairs for the action context. Values can be literals or paths. Use literal values unless the value must be dynamically bound to the data model. Do NOT use paths for static IDs.",
    { optional: true },
  ),
}

// The fields come coerced (coerce.ts): `userMessage` a string, binding or call, `context` a map of dynamic values.
const buildActionEvent = (f: Readonly<Record<string, unknown>>): ActionEvent => {
  const name = f["name"]
  const userMessage = f["userMessage"]
  const context = f["context"]
  if (!str(name)) throw new TypeError("ActionEvent requires a string 'name'.")
  return new ActionEvent(name, {
    userMessage: str(userMessage) || userMessage instanceof DataBinding || userMessage instanceof FunctionCall ? userMessage : undefined,
    context: isDynamicMap(context) ? context : undefined,
  })
}

const isDynamicValue = (v: unknown): v is DynamicValue =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" || (typeof v === "object" && v !== null)
const isDynamicMap = (v: unknown): v is Readonly<Record<string, DynamicValue>> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(isDynamicValue)

/** `Literal[...]` or an `Enum`: one of `values`. */
function literal<const V extends ReadonlyArray<LiteralValue>>(values: V, description?: string): Param<V[number], "required">
function literal<const V extends ReadonlyArray<LiteralValue>>(
  values: V,
  description: string | undefined,
  options: { readonly default: V[number] },
): Param<V[number], "default">
function literal<const V extends ReadonlyArray<LiteralValue>>(
  values: V,
  description: string | undefined,
  options: { readonly optional: true },
): Param<V[number], "optional">
function literal<const V extends ReadonlyArray<LiteralValue>>(values: V, description?: string, options?: ParamOptions<V[number]>): Param<V[number]> {
  return make({ kind: "literal", values }, description, options)
}

/** `Sequence[T]`. */
function array<T>(items: Param<T>, description?: string): Param<ReadonlyArray<T>, "required">
function array<T>(items: Param<T>, description: string | undefined, options: { readonly default: ReadonlyArray<T> }): Param<ReadonlyArray<T>, "default">
function array<T>(items: Param<T>, description: string | undefined, options: { readonly optional: true }): Param<ReadonlyArray<T>, "optional">
function array<T>(items: Param<T>, description?: string, options?: ParamOptions<ReadonlyArray<T>>): Param<ReadonlyArray<T>> {
  return make({ kind: "array", items: items.type }, description, options)
}

/** `dict[str, V]`, each value coerced as `V`; with `values` undefined, `dict` (passed as it is). */
function record<T = unknown>(values?: Param<T>, description?: string): Param<Readonly<Record<string, T>>, "required">
function record<T = unknown>(
  values: Param<T> | undefined,
  description: string | undefined,
  options: { readonly default: Readonly<Record<string, T>> },
): Param<Readonly<Record<string, T>>, "default">
function record<T = unknown>(
  values: Param<T> | undefined,
  description: string | undefined,
  options: { readonly optional: true },
): Param<Readonly<Record<string, T>>, "optional">
function record<T = unknown>(values?: Param<T>, description?: string, options?: ParamOptions<Readonly<Record<string, T>>>): Param<Readonly<Record<string, T>>> {
  return make({ kind: "record", values: values?.type }, description, options)
}

/**
 * A sub-model (a Python `BaseModel` parameter): an object of `fields`, each coerced by its type. Closed (the default,
 * as the builder's models are) it refuses other keys and has `additionalProperties: false`; open, it drops them.
 */
function object<F extends Fields>(fields: F, description?: string, options?: { readonly closed?: boolean }): Param<ObjectValue<F>, "required">
function object<F extends Fields>(
  fields: F,
  description: string | undefined,
  options: { readonly closed?: boolean; readonly default: ObjectValue<F> },
): Param<ObjectValue<F>, "default">
function object<F extends Fields>(
  fields: F,
  description: string | undefined,
  options: { readonly closed?: boolean; readonly optional: true },
): Param<ObjectValue<F>, "optional">
function object<F extends Fields>(
  fields: F,
  description?: string,
  options?: { readonly closed?: boolean } & Partial<{ readonly default: ObjectValue<F>; readonly optional: true }>,
): Param<ObjectValue<F>> {
  const presence: ParamOptions<ObjectValue<F>> | undefined =
    options?.default !== undefined ? { default: options.default } : options?.optional === true ? { optional: true } : undefined
  return make(objectType(fields, options?.closed ?? true), description, presence)
}

/** A union (`Literal[...] | DataBinding`, `IconName | IconNameSvgPath`…), coerced against its matching branches. */
function union<const M extends ReadonlyArray<AnyParam>>(members: M, description?: string): Param<ValueOf<M[number]>, "required">
function union<const M extends ReadonlyArray<AnyParam>>(
  members: M,
  description: string | undefined,
  options: { readonly default: ValueOf<M[number]> },
): Param<ValueOf<M[number]>, "default">
function union<const M extends ReadonlyArray<AnyParam>>(
  members: M,
  description: string | undefined,
  options: { readonly optional: true },
): Param<ValueOf<M[number]>, "optional">
function union<const M extends ReadonlyArray<AnyParam>>(
  members: M,
  description?: string,
  options?: ParamOptions<ValueOf<M[number]>>,
): Param<ValueOf<M[number]>> {
  return make({ kind: "union", members: members.map((m) => m.type) }, description, options)
}

const field = (type: ParamType): AnyParam => make(type, undefined, undefined)

/**
 * The parameter types, one for each row of the Python README's table (v1.0). Each takes a description and, last, an
 * option: `{ default: value }`, or `{ optional: true }` for one left out as `undefined`.
 */
export const param = {
  /** `str`: a literal string. */
  string: factory<string>(simple("string")),
  /** `int`: a literal integer. */
  integer: factory<number>(simple("integer")),
  /** `float`: a literal number. */
  number: factory<number>(simple("number")),
  /** `bool`: a literal boolean. */
  boolean: factory<boolean>(simple("boolean")),
  literal,
  /** `Child`: a component, given on the wire as its id. */
  child: factory<Child>(simple("child")),
  /** `ChildList`: a static list of children (ids) or a `{path, componentId}` template. */
  childList: factory<ChildList>(simple("childList")),
  /** `Sequence[Child]`: a static list of children (ids). */
  componentList: factory<ReadonlyArray<Child>>({ kind: "array", items: simple("child") }),
  /** `DynamicChildList`: a `{path, componentId}` template. */
  dynamicChildList: factory<DynamicChildList>(simple("dynamicChildList")),
  /** `Action`: an event name, an event or call shorthand, or a full action. */
  action: factory<Action>(simple("action")),
  /** `DynamicString`: a string, `{"@path"}` or `{"@call"}`. */
  dynamicString: factory<DynamicString>(simple("dynamicString")),
  dynamicNumber: factory<DynamicNumber>(simple("dynamicNumber")),
  dynamicBoolean: factory<DynamicBoolean>(simple("dynamicBoolean")),
  dynamicStringList: factory<DynamicStringList>(simple("dynamicStringList")),
  /** `DynamicValue`: any literal (plain `path`/`call` maps stay literal objects), `{"@path"}` or `{"@call"}`. */
  dynamicValue: factory<DynamicValue>(simple("dynamicValue")),
  dataBinding: factory<DataBinding>(simple("dataBinding")),
  functionCall: factory<FunctionCall>(simple("functionCall")),
  checkRule: factory<CheckRule>(simple("checkRule")),
  /** `Sequence[CheckRule]`. */
  checkRules: factory<ReadonlyArray<CheckRule>>({ kind: "array", items: simple("checkRule") }),
  /** `AccessibilityAttributes`: a declared one is an argument, not the envelope field. */
  accessibility: factory<AccessibilityAttributes>(simple("accessibility")),
  /** `Extensions`: an extension map, passed as it is. */
  extensions: factory<Extensions>(simple("extensions")),
  /** `Any`: passed as it is, except bare `@path`/`@call`/template maps. */
  any: factory<unknown>(simple("any")),
  array,
  record,
  object,
  union,
  /** The basic catalog's `TabItem`. */
  tabItem: factory<TabItem>(objectType({ title: field(simple("dynamicString")), child: field(simple("child")) }, true)),
  /** The basic catalog's `ChoicePickerOption`. */
  choicePickerOption: factory<ChoicePickerOption>(objectType({ label: field(simple("dynamicString")), value: field(simple("string")) }, true)),
  /** The basic catalog's `IconNameSvgPath`. */
  iconNameSvgPath: factory<IconNameSvgPath>(objectType({ svgPath: field(simple("dynamicString")) }, true)),
  /** `ActionEvent`: an event's `name`, `userMessage` and `context`. */
  actionEvent: factory<ActionEvent>(objectType(ACTION_EVENT_FIELDS, true, buildActionEvent)),
} as const
