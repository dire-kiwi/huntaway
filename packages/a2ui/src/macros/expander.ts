// Copyright 2024 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0. Unless required by
// applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language
// governing permissions and limitations under the License.
//
// Ported to TypeScript for Huntaway (HE-77) from A2UI's Python agent SDK at commit 5ff1b05f:
// python/a2ui_agent/src/a2ui/transformers/macros/expander.py (`MacroExpander`). A catalog and message transformer:
// it gives inference formats (Express) catalogs that list the macros, and lowers the macros in the messages a model
// wrote to the components of the transport catalogs, so a renderer needs only those.

import type { CatalogApi } from "@a2ui/web_core/catalog"
import { A2uiCatalogError, A2uiRecursionError, A2uiValidationError } from "@a2ui/web_core/errors"
import type { AgentToRendererMessage } from "@a2ui/web_core/v1_0"
import type { WireComponent } from "../builder/flatten.ts"
import { augmentCatalog, componentNamesOf, declaresCustomCatalogId, DEFAULT_MACRO_CATALOG_ID, macroCatalog } from "./catalogs.ts"
import { applyEnvelopeFields, ENVELOPE_MIXIN_NAMES, getEnvelopeValue, isEnvelopeKey, withBareEnvelopeKeys } from "./envelope.ts"
import type { CustomProperties, EnvelopeKeys } from "./envelope.ts"
import { isJsonObject } from "./coerce.ts"
import { definitionOf, MacroProtocolError, normalizeVersionFamily, toVersionNumber, validateV1MacroName } from "./macro.ts"
import type { AnyMacro, MacroDefinition, MacroVersionFamily } from "./macro.ts"
import { expandMacro } from "./processor.ts"

const MAX_TRACKED_SURFACES = 256
const MAX_DEPTH = 16

/** How the expander reports what it skipped or kept: `debug`, `warn` and `error` are used. */
export type MacroLog = (level: "debug" | "info" | "warn" | "error", message: string) => void

/** What to do when a macro fails to coerce its arguments or to run. */
export type OnError = "passthrough" | "raise"

export interface MacroExpanderOptions {
  /**
   * The base catalog components that stay in the inference catalogs beside the macros; all of them when undefined,
   * none for `[]`.
   */
  readonly passthroughComponents?: ReadonlyArray<string> | undefined
  /**
   * The catalog the macros belong to. Set, a macro expands only where its `@catalogId`, or its surface's default one,
   * is this id: give each of several expanders over one message stream its own. Also the id of `toCatalog()`.
   */
  readonly catalogId?: string | undefined
  /** Transport catalogs whose component names are registered, to resolve mixed-catalog components. */
  readonly baseCatalogs?: ReadonlyArray<CatalogApi> | undefined
  /** The protocol version this expander is bound to (`"1.0"`). */
  readonly protocolVersion?: string | undefined
  /**
   * `"passthrough"` (the default) logs a macro that fails and keeps its component unexpanded, so its siblings still
   * expand; `"raise"` throws `A2uiValidationError`, for a retry loop that shows the model its mistake. Protocol,
   * catalog and recursion errors are always thrown.
   */
  readonly onError?: OnError | undefined
  /**
   * How lowered v1.0 components spell their envelope fields: `"at"` (the default, as Python and the spec at the port's
   * commit: `@catalogId`, `@accessibility`, `@metadata`, `@checks`) or `"bare"` (`catalogId`…), which the published
   * `@a2ui/web_core` 0.15 and `@a2ui/agent` 0.1 read: their renderer and `validatePayload` refuse the `@` keys.
   * Either is read on input.
   */
  readonly envelopeKeys?: EnvelopeKeys | undefined
  readonly log?: MacroLog | undefined
}

export interface TransformToTransportOptions {
  /**
   * The default catalog of each surface, by surface id (`null` for a v1.0 surface with none). Given, the messages'
   * `createSurface` and `deleteSurface` update a copy of it, not the expander's own record of surfaces: so one
   * expander can serve several sessions.
   */
  readonly surfaceCatalogs?: Readonly<Record<string, string | null>> | undefined
}

