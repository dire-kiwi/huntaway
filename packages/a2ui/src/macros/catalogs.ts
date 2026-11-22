// Copyright 2024 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0. Unless required by
// applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language
// governing permissions and limitations under the License.
//
// Ported to TypeScript for Huntaway (HE-77) from A2UI's Python agent SDK at commit 5ff1b05f:
// python/a2ui_agent/src/a2ui/transformers/macros/expander.py (`transform_to_inference_catalog`, `to_catalog`) and the
// one question `MacroExpander` asks of `CatalogSchemaHelper` (python/a2ui_agent/src/a2ui/inference_formats/_shared/
// schema_helper.py, `get_custom_envelope_properties`): whether a component declares `catalogId` as its own property.

import { Catalog } from "@a2ui/web_core/catalog"
import type { CatalogApi } from "@a2ui/web_core/catalog"
import { A2uiCatalogError } from "@a2ui/web_core/errors"
import { isJsonObject } from "./coerce.ts"
import type { JsonObject } from "./coerce.ts"
import type { MacroDefinition } from "./macro.ts"

/** The catalog id of a standalone macro catalog, unless the expander names one. */
export const DEFAULT_MACRO_CATALOG_ID = "https://a2ui.org/catalogs/macros"

const COMPONENTS_KEY = "components"
const STANDARD_CATALOG_ID_DESCRIPTION = "The catalog ID for this component, overriding any surface-level default catalogId."

/** The node a local reference (`#/…`) points at in `doc`. */
const resolveLocal = (doc: JsonObject, ref: string): unknown => {
  let node: unknown = doc
  for (const part of ref.slice(2).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~")
    node = isJsonObject(node) ? node[key] : undefined
  }
  return node
}

/** The properties a component schema declares: its own, those of its `allOf` and of the local definitions it uses. */
const collectProperties = (doc: JsonObject, schema: unknown, out: Map<string, unknown>, seen: Set<string>): void => {
  if (!isJsonObject(schema)) return
  const ref = schema["$ref"]
  if (typeof ref === "string" && ref.startsWith("#/") && !seen.has(ref)) {
    seen.add(ref)
    collectProperties(doc, resolveLocal(doc, ref), out, seen)
  }
  const props = schema["properties"]
  if (isJsonObject(props)) for (const [k, v] of Object.entries(props)) if (!out.has(k)) out.set(k, v)
  const allOf = schema["allOf"]
  if (Array.isArray(allOf)) for (const sub of allOf) collectProperties(doc, sub, out, seen)
}

/**
 * Whether `component` of `doc` (a catalog document) declares a bare `catalogId` property of its own, rather than the
 * `ComponentCommon` envelope field: then a bare `catalogId` on it is an ordinary property, not a catalog override.
 */
export function declaresCustomCatalogId(doc: JsonObject, component: string): boolean {
  const components = doc[COMPONENTS_KEY]
  if (!isJsonObject(components)) return false
  const props = new Map<string, unknown>()
  collectProperties(doc, components[component], props, new Set())
  const schema = props.get("catalogId")
  if (schema === undefined) return false
  return !(isJsonObject(schema) && schema["description"] === STANDARD_CATALOG_ID_DESCRIPTION)
}

/** The component names of a catalog, from its document. */
export const componentNamesOf = (doc: JsonObject): Set<string> => {
  const components = doc[COMPONENTS_KEY]
  return new Set(isJsonObject(components) ? Object.keys(components) : [])
}

const refEntry = (name: string): JsonObject => ({ $ref: `#/${COMPONENTS_KEY}/${name}` })
const refName = (entry: unknown): string => (isJsonObject(entry) && typeof entry["$ref"] === "string" ? entry["$ref"] : "")

/**
 * A copy of `base` with the macros' component schemas added (and its own components cut to `passthrough`, when it is
 * given), as an inference catalog of the same id and version.
 *
 * @throws {A2uiCatalogError} If a macro has the name of a component `base` keeps.
 */
export function augmentCatalog(
  base: CatalogApi,
  macros: ReadonlyArray<MacroDefinition>,
  passthrough: ReadonlySet<string> | undefined,
  isV10: boolean,
): CatalogApi {
  const doc: Record<string, unknown> = base.toJson()
  const componentsValue = doc[COMPONENTS_KEY]
  const components: Record<string, unknown> = isJsonObject(componentsValue) ? { ...componentsValue } : {}
  const defsValue = doc["$defs"]
  const defs: Record<string, unknown> | undefined = isJsonObject(defsValue) ? { ...defsValue } : undefined
  if (defs !== undefined) doc["$defs"] = defs
  const anyComponent = defs?.["anyComponent"]
  const anyIsObject = isJsonObject(anyComponent)
  const wasEmptyNot =
    anyIsObject && Object.keys(anyComponent).length === 1 && isJsonObject(anyComponent["not"]) && Object.keys(anyComponent["not"]).length === 0
  // A document whose component union is neither a `oneOf` list nor `{"not": {}}` admits all its components: writing a
  // union of only the macros would drop the others.
  let refs: unknown[] | undefined
  const oneOf = anyIsObject ? anyComponent["oneOf"] : undefined
  if (Array.isArray(oneOf)) refs = [...oneOf]
  else if (wasEmptyNot && macros.length > 0 && defs !== undefined) refs = []

  if (passthrough !== undefined) {
    const pruned = Object.keys(components).filter((name) => !passthrough.has(name))
    for (const name of pruned) delete components[name]
    if (refs !== undefined) refs = refs.filter((ref) => !pruned.some((name) => refName(ref).endsWith(`/${name}`)))
  }

  for (const m of macros) {
    if (m.name in components) throw new A2uiCatalogError(`Macro component '${m.name}' collides with an existing component in the base catalog.`)
    components[m.name] = m.toJsonSchema({ includeComponentConst: isV10 })
    const entry = refEntry(m.name)
    if (refs !== undefined && !refs.some((r) => refName(r) === refName(entry))) refs.push(entry)
  }

  if (defs !== undefined && refs !== undefined) {
    if (refs.length > 0) {
      const updated: Record<string, unknown> = { oneOf: refs }
      if (isV10 || (anyIsObject && "discriminator" in anyComponent)) {
        updated["discriminator"] = anyIsObject && "discriminator" in anyComponent ? anyComponent["discriminator"] : { propertyName: "component" }
      }
      defs["anyComponent"] = updated
    } else defs["anyComponent"] = { not: {} }
  }

  doc[COMPONENTS_KEY] = components
  return Catalog.fromJson(doc, String(base.protocolVersion), base.id)
}

/** A standalone catalog of only the macros' component schemas. */
export function macroCatalog(macros: ReadonlyArray<MacroDefinition>, catalogId: string, version: string, isV10: boolean): CatalogApi {
  const components = Object.fromEntries(macros.map((m) => [m.name, m.toJsonSchema({ includeComponentConst: isV10 })]))
  const refs = macros.map((m) => refEntry(m.name))
  const defs = isV10
    ? { anyComponent: refs.length > 0 ? { oneOf: refs, discriminator: { propertyName: "component" } } : { not: {} }, anyFunction: { not: {} } }
    : { anyComponent: refs.length > 0 ? { oneOf: refs } : { not: {} } }
  const doc = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    protocolVersion: version,
    catalogId,
    title: "A2UI Macros Catalog",
    description: "Standalone catalog of high-level A2UI macro components.",
    [COMPONENTS_KEY]: components,
    $defs: defs,
  }
  return Catalog.fromJson(doc, version, catalogId)
}
