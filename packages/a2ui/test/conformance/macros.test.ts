// Copyright 2024 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0. Unless required by
// applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language
// governing permissions and limitations under the License.
//
// Ported to TypeScript for Huntaway (HE-77) from A2UI's Python agent SDK at commit 5ff1b05f:
// python/a2ui_agent/tests/conformance/{macro_suite.py,test_macro_conformance.py}. Runs A2UI's macros conformance suite
// (conformance/agent/macros/macros.yaml, copied with the goldens it needs into ./fixtures) against the TypeScript port,
// the way upstream's TypeScript SDK runs its other YAML suites: every case runs, or is listed in SKIPPED with why.

import { validatePayload } from "@a2ui/agent"
import { Catalog } from "@a2ui/web_core/catalog"
import type { CatalogApi } from "@a2ui/web_core/catalog"
import { A2uiCatalogError, A2uiRecursionError, A2uiValidationError } from "@a2ui/web_core/errors"
import { describe, expect, it } from "@effect/vitest"
import { parse } from "yaml"
import { basicCatalog } from "../../src/catalog.ts"
import { MacroExpander, withBareEnvelopeKeys } from "../../src/macros/index.ts"
import type { AnyMacro, MessageLike } from "../../src/macros/index.ts"
import suiteText from "./fixtures/macros.yaml?raw"
import { collidingMacro, scopedSuiteMacros, v10SuiteMacros } from "./suite-macros.ts"

const GOLDENS = import.meta.glob("./fixtures/golden/**/*.json", { eager: true, query: "?raw", import: "default" })

const V10_BASIC_CID = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json"
const V09_BASIC_CID = "https://a2ui.org/specification/v0_9/standard_catalog.json"

/** The cases this port does not run, with the reason: every other case of the suite runs. */
const V09 = "v0.9 case: it needs the v0.9 macros and builder, which are not ported (only v1.0 is)"
const SKIPPED: Readonly<Record<string, string>> = {
  "01_status_badge_expansion": `${V09}; its v1.0 twin runs`,
  "02_slot_boundary_preservation": `${V09}; its v1.0 twin runs`,
  "03_multi_slot_list_coercion": `${V09}; its v1.0 twin runs`,
  "04_action_string_coercion": `${V09}; its v1.0 twin runs`,
  "05_data_binding_coercion": `${V09}; its v1.0 twin runs`,
  "06_primitive_and_dict_arguments": `${V09}; its v1.0 twin runs`,
  "07_nested_macro_composition": `${V09}; its v1.0 twin runs`,
  "08_surface_lifecycle_envelopes": `${V09}; its v1.0 twin runs`,
  "09_error_cyclic_macro_recursion": `${V09}; v1.0 recursion is 39a-39c, and test/macros.test.ts runs this one's macro under v1.0`,
  "10_error_macro_catalog_collision": `${V09}; test/macros.test.ts checks the collision on the v1.0 basic catalog`,
  "11_synthetic_catalog_generation": `${V09}; its v1.0 twin runs`,
  "12_catalog_version_preservation": `${V09}; its v1.0 twin runs`,
  "13_error_envelope_version_mismatch": `${V09} (a v0.8 envelope); test/macros.test.ts checks a v0.8 envelope is refused`,
  "14_multiple_macro_instances_namespacing": `${V09}; its v1.0 twin runs`,
  "15_mixed_primitive_and_macro_envelope": `${V09}; its v1.0 twin runs`,
  "16_reverse_passthrough": `${V09}; test/macros.test.ts checks transformToInference`,
  "17_passthrough_components_selective": `${V09} (a v0.9 catalog); test/macros.test.ts runs it on the v1.0 basic catalog`,
  "18_passthrough_components_only_macros": `${V09} (a v0.9 catalog); test/macros.test.ts runs it on the v1.0 basic catalog`,
  "27_to_catalog_v0_9": V09,
  "31_v0_9_gates_v1_0_envelope_fields": V09,
  "40a_error_export_v0_9_macros_as_v1_0_to_catalog": `${V09}: there are no v0.9 macros to mix with v1.0`,
  "40b_error_lower_v1_0_envelope_with_v0_9_macros": `${V09}: there are no v0.9 macros to mix with v1.0`,
  "40d_error_augment_v1_0_catalog_with_v0_9_macros": `${V09}: there are no v0.9 macros to mix with v1.0`,
  "41_v0_9_allows_surface_macro_name": `${V09}: every macro here is v1.0, where Surface is reserved`,
}

