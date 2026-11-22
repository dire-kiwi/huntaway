import { describe, expect, it } from "@effect/vitest"
import { ExpressFormat, validatePayload } from "@a2ui/agent"
import { A2uiCatalogError, A2uiRecursionError, A2uiValidationError } from "@a2ui/web_core/errors"
import { Action, Button, Card, Column, ComponentRef, DataBinding, flattenComponentTree, Row, Text } from "../src/builder/index.ts"
import { basicCatalog, BASIC_CATALOG_ID } from "../src/catalog.ts"
import { DEFAULT_MACRO_CATALOG_ID, macro, MacroExpander, param, typeSchema } from "../src/macros/index.ts"
import type { MacroLog } from "../src/macros/index.ts"

const ProductCard = macro({
  name: "ProductCard",
  description: "Renders a product showcase card.",
  params: {
    title: param.dynamicString("Display name of the product."),
    price: param.string("Formatted price string."),
    on_buy: param.action("Action triggered when the user clicks buy."),
    in_stock: param.boolean("Whether the item is available.", { default: true }),
  },
  render: ({ title, price, on_buy, in_stock }) =>
    Card({
      child: Column({
        children: [
          Text({ text: title, variant: "body" }),
          Text({ text: price, variant: "caption" }),
          Button({ child: Text({ text: in_stock ? "Buy Now" : "Out of Stock" }), action: on_buy, variant: "primary" }),
        ],
      }),
    }),
})

const StatusBadge = macro({
  name: "StatusBadge",
  params: { status: param.string(), title: param.string() },
  render: ({ status, title }) => Card({ child: Row({ children: [Text({ text: status.toUpperCase(), variant: "caption" }), Text({ text: title })] }) }),
})

const update = (components: ReadonlyArray<Record<string, unknown>>, surfaceId = "main") => ({
  version: "1.0" as const,
  updateComponents: { surfaceId, components: [...components] },
})

const componentsOf = (messages: ReadonlyArray<unknown>): unknown[] =>
  messages.flatMap((m) => {
    if (typeof m !== "object" || m === null) return []
    const body = "updateComponents" in m ? m.updateComponents : "createSurface" in m ? m.createSurface : undefined
    return typeof body === "object" && body !== null && "components" in body && Array.isArray(body.components) ? body.components : []
  })

describe("MacroExpander with ExpressFormat", () => {
  it("lists the macros in the prompt, parses Express that calls one, and lowers it to basic components", () => {
    const expander = new MacroExpander([ProductCard], { envelopeKeys: "bare" })
    const catalogs = expander.transformCatalogs([basicCatalog()])
    expect(catalogs.map((c) => c.id)).toEqual([BASIC_CATALOG_ID, DEFAULT_MACRO_CATALOG_ID])

    const format = new ExpressFormat(catalogs, { surfaceId: "main" })
    const prompt = format.promptGenerator.generate()
    expect(prompt).toContain("ProductCard(")
    expect(prompt).toContain("Renders a product showcase card.")
    expect(prompt).toContain("Display name of the product.")

    const parser = format.createParser()
    const parts = parser.parseResponse(parser.wrap([{ type: "a2ui", a2uiRaw: 'root = ProductCard("Shoes", "$5", Event("buy"))', isFinal: true }]))
    const part = parts.find((p) => p.type === "a2ui")
    if (part?.type !== "a2ui") throw new Error("no A2UI part")

    const transport = expander.transformToTransport(part.a2ui)
    expect(componentsOf(transport)).toEqual([
      { component: "Text", id: "root__text_1", catalogId: BASIC_CATALOG_ID, text: "Shoes", variant: "body" },
      { component: "Text", id: "root__text_2", catalogId: BASIC_CATALOG_ID, text: "$5", variant: "caption" },
      { component: "Text", id: "root__text_3", catalogId: BASIC_CATALOG_ID, text: "Buy Now", variant: "body" },
      { component: "Button", id: "root__button_1", catalogId: BASIC_CATALOG_ID, child: "root__text_3", variant: "primary", action: { event: { name: "buy" } } },
      {
        component: "Column",
        id: "root__column_1",
        catalogId: BASIC_CATALOG_ID,
        children: ["root__text_1", "root__text_2", "root__button_1"],
        justify: "start",
        align: "stretch",
      },
      { component: "Card", id: "root", catalogId: BASIC_CATALOG_ID, child: "root__column_1" },
    ])
    // What a renderer of the basic catalog alone accepts.
    validatePayload([basicCatalog()], transport)
  })

  it("passes a binding through to the lowered components", () => {
    const expander = new MacroExpander([ProductCard], { envelopeKeys: "bare" })
    const format = new ExpressFormat(expander.transformCatalogs([basicCatalog()]), { surfaceId: "main" })
    const parser = format.createParser()
    const [part] = parser.parseResponse(parser.wrap([{ type: "a2ui", a2uiRaw: 'root = ProductCard($/item/name, "$5", Event("buy"), false)', isFinal: true }]))
    if (part?.type !== "a2ui") throw new Error("no A2UI part")
    const transport = expander.transformToTransport(part.a2ui)
    const components = componentsOf(transport)
    expect(components[0]).toMatchObject({ text: { "@path": "/item/name" } })
    expect(components[2]).toMatchObject({ text: "Out of Stock" })
    validatePayload([basicCatalog()], transport)
  })
})

