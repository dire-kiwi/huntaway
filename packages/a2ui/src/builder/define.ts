// Copyright 2024 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0. Unless required by
// applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language
// governing permissions and limitations under the License.
//
// Ported to TypeScript for Huntaway (HE-77) from A2UI's Python agent SDK at commit 5ff1b05f:
// python/a2ui_agent/src/a2ui/builder/v1_0/models.py (`ComponentBuilderNode` and its `catalog_id=` subclass keyword).
// Python declares a builder as a Pydantic class; here a builder is a function that makes `ComponentNode`s, and
// `catalogNodes` is the shared base class that stamps one catalog id on a family of them.

import { ComponentNode } from "./models.ts"
import type { NodeEnvelope } from "./models.ts"

/** How a builder writes its component. */
export interface ComponentOptions<P> {
  /** The catalog its nodes belong to (`@catalogId`), unless a node names another. */
  readonly catalogId?: string | undefined
  /** The properties in the order they are written; the others follow in the order they are given. */
  readonly fields?: ReadonlyArray<keyof P & string>
  /** Values written when a property is not given. */
  readonly defaults?: Partial<P>
  /** Wire keys for properties written under another name (`checks` is `@checks` in the basic catalog). */
  readonly wireKeys?: Partial<Record<keyof P & string, string>>
}

/** A builder: makes a node of `component` from its properties and envelope fields. */
export interface ComponentFactory<P> {
  (props: P & NodeEnvelope): ComponentNode
  /** The component name. */
  readonly component: string
  /** The catalog its nodes belong to, when the builder names one. */
  readonly catalogId: string | undefined
}

const ENVELOPE_KEYS = new Set(["id", "catalogId", "accessibility", "extensions"])

/**
 * A builder for a component of any catalog: `defineComponent<{ title: DynamicString }>("FooHeader", { catalogId })`.
 * Its nodes carry `catalogId` unless a node names another.
 */
export function defineComponent<P extends object = Record<string, unknown>>(component: string, options: ComponentOptions<P> = {}): ComponentFactory<P> {
  const fields: ReadonlyArray<string> = options.fields ?? []
  const defaults = new Map<string, unknown>(Object.entries(options.defaults ?? {}))
  const wireKeys = new Map<string, unknown>(Object.entries(options.wireKeys ?? {}))
  const make = (props: P & NodeEnvelope): ComponentNode => {
    const given = new Map(Object.entries(props).filter(([key]) => !ENVELOPE_KEYS.has(key)))
    const out: Record<string, unknown> = {}
    const write = (key: string): void => {
      const value = given.get(key) ?? defaults.get(key)
      const wireKey = wireKeys.get(key)
      if (value !== undefined) out[typeof wireKey === "string" ? wireKey : key] = value
    }
    for (const key of fields) write(key)
    for (const key of given.keys()) if (!fields.includes(key)) write(key)
    for (const key of defaults.keys()) if (!fields.includes(key) && !given.has(key)) write(key)
    return new ComponentNode(component, out, {
      id: props.id,
      catalogId: props.catalogId ?? options.catalogId,
      accessibility: props.accessibility,
      extensions: props.extensions,
    })
  }
  return Object.assign(make, { component, catalogId: options.catalogId })
}

/** The builders of one catalog: every node they make carries its id (Python's `ComponentBuilderNode, catalog_id=…`). */
export interface CatalogNodes {
  readonly catalogId: string
  define<P extends object = Record<string, unknown>>(component: string, options?: Omit<ComponentOptions<P>, "catalogId">): ComponentFactory<P>
}

/** Builders for the components of the catalog `catalogId`. */
export const catalogNodes = (catalogId: string): CatalogNodes => ({
  catalogId,
  define: <P extends object = Record<string, unknown>>(component: string, options: Omit<ComponentOptions<P>, "catalogId"> = {}) =>
    defineComponent<P>(component, { ...options, catalogId }),
})
