// Copyright 2024 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0. Unless required by
// applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language
// governing permissions and limitations under the License.
//
// Ported to TypeScript for Huntaway (HE-77) from A2UI's Python agent SDK at commit 5ff1b05f:
// python/a2ui_agent/src/a2ui/builder/core/base_node.py, builder/v1_0/models.py and the v1.0 common types models they
// re-export (python/a2ui_core/src/a2ui/core/schema/v1_0/common_types.py). The builder nodes and the protocol models a
// v1.0 component tree is made of: a node holds its wire properties, and the flattener (flatten.ts) writes them out.

/** Writes a builder value as its wire JSON; the flattener passes one that turns nested components into their ids. */
export type Serialize = (value: unknown) => unknown

/** A builder value that writes itself as wire JSON (the Pydantic models' `model_dump(by_alias=True)`). */
export interface WireModel {
  toWire(serialize: Serialize): Record<string, unknown>
}

const put = (out: Record<string, unknown>, key: string, value: unknown, serialize: Serialize): void => {
  if (value !== undefined && value !== null) out[key] = serialize(value)
}

/** A reference to a value in the data model: `{"@path": path}` on the wire. */
export class DataBinding implements WireModel {
  readonly path: string
  constructor(path: string) {
    this.path = path
  }
  toWire(): Record<string, unknown> {
    return { "@path": this.path }
  }
}

/** A call of a catalog function: `{"@call": name, "args": {…}, "catalogId"?}` on the wire. */
export class FunctionCall implements WireModel {
  readonly call: string
  readonly args: Readonly<Record<string, unknown>> | undefined
  readonly catalogId: string | undefined
  constructor(call: string, args?: Readonly<Record<string, unknown>>, options?: { readonly catalogId?: string | undefined }) {
    this.call = call
    this.args = args
    this.catalogId = options?.catalogId
  }
  toWire(serialize: Serialize): Record<string, unknown> {
    const out: Record<string, unknown> = { "@call": this.call }
    put(out, "args", this.args, serialize)
    put(out, "catalogId", this.catalogId, serialize)
    return out
  }
}

/** A value that is a literal string, or bound or computed. */
export type DynamicString = string | DataBinding | FunctionCall
/** A value that is a literal number, or bound or computed. */
export type DynamicNumber = number | DataBinding | FunctionCall
/** A value that is a literal boolean, or bound or computed. */
export type DynamicBoolean = boolean | DataBinding | FunctionCall
/** A value that is a literal list of strings, or bound or computed. */
export type DynamicStringList = ReadonlyArray<string> | DataBinding | FunctionCall
/** A JSON object with no `@path` or `@call` directive, kept as it is (`LiteralObject`). */
export type LiteralObject = Readonly<Record<string, unknown>>
/** Any value: a literal, a binding or a call. */
export type DynamicValue = string | number | boolean | ReadonlyArray<unknown> | LiteralObject | DataBinding | FunctionCall
/** Vendor extension metadata: keys are Unicode identifiers. */
export type Extensions = Readonly<Record<string, unknown>>

/** The event a button sends the agent. */
export class ActionEvent implements WireModel {
  readonly name: string
  readonly userMessage: DynamicString | undefined
  readonly context: Readonly<Record<string, DynamicValue>> | undefined
  constructor(
    name: string,
    options?: { readonly userMessage?: DynamicString | undefined; readonly context?: Readonly<Record<string, DynamicValue>> | undefined },
  ) {
    this.name = name
    this.userMessage = options?.userMessage
    this.context = options?.context
  }
  toWire(serialize: Serialize): Record<string, unknown> {
    const out: Record<string, unknown> = { name: this.name }
    put(out, "userMessage", this.userMessage, serialize)
    put(out, "context", this.context, serialize)
    return out
  }
}

/** What an interaction does: send an agent `event`, or run a `functionCall` (exactly one of them). */
export class Action implements WireModel {
  readonly event: ActionEvent | undefined
  readonly functionCall: FunctionCall | undefined
  constructor(branch: { readonly event: ActionEvent } | { readonly functionCall: FunctionCall }) {
    this.event = "event" in branch ? branch.event : undefined
    this.functionCall = "functionCall" in branch ? branch.functionCall : undefined
    if ((this.event === undefined) === (this.functionCall === undefined)) throw new TypeError("Action requires exactly one of 'event' or 'functionCall'.")
  }
  /** An action that sends the agent the event `name`. */
  static event(name: string, options?: ConstructorParameters<typeof ActionEvent>[1]): Action {
    return new Action({ event: new ActionEvent(name, options) })
  }
  /** An action that runs `call`. */
  static call(call: FunctionCall): Action {
    return new Action({ functionCall: call })
  }
  toWire(serialize: Serialize): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    put(out, "event", this.event, serialize)
    put(out, "functionCall", this.functionCall, serialize)
    return out
  }
}