describe("transformToTransport", () => {
  it("expands a macro in place and keeps the other components", () => {
    const expander = new MacroExpander([StatusBadge])
    const [out] = expander.transformToTransport([
      update([
        { id: "t", component: "Text", text: "Hi" },
        { id: "b", component: "StatusBadge", status: "ok", title: "API" },
      ]),
    ])
    expect(componentsOf([out]).map((c) => (typeof c === "object" && c !== null && "id" in c ? c.id : undefined))).toEqual([
      "t",
      "b__text_1",
      "b__text_2",
      "b__row_1",
      "b",
    ])
  })

  it("returns a message without macros as it is", () => {
    const expander = new MacroExpander([StatusBadge])
    const message = update([{ id: "t", component: "Text", text: "Hi" }])
    expect(expander.transformToTransport([message])[0]).toEqual(message)
    expect(expander.transformToInference([message])).toEqual([message])
  })

  it("keeps a macro that fails, and logs it, when onError is passthrough", () => {
    const logged: Array<[string, string]> = []
    const log: MacroLog = (level, message) => logged.push([level, message])
    const expander = new MacroExpander([StatusBadge], { log })
    const bad = { id: "b", component: "StatusBadge", status: "ok" }
    expect(componentsOf(expander.transformToTransport([update([bad])]))).toEqual([bad])
    expect(logged).toEqual([["error", "Failed to expand macro 'StatusBadge': Macro 'StatusBadge' is missing the required argument 'title'."]])
  })

  it("throws A2uiValidationError for a failing macro when onError is raise", () => {
    const expander = new MacroExpander([StatusBadge], { onError: "raise" })
    expect(() => expander.transformToTransport([update([{ id: "b", component: "StatusBadge", status: 3, title: "x" }])])).toThrow(A2uiValidationError)
  })

  it("refuses a v0.8 envelope", () => {
    const expander = new MacroExpander([StatusBadge])
    expect(() => expander.transformToTransport([{ version: "v0.8", surfaceUpdate: { surfaceId: "s", components: [] } }])).toThrow(A2uiValidationError)
  })

  it("throws A2uiRecursionError for a macro that renders itself (suite case 09, under v1.0)", () => {
    const Recursive = macro({
      name: "RecursiveCard",
      params: { title: param.string() },
      render: ({ title }): ReturnType<typeof Card> => Card({ child: Recursive({ title }) }),
    })
    const expander = new MacroExpander([Recursive])
    expect(() => expander.transformToTransport([update([{ id: "r", component: "RecursiveCard", title: "x" }])])).toThrow(A2uiRecursionError)
  })

  it("stops recording surfaces at 256, evicting the oldest with a warning", () => {
    const logged: string[] = []
    const expander = new MacroExpander([StatusBadge], { log: (level, message) => logged.push(`${level}: ${message}`) })
    const creates = Array.from({ length: 257 }, (_, i) => ({ version: "1.0" as const, createSurface: { surfaceId: `s${i}`, catalogId: BASIC_CATALOG_ID } }))
    expander.transformToTransport(creates)
    expect(logged).toEqual(["warn: Evicted oldest tracked surface 's0' from MacroExpander (limit=256)"])
  })

  it("reads per-call surface catalogs without recording them", () => {
    const expander = new MacroExpander([StatusBadge], { catalogId: "https://example.com/m.json" })
    const message = update([{ id: "b", component: "StatusBadge", status: "ok", title: "x" }], "s")
    expect(componentsOf(expander.transformToTransport([message]))).toHaveLength(1)
    expect(componentsOf(expander.transformToTransport([message], { surfaceCatalogs: { s: "https://example.com/m.json" } }))).toHaveLength(4)
    expect(componentsOf(expander.transformToTransport([message]))).toHaveLength(1)
  })
})