// The suite, read from YAML: everything is `unknown` until narrowed.

type Json = Readonly<Record<string, unknown>>
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const obj = (v: unknown): Json => (isObject(v) ? v : {})
const strOf = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined)

const suite = obj(parse(suiteText))
const CUSTOM_CATALOGS = obj(suite["custom_catalogs"])
const CASES: Json[] = Array.isArray(suite["tests"]) ? suite["tests"].filter(isObject) : []

const idOf = (c: Json): string => strOf(c["id"]) ?? ""
const versionNumber = (v: string): string => (v.startsWith("v") ? v.slice(1) : v)
/** `envelope_version`, or 1.0 for the `version: v1.0` twins. */
const envelopeVersion = (c: Json): string | undefined => strOf(c["envelope_version"]) ?? (strOf(c["version"]) === "v1.0" ? "1.0" : undefined)
const catalogVersion = (c: Json): string => {
  const v = envelopeVersion(c)
  return v !== undefined && versionNumber(v) === "1.0" ? "1.0" : "0.9.1"
}

// Catalogs.

const basicV10 = basicCatalog()
const catalogsById = new Map<string, CatalogApi>()

/** A catalog of the suite's `custom_catalogs`, the v1.0 basic catalog, or the basic catalog under another id. */
function resolveCatalog(cid: string, version: string): CatalogApi {
  const cached = catalogsById.get(cid)
  if (cached !== undefined) return cached
  let catalog: CatalogApi
  const custom = CUSTOM_CATALOGS[cid]
  if (isObject(custom)) catalog = Catalog.fromJson({ ...custom }, strOf(custom["protocolVersion"]) ?? version, cid)
  else if (cid === V10_BASIC_CID) catalog = basicV10
  // The v0.9 basic catalog's only use here is its version (40e, 40f), so a v0.9 catalog with no components stands in.
  else if (cid === V09_BASIC_CID || version !== "1.0") catalog = Catalog.fromJson({ catalogId: cid, components: {} }, "0.9.1", cid)
  else catalog = basicV10.derive({ catalogId: cid })
  catalogsById.set(cid, catalog)
  return catalog
}

const baseCatalogFor = (c: Json): CatalogApi => resolveCatalog(catalogVersion(c) === "1.0" ? V10_BASIC_CID : V09_BASIC_CID, catalogVersion(c))

// The expander of a case.

function selectMacros(c: Json): AnyMacro[] {
  if (c["empty_macros"] === true) return []
  const colliding = strOf(c["colliding_macro"])
  if (colliding !== undefined) return [collidingMacro(colliding)]
  const scope = strOf(c["macro_catalog_id"])
  if (scope !== undefined) {
    const scoped = scopedSuiteMacros().get(scope)
    if (scoped === undefined) throw new Error(`No scoped macros for catalog_id ${scope}`)
    return scoped
  }
  return v10SuiteMacros()
}

function buildExpander(c: Json): MacroExpander {
  const scoped = c["expander_scoped"] !== false
  const catalogId = strOf(c["expander_catalog_id"]) ?? (scoped ? strOf(c["macro_catalog_id"]) : undefined)
  const onError = strOf(c["on_error"]) === "raise" ? "raise" : "passthrough"
  return new MacroExpander(selectMacros(c), {
    passthroughComponents: strings(c["passthrough_components"]),
    catalogId,
    baseCatalogs: strings(c["base_catalogs"])?.map((cid) => resolveCatalog(cid, catalogVersion(c))),
    protocolVersion: strOf(c["expander_protocol_version"]),
    onError,
  })
}

type Message = MessageLike & Json
const isMessage = (v: unknown): v is Message => isObject(v) && typeof v["version"] === "string"

/** The messages of a transport case: `messages`, or `input` as one `updateComponents` (after a `createSurface`). */
function messagesOf(c: Json): Message[] {
  const given = c["messages"]
  if (Array.isArray(given)) return given.filter(isMessage)
  const version = envelopeVersion(c) ?? "v0.9"
  const surfaceId = strOf(c["surface_id"]) ?? "conformance"
  const input = c["input"]
  const components = Array.isArray(input) ? input : [input]
  const update = { version, updateComponents: { surfaceId, components } }
  const catalogId = strOf(c["catalog_id"])
  return catalogId === undefined ? [update] : [{ version, createSurface: { surfaceId, catalogId } }, update]
}