/** The surface a list of components is lowered on. */
interface SurfaceScope {
  readonly surfaceId: string | undefined
  readonly surfaceCatalogId: string | undefined
  readonly transportSurfaceCatalogId: string | undefined
  readonly surfaceKnown: boolean
  readonly protocolVersion: string | undefined
}

/**
 * A message of any protocol version: what `transformToTransport` reads. Those it lowers come back as v1.0
 * `AgentToRendererMessage`s, checked against the v1.0 message schema; the others come back as they are.
 */
export type MessageLike = { readonly version?: unknown }

const BODY_KEYS = ["surfaceUpdate", "createSurface", "updateComponents"] as const

const isV10Version = (version: string | undefined): boolean => version === "1.0"

const isStackOverflow = (error: unknown): boolean => error instanceof RangeError && /call stack/i.test(error.message)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** A v1.0 message whose body `transformToTransport` lowered (a `createSurface` or an `updateComponents`). */
const isLoweredMessage = (dict: Readonly<Record<string, unknown>>): dict is AgentToRendererMessage => {
  if (dict["version"] !== "1.0") return false
  const create = dict["createSurface"]
  const update = dict["updateComponents"]
  if (create !== undefined) return update === undefined && isJsonObject(create) && typeof create["surfaceId"] === "string"
  return isJsonObject(update) && typeof update["surfaceId"] === "string" && Array.isArray(update["components"])
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Expands macro components into the primitive components of the transport catalogs.
 *
 * 1. `transformCatalogs` turns transport catalogs into inference catalogs: in v1.0 it registers them and adds the
 *    macros as a standalone catalog beside them (or into the one whose id is `catalogId`).
 * 2. `transformToInferenceCatalog` adds the macros to one base catalog.
 * 3. `transformToTransport` lowers the macros in outbound messages to flat primitive components.
 * 4. `transformToInference` passes transport messages through untouched.
 *
 * It records the surfaces `createSurface` makes (up to 256), so keep one per session, or pass `surfaceCatalogs`.
 */
export class MacroExpander {
  readonly macros: ReadonlyArray<MacroDefinition>
  readonly onError: OnError
  readonly passthroughComponents: ReadonlySet<string> | undefined
  readonly catalogId: string | undefined
  readonly envelopeKeys: EnvelopeKeys
  private readonly byName: ReadonlyMap<string, MacroDefinition>
  private readonly explicitProtocolVersion: string | undefined
  private targetFamily: MacroVersionFamily | undefined
  private readonly baseComponents = new Map<string, Set<string>>()
  private readonly catalogDocs = new Map<string, Record<string, unknown>>()
  private readonly registeredBaseCatalogIds: string[] = []
  private readonly surfaces = new Map<string, string | null>()
  private readonly log: MacroLog

  constructor(macros: ReadonlyArray<AnyMacro> = [], options: MacroExpanderOptions = {}) {
    const onError = options.onError ?? "passthrough"
    if (onError !== "passthrough" && onError !== "raise") throw new TypeError(`Invalid onError policy '${String(onError)}'; expected 'passthrough' or 'raise'.`)
    this.onError = onError
    this.log = options.log ?? (() => {})
    this.macros = macros.map(definitionOf)
    this.explicitProtocolVersion = options.protocolVersion === undefined ? undefined : toVersionNumber(options.protocolVersion)
    const families = new Set<MacroVersionFamily>(this.macros.map((m) => m.targetVersion))
    if (this.explicitProtocolVersion !== undefined) families.add(normalizeVersionFamily(this.explicitProtocolVersion))
    if (families.size > 1) throw new MacroProtocolError("MacroExpander cannot mix A2UI v0.9 and v1.0 macros or protocol versions.")
    this.targetFamily = [...families][0]
    if (this.targetFamily === "1.0") for (const m of this.macros) validateV1MacroName(m.name)
    this.byName = new Map(this.macros.map((m) => [m.name, m]))
    this.passthroughComponents = options.passthroughComponents === undefined ? undefined : new Set(options.passthroughComponents)
    this.catalogId = options.catalogId
    this.envelopeKeys = options.envelopeKeys ?? "at"
    if (this.catalogId !== undefined) this.baseComponents.set(this.catalogId, new Set())
    for (const catalog of options.baseCatalogs ?? []) this.registerCatalog(catalog)
  }

  /** The id of the standalone macro catalog: `catalogId`, or `https://a2ui.org/catalogs/macros`. */
  get macroCatalogId(): string {
    return this.catalogId ?? DEFAULT_MACRO_CATALOG_ID
  }

  /** Records a transport catalog's component names, without touching the protocol version. */
  private registerBaseComponents(catalog: CatalogApi): void {
    if (!catalog.id) return
    const doc = catalog.toJson()
    this.baseComponents.set(catalog.id, componentNamesOf(doc))
    this.catalogDocs.set(catalog.id, doc)
    if (!this.registeredBaseCatalogIds.includes(catalog.id)) this.registeredBaseCatalogIds.push(catalog.id)
  }

  /**
   * Registers a base catalog's component names, to scope mixed-catalog components.
   *
   * @throws {A2uiValidationError} If its protocol version differs from the expander's.
   */
  registerCatalog(catalog: CatalogApi): void {
    const version = String(catalog.protocolVersion)
    if (version) {
      const family = normalizeVersionFamily(version)
      if (this.targetFamily !== undefined && this.targetFamily !== family) {
        throw new MacroProtocolError(`Cannot register v${version} catalog with v${this.targetFamily} MacroExpander.`)
      }
      if (this.targetFamily === undefined) {
        if (family === "1.0") for (const m of this.macros) validateV1MacroName(m.name)
        this.targetFamily = family
      }
    }
    this.registerBaseComponents(catalog)
  }

  /**
   * Turns transport catalogs into inference catalogs for the prompt and the parser, and registers them. In v1.0 the
   * base catalogs are kept (cut to `passthroughComponents`) and `toCatalog()` is added beside them, unless one of them
   * has the expander's `catalogId`, which then gets the macros; v0.9 takes one catalog and adds the macros to it.
   */
  transformCatalogs(catalogs: ReadonlyArray<CatalogApi>): CatalogApi[] {
    for (const catalog of catalogs) this.registerCatalog(catalog)
    if (catalogs.length === 0) return this.macros.length > 0 ? [this.toCatalog()] : []
    if (this.targetFamily === "1.0") {
      const matching = this.catalogId !== undefined && catalogs.some((c) => c.id === this.catalogId)
      const passthrough = this.passthroughComponents
      const out = catalogs.map((c) => {
        if (matching && c.id === this.catalogId) return this.transformToInferenceCatalog(c)
        if (passthrough === undefined) return c
        return c.withEntries(
          [...c.components.values()].filter((entry) => passthrough.has(entry.name)),
          [...c.functions.values()],
        )
      })
      if (!matching && this.macros.length > 0) out.push(this.toCatalog())
      return out
    }
    const [only] = catalogs
    if (catalogs.length !== 1 || only === undefined) throw new A2uiCatalogError("A2UI v0.9 supports only a single catalog per surface.")
    return [this.transformToInferenceCatalog(only)]
  }

  /**
   * An inference catalog: `base` with the macros' schemas added (and its own components cut to
   * `passthroughComponents`). Registers `base`'s component names.
   *
   * @throws {A2uiCatalogError} If a macro has the name of a component the catalog keeps.
   * @throws {A2uiValidationError} If the versions differ or a v1.0 macro name is invalid.
   */
  transformToInferenceCatalog(base: CatalogApi): CatalogApi {
    const version = String(base.protocolVersion)
    const family = version ? normalizeVersionFamily(version) : undefined
    if (this.targetFamily !== undefined && family !== undefined && this.targetFamily !== family) {
      throw new MacroProtocolError(`Cannot augment v${version} catalog with v${this.targetFamily} macros.`)
    }
    const isV10 = family === "1.0"
    if (isV10) for (const m of this.macros) validateV1MacroName(m.name)
    const augmented = augmentCatalog(base, this.macros, this.passthroughComponents, isV10)
    this.registerBaseComponents(base)
    return augmented
  }

  /**
   * A standalone catalog of the macros only, of the expander's `macroCatalogId`. Its version is the expander's
   * `protocolVersion`, else 1.0 when it has macros or v1.0 catalogs, else 0.9.1 (as Python's).
   */
  toCatalog(): CatalogApi {
    const version = this.explicitProtocolVersion ?? (this.targetFamily === "1.0" ? "1.0" : "0.9.1")
    const isV10 = normalizeVersionFamily(version) === "1.0"
    if (isV10) for (const m of this.macros) validateV1MacroName(m.name)
    return macroCatalog(this.macros, this.macroCatalogId, version, isV10)
  }

  /** Passes transport messages through untouched. */
  transformToInference(messages: ReadonlyArray<AgentToRendererMessage>): AgentToRendererMessage[] {
    return [...messages]
  }

  /** Whether `cid` is this expander's macro catalog rather than a transport catalog. */
  private isPureMacroSidecarId(cid: string | undefined): boolean {
    return cid !== undefined && cid !== "" && cid === this.macroCatalogId && !this.registeredBaseCatalogIds.includes(cid)
  }

  /** The (inference, transport) default catalog ids of a surface whose default is `cid`. */
  private resolveSurfaceCatalogPair(cid: string | null | undefined, isV10: boolean, rewriteCreateSurface: boolean): [string | undefined, string | undefined] {
    const norm = typeof cid === "string" && cid !== "" ? cid : undefined
    if (isV10 && this.isPureMacroSidecarId(norm)) {
      const [only] = this.registeredBaseCatalogIds
      if (only === undefined) {
        if (rewriteCreateSurface) {
          throw new A2uiCatalogError(
            `Surface default catalogId '${norm ?? ""}' is a standalone macro catalog, and no base catalogs are registered on MacroExpander to resolve a transport catalog.`,
          )
        }
        return [norm, undefined]
      }
      return [norm, this.registeredBaseCatalogIds.length === 1 ? only : undefined]
    }
    return [norm, norm]
  }

  private ownersOf(name: string): string[] {
    return this.registeredBaseCatalogIds.filter((cid) => this.baseComponents.get(cid)?.has(name) === true)
  }

  private inAnyBaseCatalog(name: string): boolean {
    for (const names of this.baseComponents.values()) if (names.has(name)) return true
    return false
  }

  /** Stamps the unique owning catalog of each unannotated lowered v1.0 primitive, from the registered base catalogs. */
  private stampLoweredPrimitives(primitives: WireComponent[], scope: SurfaceScope): void {
    if (!isV10Version(scope.protocolVersion) || !scope.surfaceKnown || this.registeredBaseCatalogIds.length === 0) return
    const transport = scope.transportSurfaceCatalogId
    const surface = scope.surfaceId ?? "None"
    for (const prim of primitives) {
      const name = prim["component"]
      if (typeof name !== "string") continue
      // A macro kept unexpanded (passthrough) is left for the renderer to refuse.
      if (this.onError === "passthrough" && this.byName.has(name) && !this.inAnyBaseCatalog(name)) continue
      const owners = this.ownersOf(name)
      const customCatalogId =
        owners.length > 0 &&
        owners.every((cid) => {
          const doc = this.catalogDocs.get(cid)
          return doc !== undefined && declaresCustomCatalogId(doc, name)
        })
      const custom: CustomProperties = new Set(customCatalogId ? ["catalogId"] : [])
      const existing = getEnvelopeValue(prim, "catalogId", true, custom)
      if (existing !== undefined && existing !== null) continue
      const stamp = (where: string): void => {
        const [owner] = owners
        if (owners.length === 1 && owner !== undefined) prim[this.envelopeKeys === "at" ? "@catalogId" : "catalogId"] = owner
        else if (owners.length > 1) {
          throw new A2uiCatalogError(
            `Expanded component '${name}' has no catalogId on ${where} and is defined in multiple base catalogs: ${JSON.stringify(owners)}. Set catalogId explicitly on the builder node.`,
          )
        } else {
          throw new A2uiCatalogError(
            `Expanded component '${name}' has no catalogId on ${where} and is not found in any registered base catalog: ${JSON.stringify(this.registeredBaseCatalogIds)}.`,
          )
        }
      }
      if (transport === undefined) stamp(`defaultless surface '${surface}'`)
      else if (this.registeredBaseCatalogIds.includes(transport) && this.baseComponents.get(transport)?.has(name) !== true) {
        stamp(`surface '${surface}' (default '${transport}')`)
      }
    }
  }

  /**
   * Lowers outbound messages: the macro components of `createSurface`, `updateComponents` (and v0.9's
   * `surfaceUpdate`) are expanded into flat primitive components. Messages without macros come back as they are.
   *
   * @throws {A2uiValidationError} If a message's version is not the expander's, or (with `onError: "raise"`) a macro
   *   fails; `A2uiRecursionError` past 16 levels of nested macros; `A2uiCatalogError` when a lowered component's
   *   catalog cannot be resolved.
   */
  transformToTransport<M extends MessageLike = AgentToRendererMessage>(
    messages: ReadonlyArray<M>,
    options: TransformToTransportOptions = {},
  ): Array<M | AgentToRendererMessage> {
    if (this.macros.length === 0 && this.targetFamily === undefined) return [...messages]
    const given = options.surfaceCatalogs
    const active: Map<string, string | null> = given === undefined ? this.surfaces : new Map(Object.entries(given))

    const result: Array<M | AgentToRendererMessage> = []
    for (const msg of messages) {
      const dict: Record<string, unknown> = { ...msg }
      const rawVersion = dict["version"]
      const protocolVersion = typeof rawVersion === "string" ? toVersionNumber(rawVersion) : undefined
      const isV10 = isV10Version(protocolVersion)
      if (protocolVersion !== undefined) {
        const family = normalizeVersionFamily(protocolVersion)
        if (this.targetFamily !== undefined && this.targetFamily !== family) {
          throw new MacroProtocolError(`Cannot lower v${protocolVersion} message envelope with v${this.targetFamily} MacroExpander.`)
        }
      }
      if (this.macros.length === 0) {
        result.push(msg)
        continue
      }
      const deleted = dict["deleteSurface"]
      if (isJsonObject(deleted) && typeof deleted["surfaceId"] === "string") active.delete(deleted["surfaceId"])

      let modified = false
      for (const bodyKey of BODY_KEYS) {
        const bodyValue = dict[bodyKey]
        if (!isJsonObject(bodyValue)) continue
        const body: Record<string, unknown> = { ...bodyValue }
        let bodyModified = false
        const surfaceIdValue = body["surfaceId"]
        const surfaceId = typeof surfaceIdValue === "string" ? surfaceIdValue : undefined
        if (bodyKey === "createSurface" && surfaceId !== undefined) {
          const cidValue = body["catalogId"]
          const cid = typeof cidValue === "string" ? cidValue : undefined
          const [inference, transport] = this.resolveSurfaceCatalogPair(cid, isV10, true)
          if (transport !== (cid ? cid : undefined)) {
            if (transport !== undefined) body["catalogId"] = transport
            else delete body["catalogId"]
            bodyModified = true
          }
          active.delete(surfaceId)
          active.set(surfaceId, inference ?? null)
          if (active.size > MAX_TRACKED_SURFACES) {
            const [oldest] = active.keys()
            if (oldest !== undefined) {
              active.delete(oldest)
              this.log("warn", `Evicted oldest tracked surface '${oldest}' from MacroExpander (limit=${MAX_TRACKED_SURFACES})`)
            }
          }
        }

        const known = surfaceId !== undefined && active.has(surfaceId)
        const [surfaceCatalogId, transportSurfaceCatalogId] = known
          ? this.resolveSurfaceCatalogPair(active.get(surfaceId), isV10, false)
          : [undefined, undefined]
        const comps = body["components"]
        if (Array.isArray(comps) && comps.length > 0) {
          body["components"] = this.expandComponentList(
            comps,
            { surfaceId, surfaceCatalogId, transportSurfaceCatalogId, surfaceKnown: known, protocolVersion },
            0,
            new Set(),
            undefined,
          )
          bodyModified = true
        }
        if (bodyModified) {
          dict[bodyKey] = body
          modified = true
        }
      }
      result.push(modified ? this.revalidate(dict) : msg)
    }
    return result
  }

  /**
   * A lowered message. Python validates it again as its message model; here the message was one already, and lowering
   * changed only its components and `createSurface.catalogId`, so its shape is what is checked.
   */
  private revalidate(dict: Record<string, unknown>): AgentToRendererMessage {
    if (!isLoweredMessage(dict)) throw new A2uiValidationError("A lowered message must be a v1.0 createSurface or updateComponents message.")
    return dict
  }

  /** Whether an unannotated nested component inherits the enclosing macro's catalog. */
  private inheritsEnclosingCatalog(
    name: string,
    depth: number,
    enclosing: string | undefined,
    surfaceCatalogId: string | undefined,
    active: ReadonlySet<string>,
  ): boolean {
    if (depth === 0 || enclosing === undefined) return false
    if (
      surfaceCatalogId !== undefined &&
      surfaceCatalogId !== enclosing &&
      surfaceCatalogId !== this.macroCatalogId &&
      !this.baseComponents.has(surfaceCatalogId)
    ) {
      return false
    }
    if (this.inAnyBaseCatalog(name)) return false
    if (active.has(name) && ![...this.baseComponents.values()].some((names) => names.size > 0)) return false
    return true
  }

  /** The macro a component invokes, with its effective catalog id; undefined when it is left as it is. */
  private resolveMacro(
    comp: WireComponent,
    name: string,
    isV10: boolean,
    scope: SurfaceScope,
    depth: number,
    active: ReadonlySet<string>,
    enclosing: string | undefined,
  ): { readonly meta: MacroDefinition; readonly effectiveCatalogId: string | undefined } | undefined {
    const meta = this.byName.get(name)
    if (meta === undefined) return undefined
    const rawCid = getEnvelopeValue(comp, "catalogId", isV10, meta.parameters)
    const hasCid = rawCid !== undefined && rawCid !== null
    let effective: string | undefined
    if (hasCid) {
      if (typeof rawCid !== "string" || rawCid === "") {
        this.log("warn", `Skipping macro '${name}' on component '${String(comp["id"])}': invalid catalogId ${JSON.stringify(rawCid)}`)
        return undefined
      }
      effective = rawCid
    } else if (this.inheritsEnclosingCatalog(name, depth, enclosing, scope.surfaceCatalogId, active)) effective = enclosing
    else effective = scope.surfaceCatalogId

    if (depth > 0 && !hasCid && this.inAnyBaseCatalog(name)) return undefined

    if (active.has(name)) {
      const isBasePrimitive =
        effective !== enclosing ||
        (effective !== undefined && this.baseComponents.get(effective)?.has(name) === true) ||
        (!hasCid && this.inAnyBaseCatalog(name))
      if (isBasePrimitive) return undefined
    }

    if (this.catalogId !== undefined) {
      if (effective !== this.catalogId) {
        if (!hasCid && !scope.surfaceKnown && depth === 0) {
          this.log(
            "debug",
            `Skipping scoped macro '${name}' on component '${String(comp["id"])}': surface '${scope.surfaceId ?? "None"}' has no known catalogId (expected '${this.catalogId}')`,
          )
        }
        return undefined
      }
    } else if (this.baseComponents.size > 0 && effective !== undefined) {
      if (!this.baseComponents.has(effective) && effective !== this.macroCatalogId) return undefined
      if (this.baseComponents.get(effective)?.has(name) === true && (this.passthroughComponents === undefined || this.passthroughComponents.has(name))) {
        return undefined
      }
    }
    return { meta, effectiveCatalogId: effective }
  }

  /** The arguments of a macro instance: its keys other than `component`, `id` and the envelope fields. */
  private argumentsOf(comp: WireComponent, meta: MacroDefinition, isV10: boolean): Record<string, unknown> {
    const declared = meta.parameters
    const nested = comp["parameters"]
    if (!declared.has("parameters") && isJsonObject(nested)) {
      const params: Record<string, unknown> = { ...nested }
      for (const key of ENVELOPE_MIXIN_NAMES) {
        if (declared.has(key) && comp[key] !== undefined && comp[key] !== null && !(key in params)) params[key] = comp[key]
      }
      return params
    }
    const excluded = declared.has("parameters") ? ["component", "id"] : ["component", "id", "parameters"]
    return Object.fromEntries(Object.entries(comp).filter(([k]) => !excluded.includes(k) && !isEnvelopeKey(k, isV10, declared)))
  }

  /** Expands the macro components of a flat component list, recursively. */
  private expandComponentList(
    components: ReadonlyArray<unknown>,
    scope: SurfaceScope,
    depth: number,
    active: ReadonlySet<string>,
    enclosing: string | undefined,
  ): unknown[] {
    if (depth > MAX_DEPTH) throw new A2uiRecursionError(`Macro expansion exceeded maximum recursion depth of ${MAX_DEPTH}.`)
    const isV10 = isV10Version(scope.protocolVersion)
    const expanded: unknown[] = []
    for (const comp of components) {
      if (!isJsonObject(comp)) {
        expanded.push(comp)
        continue
      }
      const name = comp["component"]
      const resolved = typeof name === "string" ? this.resolveMacro(comp, name, isV10, scope, depth, active, enclosing) : undefined
      if (resolved === undefined || typeof name !== "string") {
        expanded.push(comp)
        continue
      }
      const { meta, effectiveCatalogId } = resolved
      const idValue = comp["id"]
      const instanceId = typeof idValue === "string" ? idValue : undefined
      let sub: unknown[]
      try {
        const flat = expandMacro(meta, this.argumentsOf(comp, meta, isV10), instanceId, scope.protocolVersion, this.targetFamily)
        const atKeys = isV10 && this.envelopeKeys === "at"
        const lowered = atKeys || !isV10 ? flat : flat.map(withBareEnvelopeKeys)
        applyEnvelopeFields(comp, meta.parameters, lowered, instanceId, isV10, atKeys)
        sub = this.expandComponentList(lowered, scope, depth + 1, new Set([...active, name]), effectiveCatalogId ?? this.catalogId)
      } catch (error) {
        if (error instanceof A2uiRecursionError || isStackOverflow(error)) {
          throw new A2uiRecursionError(`Macro expansion exceeded maximum recursion depth of ${MAX_DEPTH}.`)
        }
        if (error instanceof MacroProtocolError || error instanceof A2uiCatalogError) throw error
        if (this.onError === "raise") {
          if (error instanceof A2uiValidationError) throw error
          throw new A2uiValidationError(`Failed to expand macro '${name}' (id='${instanceId ?? "None"}'): ${errorMessage(error)}`)
        }
        this.log("error", `Failed to expand macro '${name}': ${errorMessage(error)}`)
        expanded.push(comp)
        continue
      }
      // The components a macro lowers to are fresh records of the expander's own, so they are stamped in place.
      if (depth === 0) this.stampLoweredPrimitives(sub.filter(isRecord), scope)
      expanded.push(...sub)
    }
    return expanded
  }
}
