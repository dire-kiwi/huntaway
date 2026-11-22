// Copyright 2024 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0. Unless required by
// applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language
// governing permissions and limitations under the License.
//
// Ported to TypeScript for Huntaway (HE-77) from A2UI's Python agent SDK at commit 5ff1b05f:
// python/a2ui_agent/src/a2ui/transformers/macros/macro.py (`@macro`, `_MacroMetadata`, the protocol version and name
// rules). Python's decorator reads a function's annotations and docstring; `macro()` takes them declared. Every macro
// here targets A2UI v1.0, as the only builder ported is v1.0's (Python infers the version from the annotations).

import { A2uiValidationError } from "@a2ui/web_core/errors"
import { isValidUax31Identifier } from "@a2ui/web_core/validating"
import type { ComponentNode, ComponentRef } from "../builder/models.ts"
import type { CallArgs, Params, Presence, RenderArgs } from "./params.ts"
import type { ParamType } from "./params.ts"
import { DEFAULT_COMMON_REF_PREFIX, typeSchema } from "./schema.ts"

/** The protocol families a macro or an expander targets. */
export type MacroVersionFamily = "0.9" | "1.0"

/** A protocol-level macro violation (a version mismatch, a reserved or invalid name): raised whatever `onError` is. */
export class MacroProtocolError extends A2uiValidationError {
  constructor(message: string) {
    super(message)
    this.name = "MacroProtocolError"
  }
}

/** A protocol version without its leading `v`, as catalog documents write it (`v1.0` → `1.0`). */
export const toVersionNumber = (version: string): string => (version.startsWith("v") || version.startsWith("V") ? version.slice(1) : version)

/** The macro family of a protocol version; v0.8 and unknown versions are refused. */
export function normalizeVersionFamily(version: string): MacroVersionFamily {
  const number = toVersionNumber(version)
  if (number === "0.9" || number === "0.9.1") return "0.9"
  if (number === "1.0") return "1.0"
  throw new MacroProtocolError(`Unsupported macro protocol version: '${version}'.`)
}

/** Whether `name` is `Surface` once NFKC-normalized: v1.0 reserves it. */
export const isReservedSurfaceName = (name: string): boolean => name.normalize("NFKC") === "Surface"

/** Checks a macro's component name against the v1.0 identifier and reservation rules. */
export function validateV1MacroName(name: string): void {
  if (isReservedSurfaceName(name)) throw new MacroProtocolError("Macro name 'Surface' is reserved and cannot be used as a component name.")
  if (!isValidUax31Identifier(name)) throw new MacroProtocolError(`Macro name '${name}' must be a valid Unicode identifier.`)
}

/** A parameter of a macro, as the expander reads it. */
export interface MacroParameter {
  readonly name: string
  readonly type: ParamType
  readonly description: string | undefined
  readonly presence: Presence
  readonly default: unknown
}

/** Options of a macro's component schema. */
export interface MacroSchemaOptions {
  readonly refPrefix?: string
  /** Adds `component: {const: name}` (required), as v1.0 catalogs write components. */
  readonly includeComponentConst?: boolean
}

/** What a macro returns: one root node (or a reference to one already on the surface). */
export type MacroResult = ComponentNode | ComponentRef

/** A registered macro: its name, description and parameters, and the function that builds its tree. */
export class MacroDefinition {
  readonly name: string
  readonly description: string | undefined
  readonly parameters: ReadonlyMap<string, MacroParameter>
  /** The protocol family it targets: always v1.0 here. */
  readonly targetVersion: MacroVersionFamily = "1.0"
  /** Builds the macro's tree from coerced arguments, by parameter name. */
  readonly render: (args: Readonly<Record<string, unknown>>) => unknown
  constructor(
    name: string,
    description: string | undefined,
    parameters: ReadonlyMap<string, MacroParameter>,
    render: (args: Readonly<Record<string, unknown>>) => unknown,
  ) {
    validateV1MacroName(name)
    this.name = name
    this.description = description
    this.parameters = parameters
    this.render = render
  }

  /** The JSON Schema of the macro as a catalog component. */
  toJsonSchema(options: MacroSchemaOptions = {}): Record<string, unknown> {
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    if (options.includeComponentConst) {
      properties["component"] = { const: this.name }
      required.push("component")
    }
    for (const p of this.parameters.values()) {
      properties[p.name] = typeSchema(p.type, p.description, options.refPrefix ?? DEFAULT_COMMON_REF_PREFIX)
      if (p.presence === "required") required.push(p.name)
    }
    const schema: Record<string, unknown> = { type: "object", properties }
    if (required.length > 0) schema["required"] = required
    if (this.description) schema["description"] = this.description
    return schema
  }
}

/** How a macro is declared. */
export interface MacroOptions<P extends Params> {
  /** Its component name: a Unicode identifier, not `Surface`. */
  readonly name: string
  /** What it renders, for the prompt. */
  readonly description?: string
  readonly params: P
  /** Builds the tree from the coerced arguments; it must return a single root node. */
  readonly render: (args: RenderArgs<P>) => MacroResult
}

/** A macro: callable from another macro's `render` (which inlines its tree), and registered with a `MacroExpander`. */
export interface Macro<P extends Params> {
  (args: CallArgs<P>): MacroResult
  readonly definition: MacroDefinition
}

// The arguments are typed by `P` at the call sites (`render`'s and the direct call's); in between they are a record by
// parameter name, which is what Python's `**kwargs` is.
function asRenderArgs<P extends Params>(args: Readonly<Record<string, unknown>>): RenderArgs<P>
function asRenderArgs(args: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return args
}

/** Fills in the defaults of the parameters `args` leaves out. */
export const withDefaults = (parameters: ReadonlyMap<string, MacroParameter>, args: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...args }
  for (const p of parameters.values()) if (out[p.name] === undefined && p.presence === "default") out[p.name] = p.default
  return out
}

/**
 * Declares a macro: a high-level component a model can use, which `MacroExpander` lowers to the components `render`
 * builds. Its parameters' types give the component's JSON Schema and how its wire arguments are coerced.
 *
 * @throws {A2uiValidationError} If `name` is not a valid v1.0 component name.
 */
export function macro<P extends Params>(options: MacroOptions<P>): Macro<P> {
  const parameters = new Map<string, MacroParameter>(
    Object.entries(options.params).map(([name, p]) => [name, { name, type: p.type, description: p.description, presence: p.presence, default: p.default }]),
  )
  const render = (args: Readonly<Record<string, unknown>>): MacroResult => options.render(asRenderArgs<P>(args))
  const definition = new MacroDefinition(options.name, options.description, parameters, render)
  const call = (args: CallArgs<P>): MacroResult => render(withDefaults(parameters, args))
  return Object.assign(call, { definition })
}

/** A macro of any parameters, as a `MacroExpander` takes one: what `macro()` returns, or its definition. */
export type AnyMacro = { readonly definition: MacroDefinition } | MacroDefinition

/** The definition of a macro, or the definition itself. */
export const definitionOf = (m: AnyMacro): MacroDefinition => (m instanceof MacroDefinition ? m : m.definition)

export { DEFAULT_COMMON_REF_PREFIX }