describe("inference catalogs", () => {
  it("adds the macros to a v1.0 catalog, cut to passthroughComponents (suite cases 17 and 18, on v1.0)", () => {
    const keep = new MacroExpander([StatusBadge], { passthroughComponents: ["Text"] }).transformToInferenceCatalog(basicCatalog())
    expect([...keep.components.keys()].toSorted()).toEqual(["StatusBadge", "Text"])
    const refs = JSON.stringify(keep.toJson()["$defs"])
    expect(refs).toContain("#/components/StatusBadge")
    expect(refs).not.toContain("#/components/Card")
    const none = new MacroExpander([StatusBadge], { passthroughComponents: [] }).transformToInferenceCatalog(basicCatalog())
    expect([...none.components.keys()]).toEqual(["StatusBadge"])
  })

  it("prunes the base catalogs and adds the macro catalog beside them", () => {
    const catalogs = new MacroExpander([StatusBadge], { passthroughComponents: ["Text", "Row"] }).transformCatalogs([basicCatalog()])
    expect(catalogs.map((c) => [...c.components.keys()].toSorted())).toEqual([["Row", "Text"], ["StatusBadge"]])
  })

  it("refuses a macro named as a basic component (suite case 10, on v1.0)", () => {
    const Collides = macro({ name: "Text", params: {}, render: () => Card({ child: Text({ text: "x" }) }) })
    expect(() => new MacroExpander([Collides]).transformToInferenceCatalog(basicCatalog())).toThrow(A2uiCatalogError)
  })

  it("refuses a reserved or invalid macro name when it is declared", () => {
    expect(() => macro({ name: "Surface", params: {}, render: () => Text({ text: "x" }) })).toThrow(A2uiValidationError)
    expect(() => macro({ name: "no-dash", params: {}, render: () => Text({ text: "x" }) })).toThrow(A2uiValidationError)
  })
})

const schema = (p: { readonly type: Parameters<typeof typeSchema>[0]; readonly description: string | undefined }) => typeSchema(p.type, p.description)