/** A check an input component runs: a binding or call that must hold, with an optional message. */
export class CheckRule implements WireModel {
  readonly condition: DataBinding | FunctionCall
  readonly message: string | undefined
  constructor(condition: DataBinding | FunctionCall, message?: string) {
    this.condition = condition
    this.message = message
  }
  toWire(serialize: Serialize): Record<string, unknown> {
    const out: Record<string, unknown> = { condition: serialize(this.condition) }
    put(out, "message", this.message, serialize)
    return out
  }
}

/** How assistive technologies announce a component. */
export type AccessibilityLive = "off" | "polite" | "assertive"

/** Attributes for assistive technologies (`@accessibility` on the wire). */
export class AccessibilityAttributes implements WireModel {
  readonly label: DynamicString | undefined
  readonly description: DynamicString | undefined
  readonly live: AccessibilityLive | undefined
  readonly hidden: DynamicBoolean | undefined
  constructor(attributes: {
    readonly label?: DynamicString | undefined
    readonly description?: DynamicString | undefined
    readonly live?: AccessibilityLive | undefined
    readonly hidden?: DynamicBoolean | undefined
  }) {
    this.label = attributes.label
    this.description = attributes.description
    this.live = attributes.live
    this.hidden = attributes.hidden
  }
  toWire(serialize: Serialize): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    put(out, "label", this.label, serialize)
    put(out, "description", this.description, serialize)
    put(out, "live", this.live, serialize)
    put(out, "hidden", this.hidden, serialize)
    return out
  }
}

/** The envelope fields every v1.0 node takes besides its own properties. */
export interface NodeEnvelope {
  /** The component's id; the flattener namespaces it under the tree's prefix (`<prefix>__<id>`). */
  readonly id?: string | undefined
  /** The catalog the component belongs to (`@catalogId`), overriding the surface's. */
  readonly catalogId?: string | undefined
  readonly accessibility?: AccessibilityAttributes | undefined
  /** Vendor extensions (`@metadata.extensions`). */
  readonly extensions?: Extensions | undefined
}

/**
 * A component of a builder tree: its name, envelope fields and wire properties (in the order they are written). Its
 * nested components are other nodes, which the flattener emits first and writes here as their ids.
 */
export class ComponentNode {
  readonly component: string
  readonly id: string | undefined
  readonly catalogId: string | undefined
  readonly accessibility: AccessibilityAttributes | undefined
  readonly extensions: Extensions | undefined
  /** The component's own properties, keyed as on the wire. */
  readonly props: Readonly<Record<string, unknown>>
  constructor(component: string, props: Readonly<Record<string, unknown>>, envelope: NodeEnvelope = {}) {
    this.component = component
    this.props = props
    this.id = envelope.id
    this.catalogId = envelope.catalogId
    this.accessibility = envelope.accessibility
    this.extensions = envelope.extensions
  }
}

/** A component already on the surface, referenced by `id`: never emitted again or namespaced. */
export class ComponentRef {
  readonly id: string
  constructor(id: string) {
    this.id = id
  }
}

/** A single child slot: a nested component, or a reference to one on the surface. */
export type Child = ComponentNode | ComponentRef

/** Repeats `template` for each item of the data model array at `path` (`{path, componentId}` on the wire). */
export class DynamicChildList implements WireModel {
  readonly path: string
  readonly template: Child
  constructor(path: string, template: Child) {
    this.path = path
    this.template = template
  }
  toWire(serialize: Serialize): Record<string, unknown> {
    return { path: this.path, componentId: serialize(this.template) }
  }
}

/** A children slot: a static list of children, or a template repeated over a data list. */
export type ChildList = ReadonlyArray<Child> | DynamicChildList

/** Whether `value` writes itself as wire JSON. */
export const isWireModel = (value: unknown): value is WireModel =>
  value instanceof DataBinding ||
  value instanceof FunctionCall ||
  value instanceof ActionEvent ||
  value instanceof Action ||
  value instanceof CheckRule ||
  value instanceof AccessibilityAttributes ||
  value instanceof DynamicChildList