function surfaceCatalogsOf(c: Json): Readonly<Record<string, string | null>> | undefined {
  const given = c["surface_catalogs"]
  if (!isObject(given)) return undefined
  return Object.fromEntries(Object.entries(given).map(([k, v]) => [k, typeof v === "string" ? v : null]))
}

type Outcome = { readonly kind: "messages"; readonly messages: Json[] } | { readonly kind: "catalog"; readonly catalog: CatalogApi } | { readonly kind: "none" }

/** Runs a case through `MacroExpander` (Python's `run_case`). */
function runCase(c: Json): Outcome {
  const action = strOf(c["action"])
  if (action === "to_catalog") return { kind: "catalog", catalog: buildExpander(c).toCatalog() }
  if (action === "transform_catalog") {
    buildExpander(c).transformToInferenceCatalog(baseCatalogFor(c))
    return { kind: "none" }
  }
  if (action === "transform_to_inference_catalog") return { kind: "catalog", catalog: buildExpander(c).transformToInferenceCatalog(baseCatalogFor(c)) }
  const expander = buildExpander(c)
  const out = expander.transformToTransport(messagesOf(c), { surfaceCatalogs: surfaceCatalogsOf(c) })
  return { kind: "messages", messages: out.map((m) => obj(JSON.parse(JSON.stringify(m)))) }
}

// Renderer validation of a lowered payload (Python's `validate_payload`), with `@a2ui/agent`'s stateless check. A
// payload that only updates a surface may already hold components, so it accepts references outside the payload and
// a missing root: the relaxations the suite's `validation` profiles ask for. The published `@a2ui/web_core` 0.15 the
// check runs on predates the `@` envelope keys the suite's goldens use (`@catalogId`…) and refuses them, so the
// payload is checked with them written bare, as `envelopeKeys: "bare"` lowers it.

function validationCatalogs(c: Json): CatalogApi[] {
  const version = catalogVersion(c)
  const listed = strings(c["validation_catalogs"])
  if (listed !== undefined) return listed.map((cid) => resolveCatalog(cid, version))
  const catalogs = [baseCatalogFor(c)]
  const cid = strOf(c["catalog_id"])
  if (cid !== undefined && cid !== catalogs[0]?.id) catalogs.push(resolveCatalog(cid, version))
  return catalogs
}

const bareMessage = (m: Json): Json => {
  const out: Record<string, unknown> = { ...m }
  for (const key of ["createSurface", "updateComponents"]) {
    const body = m[key]
    if (isObject(body) && Array.isArray(body["components"])) out[key] = { ...body, components: body["components"].filter(isObject).map(withBareEnvelopeKeys) }
  }
  return out
}

function validate(messages: ReadonlyArray<Json>, c: Json): void {
  if (obj(c["validation"])["skip_renderer_validation"] === true) return
  validatePayload(validationCatalogs(c), messages.map(bareMessage))
}

const ERRORS = { CatalogError: A2uiCatalogError, RecursionError: A2uiRecursionError, ValidationError: A2uiValidationError } as const
const errorClassOf = (category: unknown): (typeof ERRORS)[keyof typeof ERRORS] => {
  if (category === "CatalogError" || category === "RecursionError" || category === "ValidationError") return ERRORS[category]
  throw new Error(`Unknown error category ${String(category)}`)
}

const componentsOf = (messages: ReadonlyArray<Json>): Json[] =>
  messages.flatMap((m) => {
    const comps = obj(m["updateComponents"])["components"]
    return Array.isArray(comps) ? comps.filter(isObject) : []
  })

