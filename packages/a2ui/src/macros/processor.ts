// Copyright 2024 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0. Unless required by
// applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language
// governing permissions and limitations under the License.
//
// Ported to TypeScript for Huntaway (HE-77) from A2UI's Python agent SDK at commit 5ff1b05f:
// python/a2ui_agent/src/a2ui/transformers/macros/processor.py (`_MacroProcessor.expand`). Runs one macro: coerces its
// wire arguments, calls its `render`, and flattens the tree under the instance's id.

import { flattenComponentTree } from "../builder/flatten.ts"
import type { WireComponent } from "../builder/flatten.ts"
import { ComponentNode, ComponentRef } from "../builder/models.ts"
import { coerceValue } from "./coerce.ts"
import { isReservedSurfaceName, MacroProtocolError, normalizeVersionFamily, validateV1MacroName, withDefaults } from "./macro.ts"
import type { MacroDefinition, MacroVersionFamily } from "./macro.ts"

const isRoot = (value: unknown): value is ComponentNode | ComponentRef => value instanceof ComponentNode || value instanceof ComponentRef

/** The single root a macro returned, or a `TypeError` (Python's checks of the returned value). */
const rootOf = (name: string, result: unknown): ComponentNode | ComponentRef => {
  if (Array.isArray(result)) {
    const [only] = result
    if (result.length !== 1 || !isRoot(only)) {
      throw new TypeError(`Macro '${name}' must return a single root ComponentBuilderNode, got sequence of length ${result.length}.`)
    }
    return only
  }
  if (!isRoot(result)) throw new TypeError(`Macro '${name}' must return a ComponentBuilderNode, got ${result === null ? "null" : typeof result}.`)
  return result
}

/**
 * Runs the macro `meta` with wire `args` and returns its flat components, the root under `instanceId`.
 *
 * @throws {MacroProtocolError} If the macro cannot run under `protocolVersion`, or emits a `Surface` component.
 * @throws {TypeError} If an argument does not coerce, is not declared, or a required one is missing, or `render`
 *   returns something other than one root node; or whatever `render` throws.
 */
export function expandMacro(
  meta: MacroDefinition,
  args: Readonly<Record<string, unknown>>,
  instanceId: string | undefined,
  protocolVersion: string | undefined,
  defaultFamily: MacroVersionFamily | undefined,
): WireComponent[] {
  const envFamily = protocolVersion !== undefined ? normalizeVersionFamily(protocolVersion) : defaultFamily
  if (envFamily !== undefined && meta.targetVersion !== envFamily) {
    throw new MacroProtocolError(`Cannot expand v${meta.targetVersion} macro '${meta.name}' under A2UI protocol ${protocolVersion ?? envFamily}.`)
  }

  // Coerce the wire arguments to builder values. Python then calls the function with them as keyword arguments, which
  // fails on an undeclared one or a missing required one: so does this.
  const coerced: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(args)) {
    const p = meta.parameters.get(name)
    if (p === undefined) throw new TypeError(`Macro '${meta.name}' got an unexpected argument '${name}'.`)
    coerced[name] = coerceValue(value, p.type, name, meta.name)
  }
  for (const p of meta.parameters.values()) {
    if (p.presence === "required" && !(p.name in coerced)) throw new TypeError(`Macro '${meta.name}' is missing the required argument '${p.name}'.`)
  }

  const root = rootOf(meta.name, meta.render(withDefaults(meta.parameters, coerced)))
  const flattened = flattenComponentTree(root, instanceId)
  validateV1MacroName(meta.name)
  for (const comp of flattened) {
    const name = comp["component"]
    if (typeof name === "string" && isReservedSurfaceName(name)) throw new MacroProtocolError(`Macro '${meta.name}' emitted reserved component name 'Surface'.`)
  }
  return flattened
}