describe("parameter schemas", () => {
  it("maps the README's types as Python does", () => {
    expect(schema(param.string("A name."))).toEqual({ type: "string", description: "A name." })
    expect(schema(param.integer())).toEqual({ type: "integer" })
    expect(schema(param.literal(["a", "b"]))).toEqual({ type: "string", enum: ["a", "b"] })
    expect(schema(param.literal([1, 2]))).toEqual({ type: "number", enum: [1, 2] })
    expect(schema(param.child())).toEqual({ $ref: "common_types.json#/$defs/Child" })
    expect(schema(param.childList())).toEqual({ $ref: "common_types.json#/$defs/ChildList" })
    expect(schema(param.componentList())).toEqual({ $ref: "common_types.json#/$defs/ChildList" })
    expect(schema(param.dynamicChildList())).toEqual({ $ref: "common_types.json#/$defs/ChildList" })
    expect(schema(param.action())).toEqual({ $ref: "common_types.json#/$defs/Action" })
    expect(schema(param.dynamicValue())).toEqual({ $ref: "common_types.json#/$defs/DynamicValue" })
    expect(schema(param.checkRules())).toEqual({ type: "array", items: { $ref: "common_types.json#/$defs/CheckRule" } })
    expect(schema(param.extensions())).toEqual({ $ref: "common_types.json#/$defs/Extensions" })
    expect(schema(param.record())).toEqual({ type: "object" })
    expect(schema(param.record(param.dynamicString()))).toEqual({ type: "object", additionalProperties: { $ref: "common_types.json#/$defs/DynamicString" } })
    expect(schema(param.any("Anything."))).toEqual({ description: "Anything." })
  })

  it("maps unions: dynamic ones to the common types, others to oneOf", () => {
    expect(schema(param.union([param.string(), param.dataBinding(), param.functionCall()]))).toEqual({ $ref: "common_types.json#/$defs/DynamicString" })
    expect(schema(param.union([param.number(), param.integer(), param.dataBinding()]))).toEqual({ $ref: "common_types.json#/$defs/DynamicNumber" })
    expect(schema(param.union([param.componentList(), param.dynamicChildList()]))).toEqual({ $ref: "common_types.json#/$defs/ChildList" })
    expect(schema(param.union([param.literal(["x"]), param.dataBinding()]))).toEqual({
      oneOf: [{ type: "string", enum: ["x"] }, { $ref: "common_types.json#/$defs/DataBinding" }],
    })
  })

  it("maps sub-models to object schemas", () => {
    expect(schema(param.tabItem())).toEqual({
      type: "object",
      properties: { title: { $ref: "common_types.json#/$defs/DynamicString" }, child: { $ref: "common_types.json#/$defs/Child" } },
      required: ["title", "child"],
      additionalProperties: false,
    })
    expect(schema(param.object({ a: param.string("A."), b: param.number(undefined, { optional: true }) }, "Pair.", { closed: false }))).toEqual({
      type: "object",
      properties: { a: { type: "string", description: "A." }, b: { type: "number" } },
      required: ["a"],
      description: "Pair.",
    })
  })

  it("types render's argument from the parameters, and a direct call may leave out those with a default", () => {
    const tree = ProductCard({ title: "Shoes", price: "$5", on_buy: Action.event("buy") })
    expect(flattenComponentTree(tree, "p").at(-2)).toMatchObject({ component: "Column" })
    expect(flattenComponentTree(tree, "p").at(2)).toMatchObject({ text: "Buy Now" })
  })

  it("leaves parameters with a default or optional out of required", () => {
    expect(ProductCard.definition.toJsonSchema({ includeComponentConst: true })["required"]).toEqual(["component", "title", "price", "on_buy"])
  })
})

describe("coercion", () => {
  const Probe = macro({
    name: "Probe",
    params: {
      tabs: param.array(param.tabItem()),
      byName: param.record(param.child()),
      event: param.actionEvent(),
      pick: param.union([param.literal(["a"]), param.dataBinding()]),
    },
    render: ({ tabs, byName, event, pick }) => {
      expect(tabs[0]?.child).toBeInstanceOf(ComponentRef)
      expect(byName["x"]).toEqual(new ComponentRef("x-id"))
      expect(event.name).toBe("go")
      expect(pick).toBeInstanceOf(DataBinding)
      return Text({ text: "ok" })
    },
  })

  it("coerces nested ids, sub-models and union branches", () => {
    const expander = new MacroExpander([Probe], { onError: "raise" })
    const out = expander.transformToTransport([
      update([{ id: "p", component: "Probe", tabs: [{ title: "T", child: "c1" }], byName: { x: "x-id" }, event: { name: "go" }, pick: { "@path": "/p" } }]),
    ])
    expect(componentsOf(out)).toEqual([{ component: "Text", id: "p", text: "ok", variant: "body" }])
  })

  it("refuses a sub-model with an unknown key", () => {
    const expander = new MacroExpander([Probe], { onError: "raise" })
    expect(() =>
      expander.transformToTransport([
        update([{ id: "p", component: "Probe", tabs: [{ title: "T", child: "c1", extra: 1 }], byName: {}, event: { name: "go" }, pick: "a" }]),
      ]),
    ).toThrow(A2uiValidationError)
  })
})