function checkCatalogExpectations(catalog: CatalogApi, expect_: Json): void {
  const doc = catalog.toJson()
  const bundled = catalog.validationSchema
  const anyComponent = obj(obj(bundled["$defs"])["anyComponent"])
  const refs = (Array.isArray(anyComponent["oneOf"]) ? anyComponent["oneOf"] : []).map((r) => strOf(obj(r)["$ref"]) ?? "")
  const bundledComponents = obj(bundled["components"])
  if ("catalog_id" in expect_) {
    expect(catalog.id).toBe(expect_["catalog_id"])
    expect(doc["catalogId"]).toBe(expect_["catalog_id"])
  }
  if ("component_count" in expect_) expect(Object.keys(obj(doc["components"])).length).toBe(expect_["component_count"])
  if ("has_any_component_discriminator" in expect_) {
    const discriminator = obj(obj(doc["$defs"])["anyComponent"])["discriminator"]
    if (expect_["has_any_component_discriminator"] === true) expect(discriminator).toEqual({ propertyName: "component" })
    else expect(discriminator).toBeUndefined()
  }
  if ("has_any_function" in expect_) expect("anyFunction" in obj(doc["$defs"])).toBe(expect_["has_any_function"] === true)
  for (const name of strings(expect_["augmented_components"]) ?? []) expect(Object.keys(bundledComponents), `${name} in components`).toContain(name)
  for (const name of strings(expect_["absent_components"]) ?? []) expect(Object.keys(bundledComponents), `${name} absent`).not.toContain(name)
  for (const ref of strings(expect_["any_component_references"]) ?? []) expect(refs).toContain(ref)
  for (const name of strings(expect_["absent_any_component_references"]) ?? [])
    expect(
      refs.some((r) => r.endsWith(`/${name}`)),
      `${name} not in anyComponent`,
    ).toBe(false)
  for (const [name, props] of Object.entries(obj(expect_["component_properties"]))) {
    const actual = obj(obj(obj(doc["components"])[name])["properties"])
    for (const [prop, schema] of Object.entries(obj(props))) {
      expect(actual, `${name}.${prop}`).toHaveProperty([prop])
      for (const [k, v] of Object.entries(obj(schema))) expect(obj(actual[prop])[k], `${name}.${prop}.${k}`).toEqual(v)
    }
  }
  if ("protocol_version" in expect_) expect(String(catalog.protocolVersion)).toBe(expect_["protocol_version"])
}

function checkTransportExpectations(messages: Json[], c: Json, expect_: Json): void {
  const comps = componentsOf(messages)
  if ("create_surface_catalog_id" in expect_) {
    const creates = messages.map((m) => m["createSurface"]).filter(isObject)
    expect(creates).toHaveLength(1)
    expect(creates[0]?.["catalogId"]).toBe(expect_["create_surface_catalog_id"])
  }
  if ("components" in expect_) expect(comps).toEqual(expect_["components"])
  if ("component_types" in expect_) expect(comps.map((x) => x["component"])).toEqual(expect_["component_types"])
  const absent = strOf(expect_["absent_property_on_all_components"])
  if (absent !== undefined) for (const comp of comps) expect(comp).not.toHaveProperty([absent])
  validate(messages, c)
}

const golden = (name: string): unknown => {
  const text = GOLDENS[`./fixtures/golden/${name}`]
  if (text === undefined) throw new Error(`Missing golden ${name}`)
  return JSON.parse(text)
}

describe("A2UI macros conformance (conformance/agent/macros/macros.yaml)", () => {
  it("every case runs or is listed in SKIPPED, and each listed case exists", () => {
    const ids = CASES.map(idOf)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of Object.keys(SKIPPED)) expect(ids).toContain(id)
    expect(ids.length - Object.keys(SKIPPED).length).toBeGreaterThan(0)
  })

  for (const c of CASES) {
    const id = idOf(c)
    const skip = SKIPPED[id]
    if (skip !== undefined) {
      it.skip(`${id} (skipped: ${skip})`, () => {})
      continue
    }
    it(id, () => {
      const expectError = c["expect_error"]
      if (isObject(expectError)) {
        let thrown: unknown
        try {
          const outcome = runCase(c)
          if (outcome.kind === "messages" && outcome.messages.length > 0) validate(outcome.messages, c)
        } catch (error) {
          thrown = error
        }
        expect(thrown).toBeInstanceOf(errorClassOf(expectError["category"]))
        const message = strOf(expectError["message"])
        if (message !== undefined && thrown instanceof Error) expect(thrown.message).toMatch(new RegExp(message, "i"))
        return
      }
      const outcome = runCase(c)
      const goldenName = strOf(c["golden"])
      if (goldenName !== undefined) {
        expect(outcome.kind).toBe("messages")
        const expected = golden(goldenName)
        if (outcome.kind === "messages") {
          expect(outcome.messages).toEqual(expected)
          validate(outcome.messages, c)
        }
      }
      const expect_ = c["expect"]
      if (isObject(expect_)) {
        if (outcome.kind === "catalog") checkCatalogExpectations(outcome.catalog, expect_)
        else if (outcome.kind === "messages") checkTransportExpectations(outcome.messages, c, expect_)
        else throw new Error(`Case ${id} has expectations but no result`)
      }
    })
  }
})
