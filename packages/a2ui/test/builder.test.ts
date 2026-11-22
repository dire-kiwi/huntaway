import { describe, expect, it } from "@effect/vitest"
import {
  AccessibilityAttributes,
  Action,
  Button,
  Card,
  catalogNodes,
  CheckRule,
  Column,
  ComponentRef,
  ComponentTree,
  DataBinding,
  DynamicChildList,
  flattenComponentTree,
  IdAllocator,
  List,
  Required,
  Text,
  TextField,
} from "../src/builder/index.ts"

describe("flattenComponentTree", () => {
  it("emits children before their parent, ids allocated in pre-order under the root's id", () => {
    const tree = Card({ child: Column({ children: [Text({ text: "a" }), Button({ child: Text({ text: "b" }), action: Action.event("go") })] }) })
    expect(flattenComponentTree(tree, "r")).toEqual([
      { component: "Text", id: "r__text_1", text: "a", variant: "body" },
      { component: "Text", id: "r__text_2", text: "b", variant: "body" },
      { component: "Button", id: "r__button_1", child: "r__text_2", variant: "default", action: { event: { name: "go" } } },
      { component: "Column", id: "r__column_1", children: ["r__text_1", "r__button_1"], justify: "start", align: "stretch" },
      { component: "Card", id: "r", child: "r__column_1" },
    ])
  })

  it("keeps a reference's id, namespaces an author's id, and emits a node in two slots once", () => {
    const shared = Text({ text: "shared", id: "label" })
    const tree = Column({ children: [shared, new ComponentRef("outside"), shared] })
    expect(flattenComponentTree(tree, "r")).toEqual([
      { component: "Text", id: "r__label", text: "shared", variant: "body" },
      { component: "Column", id: "r", children: ["r__label", "outside", "r__label"], justify: "start", align: "stretch" },
    ])
  })

  it("does not hand out an id an author took", () => {
    const allocator = new IdAllocator("p", ["p__text_1"])
    expect(allocator.allocate("Text")).toBe("p__text_2")
    expect(allocator.allocate("Text", "mine")).toBe("p__mine")
  })

  it("writes the v1.0 envelope fields and checks with their @ keys, and templates as {path, componentId}", () => {
    const field = TextField({
      label: "Email",
      value: new DataBinding("/email"),
      checks: [new CheckRule(Required({ value: new DataBinding("/email") }), "Required")],
      accessibility: new AccessibilityAttributes({ label: "Email field" }),
      extensions: { trace: 1 },
      catalogId: "https://example.com/c.json",
    })
    const list = List({ children: new DynamicChildList("/items", new ComponentRef("row")) })
    expect(flattenComponentTree(Column({ children: [field, list] }), "f")).toEqual([
      {
        component: "TextField",
        id: "f__textfield_1",
        "@catalogId": "https://example.com/c.json",
        "@accessibility": { label: "Email field" },
        "@metadata": { extensions: { trace: 1 } },
        label: "Email",
        value: { "@path": "/email" },
        variant: "shortText",
        "@checks": [{ condition: { "@call": "required", args: { value: { "@path": "/email" } } }, message: "Required" }],
      },
      { component: "List", id: "f__list_1", children: { path: "/items", componentId: "row" }, direction: "vertical", align: "stretch" },
      { component: "Column", id: "f", children: ["f__textfield_1", "f__list_1"], justify: "start", align: "stretch" },
    ])
  })

  it("flattens a list of roots each in its own scope, and a tree under `root`", () => {
    expect(flattenComponentTree([Text({ text: "a" }), Text({ text: "b" })], "row").map((c) => c["id"])).toEqual(["row_0", "row_1"])
    expect(new ComponentTree(Card({ child: Text({ text: "x" }) })).flatten().map((c) => c["id"])).toEqual(["root__text_1", "root"])
  })
})

describe("catalogNodes", () => {
  it("stamps the catalog's id on its nodes unless a node names another", () => {
    const foo = catalogNodes("https://example.com/foo.json")
    const Header = foo.define<{ readonly title: string }>("FooHeader", { fields: ["title"] })
    expect(flattenComponentTree(Header({ title: "Hi" }), "h")).toEqual([
      { component: "FooHeader", id: "h", "@catalogId": "https://example.com/foo.json", title: "Hi" },
    ])
    expect(Header({ title: "x", catalogId: "https://example.com/other.json" }).catalogId).toBe("https://example.com/other.json")
    expect(Header.component).toBe("FooHeader")
  })
})
