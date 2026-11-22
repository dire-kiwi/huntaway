// Copyright 2024 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0. Unless required by
// applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language
// governing permissions and limitations under the License.
//
// Ported to TypeScript for Huntaway (HE-77) from A2UI's Python agent SDK at commit 5ff1b05f:
// python/a2ui_agent/src/a2ui/builder/core/{id_allocator.py,child.py,flattener.py,tree.py}. Turns a builder tree into the
// flat component list of an `updateComponents` message, with the same ids as Python: children before their parent,
// author ids namespaced as `<prefix>__<id>`, the others `<prefix>__<component lowercased>_<n>`.

import { ComponentNode, ComponentRef, isWireModel } from "./models.ts"
import type { Child } from "./models.ts"

/** A flat wire component: `component`, `id`, then its envelope fields and properties. */
export type WireComponent = Record<string, unknown>

/** Deterministic allocator of scoped component ids. */
export class IdAllocator {
  readonly scopePrefix: string
  readonly existingIds: Set<string>
  private readonly counters = new Map<string, number>()
  constructor(scopePrefix = "c", existingIds?: Iterable<string>) {
    this.scopePrefix = scopePrefix
    this.existingIds = new Set(existingIds)
  }
  allocate(componentName: string, preferredId?: string): string {
    if (preferredId) {
      const candidate = `${this.scopePrefix}__${preferredId}`
      this.existingIds.add(candidate)
      return candidate
    }
    const prefix = componentName.toLowerCase()
    for (;;) {
      const n = (this.counters.get(prefix) ?? 0) + 1
      this.counters.set(prefix, n)
      const candidate = `${this.scopePrefix}__${prefix}_${n}`
      if (!this.existingIds.has(candidate)) {
        this.existingIds.add(candidate)
        return candidate
      }
    }
  }
}

/** State of one pass of a two-pass flatten: the scan reserves author ids, the emit pass allocates and writes. */
interface FlattenContext {
  readonly prefix: string
  readonly allocator: IdAllocator | undefined
  readonly reserved: Set<string>
  readonly components: WireComponent[]
  readonly assigned: Map<ComponentNode, string>
  readonly visited: Set<ComponentNode>
}

const context = (prefix: string, allocator?: IdAllocator, reserved = new Set<string>()): FlattenContext => ({
  prefix,
  allocator,
  reserved,
  components: [],
  assigned: new Map(),
  visited: new Set(),
})

/** Writes a property value, emitting the nested components it holds and writing each as its id. */
const serializeValue = (value: unknown, ctx: FlattenContext): unknown => {
  if (value instanceof ComponentNode || value instanceof ComponentRef) return emitComponent(value, ctx)
  if (isWireModel(value)) return value.toWire((v) => serializeValue(v, ctx))
  if (Array.isArray(value)) return value.map((v: unknown) => serializeValue(v, ctx))
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = serializeValue(v, ctx)
    return out
  }
  return value
}

/** Writes one component, `component` and `id` first; its descendants are emitted on the way. */
const dumpComponent = (node: ComponentNode, componentId: string, ctx: FlattenContext): WireComponent => {
  const out: WireComponent = { component: node.component, id: componentId }
  if (node.catalogId !== undefined) out["@catalogId"] = node.catalogId
  if (node.accessibility !== undefined) out["@accessibility"] = serializeValue(node.accessibility, ctx)
  if (node.extensions !== undefined) out["@metadata"] = { extensions: serializeValue(node.extensions, ctx) }
  for (const [key, value] of Object.entries(node.props)) {
    if (value !== undefined && value !== null) out[key] = serializeValue(value, ctx)
  }
  return out
}

/**
 * Resolves a node to its wire id, emitting its subtree in the emit pass. Children are emitted before their parent, so
 * the list is in depth-first post-order and every reference points at a component already in it.
 */
const emitComponent = (node: Child, ctx: FlattenContext): string => {
  // A slot boundary: the component is already on the surface and keeps its address.
  if (node instanceof ComponentRef) return node.id
  if (ctx.allocator === undefined) {
    if (ctx.visited.has(node)) return node.id ?? ""
    ctx.visited.add(node)
    if (node.id) {
      // Both the bare and the namespaced form: an author's id is never handed out again.
      ctx.reserved.add(node.id)
      ctx.reserved.add(`${ctx.prefix}__${node.id}`)
    }
    dumpComponent(node, node.id ?? "", ctx)
    return node.id ?? ""
  }
  // The same node in two slots is one component, referenced twice.
  const assigned = ctx.assigned.get(node)
  if (assigned !== undefined) return assigned
  const allocated = ctx.allocator.allocate(node.component, node.id)
  ctx.assigned.set(node, allocated)
  ctx.components.push(dumpComponent(node, allocated, ctx))
  return allocated
}

const isRootList = (root: Child | ReadonlyArray<Child>): root is ReadonlyArray<Child> => Array.isArray(root)

/**
 * Flattens a builder tree (or a list of roots, each in its own scope `<rootId>_<index>`) into post-order wire
 * components. The root takes `rootId` (or its own id, or an allocated one) and the ids under it are prefixed with it.
 */
export function flattenComponentTree(root: Child | ReadonlyArray<Child>, rootId?: string): WireComponent[] {
  if (isRootList(root)) return root.flatMap((item, index) => flattenComponentTree(item, rootId ? `${rootId}_${index}` : undefined))
  if (root instanceof ComponentRef) return []
  const prefix = rootId || root.id || "root"
  // Pass 1: reserve the author's ids so that allocation cannot collide with one.
  const scan = context(prefix)
  emitComponent(root, scan)
  const reserved = scan.reserved
  if (rootId) reserved.add(rootId)
  // Pass 2: allocate and emit.
  const allocator = new IdAllocator(prefix, reserved)
  const emit = context(prefix, allocator, reserved)
  const resolvedRootId = rootId || root.id || allocator.allocate(root.component)
  emit.assigned.set(root, resolvedRootId)
  // The root's descendants are emitted while it is written, so it lands last.
  const payload = dumpComponent(root, resolvedRootId, emit)
  emit.components.push(payload)
  return emit.components
}

/** A root node and an optional surface id, flattened as one tree whose root is `root` (or the node's own id). */
export class ComponentTree {
  readonly root: ComponentNode
  readonly surfaceId: string | undefined
  constructor(root: ComponentNode, surfaceId?: string) {
    this.root = root
    this.surfaceId = surfaceId
  }
  flatten(): WireComponent[] {
    return flattenComponentTree(this.root, this.root.id || "root")
  }
}
