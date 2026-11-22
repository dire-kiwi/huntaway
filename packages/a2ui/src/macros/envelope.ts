// Copyright 2024 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0. Unless required by
// applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language
// governing permissions and limitations under the License.
//
// Ported to TypeScript for Huntaway (HE-77) from A2UI's Python agent SDK at commit 5ff1b05f:
// python/a2ui_agent/src/a2ui/utils/component_envelope.py, and `_instance_envelope_value` and `_apply_envelope_fields` of
// transformers/macros/expander.py. The component envelope fields (`catalogId`, `metadata`, `accessibility`, `checks`)
// carry an `@` from v1.0 (`@catalogId`…); readers of v1.0 also take the bare keys of earlier payloads, unless the
// component declares a property of that name.

import type { WireComponent } from "../builder/flatten.ts"

/** The bare names of the component envelope fields. */
export const ENVELOPE_MIXIN_NAMES = ["catalogId", "metadata", "accessibility", "checks"] as const
export type EnvelopeName = (typeof ENVELOPE_MIXIN_NAMES)[number]

const AT_KEYS = new Set<string>(ENVELOPE_MIXIN_NAMES.map((n) => `@${n}`))
const BARE_KEYS = new Set<string>(ENVELOPE_MIXIN_NAMES)

/** Names a component (or a macro) declares as properties of its own rather than as envelope fields. */
export type CustomProperties = { has(name: string): boolean }

const NONE: CustomProperties = new Set<string>()

/** The key a writer uses for an envelope field: `@<name>` from v1.0. */
export const envelopeKey = (name: EnvelopeName, atLeastV10: boolean): string => (atLeastV10 ? `@${name}` : name)

/** The key that holds an envelope field on `component`, or undefined when neither is present. */
export function envelopeReadKey(
  component: Readonly<WireComponent>,
  name: EnvelopeName,
  atLeastV10: boolean,
  custom: CustomProperties = NONE,
): string | undefined {
  if (atLeastV10) {
    const at = `@${name}`
    if (at in component) return at
    if (custom.has(name)) return undefined
  }
  return name in component ? name : undefined
}

/** The value of an envelope field on `component` (undefined when it sets none; null as it is written). */
export function getEnvelopeValue(component: Readonly<WireComponent>, name: EnvelopeName, atLeastV10: boolean, custom: CustomProperties = NONE): unknown {
  const key = envelopeReadKey(component, name, atLeastV10, custom)
  return key === undefined ? undefined : component[key]
}

/** Whether a component key holds an envelope field. */
export function isEnvelopeKey(key: string, atLeastV10: boolean, custom: CustomProperties = NONE): boolean {
  if (AT_KEYS.has(key)) return atLeastV10
  return BARE_KEYS.has(key) && !custom.has(key)
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** A deep copy of a JSON value. */
export const cloneJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneJson)
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneJson(v)]))
  return value
}

/** How a v1.0 writer spells the envelope fields: `@catalogId`… (the spec from the `@` cutover), or bare. */
export type EnvelopeKeys = "at" | "bare"

/**
 * `component` with its `@` envelope keys written bare (`@catalogId` → `catalogId`…), in place of where they were; a
 * key whose bare form is already there stays as it is. For renderers from before the `@` cutover, such as the
 * published `@a2ui/web_core` 0.15, which refuse the `@` keys.
 */
export function withBareEnvelopeKeys(component: Readonly<WireComponent>): WireComponent {
  const out: WireComponent = {}
  for (const [key, value] of Object.entries(component)) {
    const bare = AT_KEYS.has(key) ? key.slice(1) : undefined
    out[bare !== undefined && !(bare in component) ? bare : key] = value
  }
  return out
}

/**
 * An envelope field of a macro instance. The `@` key wins from v1.0; the bare key is the legacy fallback unless the
 * macro declares a parameter of that name (then it is an argument). Undefined when the instance sets none.
 */
const instanceEnvelopeValue = (comp: Readonly<WireComponent>, name: EnvelopeName, isV10: boolean, declared: CustomProperties): unknown => {
  const key = envelopeReadKey(comp, name, isV10, declared)
  if (key === undefined || (key === name && declared.has(name))) return undefined
  const value = comp[key]
  return value === null ? undefined : value
}

/**
 * Moves the envelope fields of a macro instance onto its expanded root: `accessibility` and (from v1.0) `metadata`
 * merge with what the root has (`metadata.extensions` too), and `checks` are appended to the root's. The instance's
 * `catalogId` names the macro's catalog, so it is never copied.
 */
export function applyEnvelopeFields(
  comp: Readonly<WireComponent>,
  declared: CustomProperties,
  expanded: WireComponent[],
  instanceId: string | undefined,
  isV10: boolean,
  writeAtKeys: boolean = isV10,
): void {
  let root = expanded.at(-1)
  if (root === undefined) return
  if (instanceId !== undefined) {
    const match = expanded.findLast((item) => item["id"] === instanceId)
    if (match !== undefined) root = match
  }
  const target = root
  const read = (name: EnvelopeName): unknown => instanceEnvelopeValue(comp, name, isV10, declared)

  const a11y = read("accessibility")
  if (a11y !== undefined) {
    const key = envelopeKey("accessibility", writeAtKeys)
    const copy = cloneJson(a11y)
    const existing = target[key]
    target[key] = isPlainObject(existing) && isPlainObject(copy) ? { ...existing, ...copy } : copy
  }

  const checks = read("checks")
  if (checks !== undefined) {
    const key = envelopeKey("checks", writeAtKeys)
    const copy = cloneJson(checks)
    const existing = target[key]
    target[key] = Array.isArray(existing) && Array.isArray(copy) ? [...existing, ...copy] : copy
  }

  if (!isV10) return
  const meta = read("metadata")
  if (meta !== undefined) {
    const key = envelopeKey("metadata", writeAtKeys)
    const copy = cloneJson(meta)
    const existing = target[key]
    if (isPlainObject(existing) && isPlainObject(copy)) {
      const merged: Record<string, unknown> = { ...existing, ...copy }
      const a = existing["extensions"]
      const b = copy["extensions"]
      if (isPlainObject(a) && isPlainObject(b)) merged["extensions"] = { ...a, ...b }
      target[key] = merged
    } else target[key] = copy
  }
}
