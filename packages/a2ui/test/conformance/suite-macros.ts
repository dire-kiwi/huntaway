// Copyright 2024 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0. Unless required by
// applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language
// governing permissions and limitations under the License.
//
// Ported to TypeScript for Huntaway (HE-77) from A2UI's Python agent SDK at commit 5ff1b05f:
// python/a2ui_agent/tests/conformance/macro_suite.py (the reference macros of conformance/agent/macros/macros.yaml,
// v1.0 and catalog-scoped; the v0.9 ones are not ported). They are written with the builder, as Python's are, rather
// than synthesized from the suite's `template:` ASTs, whose comments name the imperative parts (`status.upper()`…).

import { A2uiValidationError } from "@a2ui/web_core/errors"
import {
  AccessibilityAttributes,
  Action,
  ActionEvent,
  BASIC_CATALOG_V1_0_ID,
  Button,
  Card,
  catalogNodes,
  Column,
  DataBinding,
  defineComponent,
  List,
  Row,
  Text,
  TEXT_VARIANTS,
  TextField,
} from "../../src/builder/index.ts"
import type { ChildList, DynamicString } from "../../src/builder/index.ts"
import { macro, param } from "../../src/macros/index.ts"
import type { AnyMacro } from "../../src/macros/index.ts"

export const FOO_CID = "https://example.com/catalogs/foo/v1/catalog.json"
export const BAR_CID = "https://example.com/catalogs/bar/v1/catalog.json"
export const BRAND_CID = "https://example.com/brand.json"
export const BRAND_SURFACE_CID = "https://example.com/brand_surface.json"
export const CAT_A_CID = "https://example.com/catalog_a.json"
export const CAT_B_CID = "https://example.com/catalog_b.json"
export const BAZ_MACROS_CID = "https://example.com/catalogs/baz_macros.json"

// Custom builder nodes.

const foo = catalogNodes(FOO_CID)
const bar = catalogNodes(BAR_CID)
const FooPanel = foo.define<{ readonly children: ChildList }>("FooPanel", { fields: ["children"] })
const FooHeader = foo.define<{ readonly title: DynamicString }>("FooHeader", { fields: ["title"] })
const BarBadge = bar.define<{ readonly tag: string }>("BarBadge", { fields: ["tag"] })
const BarButton = bar.define<{ readonly label: DynamicString; readonly action: Action }>("BarButton", { fields: ["label", "action"] })
const BrandBox = defineComponent<{ readonly child: ReturnType<typeof Text> }>("BrandBox", { fields: ["child"] })
const Chart = defineComponent<{ readonly series: string }>("Chart", { fields: ["series"] })
const ChartCard = defineComponent<{ readonly child: ReturnType<typeof Chart> }>("ChartCard", { fields: ["child"] })
const InnerBadgeScopedNode = defineComponent<{ readonly label: string }>("InnerBadgeScoped", { fields: ["label"] })
const InnerBadgeInheritedNode = defineComponent<{ readonly label: string }>("InnerBadgeInherited", { fields: ["label"] })
const DeferredCycleNode = defineComponent<{ readonly label: string }>("DeferredCycle", { fields: ["label"] })
const CycleANode = defineComponent<{ readonly label: string }>("CycleA", { fields: ["label"] })
const CycleBNode = defineComponent<{ readonly label: string }>("CycleB", { fields: ["label"] })
const FakeSurface = defineComponent("Surface")

/** The suite's reference macros authored with the v1.0 builder (`get_v1_0_suite_macros`). */
export function v10SuiteMacros(): AnyMacro[] {
  const StatusBadge = macro({
    name: "StatusBadge",
    description: "Status badge with uppercase status and title.",
    params: { status: param.string(), title: param.string() },
    render: ({ status, title }) =>
      Card({ child: Row({ children: [Text({ text: status.toUpperCase(), variant: "caption" }), Text({ text: title, variant: "body" })] }) }),
  })
  const SlotContainer = macro({
    name: "SlotContainer",
    description: "Container accepting an external child slot.",
    params: { title: param.string(), content: param.child() },
    render: ({ title, content }) => Card({ child: Column({ children: [Text({ text: title, variant: "body" }), content] }) }),
  })
  const MultiSlotContainer = macro({
    name: "MultiSlotContainer",
    description: "Container accepting a list of child slots.",
    params: { header: param.string(), items: param.componentList() },
    render: ({ header, items }) => Card({ child: Column({ children: [Text({ text: header, variant: "body" }), ...items] }) }),
  })
  const ActionButton = macro({
    name: "ActionButton",
    description: "Button with coerced action.",
    params: { label: param.string(), action: param.action() },
    render: ({ label, action }) => Button({ child: Text({ text: label }), action, variant: "primary" }),
  })
  const BoundMetric = macro({
    name: "BoundMetric",
    description: "Metric card displaying a dynamic value.",
    params: { label: param.string(), value: param.dynamicString() },
    render: ({ label, value }) => Card({ child: Column({ children: [Text({ text: label, variant: "caption" }), Text({ text: value, variant: "body" })] }) }),
  })
  const ConfigCard = macro({
    name: "ConfigCard",
    description: "Configuration card displaying primitives and metadata.",
    params: { name: param.string(), port: param.integer(), active: param.boolean() },
    render: ({ name, port, active }) =>
      Card({
        child: Column({
          children: [
            Text({ text: name, variant: "body" }),
            Text({ text: `Port: ${port}`, variant: "body" }),
            Text({ text: `Active: ${String(active)}`, variant: "body" }),
          ],
        }),
      }),
  })
  const NestedMacroCard = macro({
    name: "NestedMacroCard",
    description: "Macro composing another macro.",
    params: { title: param.string(), status: param.string() },
    render: ({ title, status }) =>
      Card({ child: Column({ children: [Text({ text: title, variant: "body" }), StatusBadge({ status, title: `${title} Status` })] }) }),
  })
  const RecursiveCard = macro({
    name: "RecursiveCard",
    description: "Macro composing itself recursively.",
    params: { title: param.string() },
    render: ({ title }): ReturnType<typeof Card> => Card({ child: RecursiveCard({ title }) }),
  })
  const ComplexCard = macro({
    name: "ComplexCard",
    description: "Card testing protocol common types in macro parameter schemas.",
    params: {
      title: param.string(),
      dynamic_title: param.dynamicString(),
      metric: param.dynamicNumber(),
      is_active: param.dynamicBoolean(),
      tags: param.dynamicStringList(),
      anything: param.dynamicValue(),
      on_click: param.action(),
      checks: param.checkRules(),
      accessibility: param.accessibility(),
      footer: param.child(),
      items: param.componentList(),
      theme: param.literal(["primary", "secondary"]),
    },
    render: ({ title }) => Card({ child: Text({ text: title }) }),
  })
  const PayloadButton = macro({
    name: "PayloadButton",
    description: "Button sending dynamic payload values inside an Action event context.",
    params: { label: param.string(), event_name: param.string(), payload: param.dynamicValue(), extra: param.dynamicValue() },
    render: ({ label, event_name, payload, extra }) =>
      Button({ child: Text({ text: label }), variant: "primary", action: new Action({ event: new ActionEvent(event_name, { context: { payload, extra } }) }) }),
  })
  const DynamicFormCard = macro({
    name: "DynamicFormCard",
    description: "Form card with dynamic child list, check rules, and submit action.",
    params: { label: param.string(), placeholder: param.dynamicString(), items: param.childList(), checks: param.checkRules(), on_submit: param.action() },
    render: ({ label, placeholder, items, checks, on_submit }) =>
      Card({
        child: Column({
          children: [
            TextField({ label, value: new DataBinding("/form/email"), placeholder, checks }),
            List({ children: items }),
            Button({ child: Text({ text: "Submit" }), variant: "primary", action: on_submit }),
          ],
        }),
      }),
  })
  const AnnotatedBadge = macro({
    name: "AnnotatedBadge",
    description: "Status badge whose root Card defines default accessibility and metadata extensions.",
    params: { status: param.string(), title: param.string() },
    render: ({ status, title }) =>
      Card({
        child: Row({ children: [Text({ text: status.toUpperCase(), variant: "caption" }), Text({ text: title, variant: "body" })] }),
        accessibility: new AccessibilityAttributes({ description: "Default badge description" }),
        extensions: { macroMeta: { source: "AnnotatedBadge" } },
      }),
  })
  const DeclaredA11yCard = macro({
    name: "DeclaredA11yCard",
    description: "Card declaring accessibility as an explicit macro parameter.",
    params: { title: param.string(), accessibility: param.accessibility(undefined, { optional: true }) },
    render: ({ title, accessibility }) =>
      Card({
        child: Text({ text: title }),
        accessibility: new AccessibilityAttributes({ label: typeof accessibility?.label === "string" ? `Custom: ${accessibility.label}` : "Internal" }),
      }),
  })
  const WeightedCard = macro({
    name: "WeightedCard",
    description: "Card declaring weight as an explicit macro parameter.",
    params: { label: param.string(), weight: param.number(undefined, { optional: true }) },
    render: ({ label, weight }) => Card({ child: Text({ text: label }), weight }),
  })
  const PositiveCountCard = macro({
    name: "PositiveCountCard",
    description: "Card raising ValidationError when count is negative.",
    params: { count: param.integer() },
    render: ({ count }) => {
      if (count < 0) throw new A2uiValidationError("count must be non-negative")
      return Card({ child: Text({ text: `Count: ${count}` }) })
    },
  })
  return [
    StatusBadge,
    SlotContainer,
    MultiSlotContainer,
    ActionButton,
    BoundMetric,
    ConfigCard,
    NestedMacroCard,
    RecursiveCard,
    ComplexCard,
    PayloadButton,
    DynamicFormCard,
    AnnotatedBadge,
    DeclaredA11yCard,
    WeightedCard,
    PositiveCountCard,
  ]
}

/** The catalog-scoped reference macros, by `catalog_id` (`get_scoped_suite_macros`). */
export function scopedSuiteMacros(): ReadonlyMap<string, AnyMacro[]> {
  const BrandText = macro({
    name: "Text",
    description: "Custom brand Text macro wrapping a basic Text inside a Card.",
    params: { text: param.string(), variant: param.literal(TEXT_VARIANTS, undefined, { default: "body" }) },
    render: ({ text, variant }) => Card({ child: Text({ text: `[Brand] ${text}`, variant }) }),
  })
  const UnannotatedBrandCard = macro({
    name: "UnannotatedBrandCard",
    description: "Brand card emitting unannotated Card, BrandBox, and Text nodes.",
    params: { title: param.string() },
    render: ({ title }) => Card({ child: BrandBox({ child: Text({ text: title, variant: "body" }) }) }),
  })
  const BrandBadge = macro({
    name: "BrandBadge",
    description: "Brand badge emitting basic Card and Text with explicit catalogId.",
    params: { label: param.string() },
    render: ({ label }) =>
      Card({ catalogId: BASIC_CATALOG_V1_0_ID, child: Text({ text: `[Badge] ${label}`, variant: "body", catalogId: BASIC_CATALOG_V1_0_ID }) }),
  })
  const InnerBadgeScoped = macro({
    name: "InnerBadgeScoped",
    description: "Scoped inner badge emitting BrandBox and unannotated basic Text.",
    params: { label: param.string() },
    render: ({ label }) => BrandBox({ catalogId: BRAND_CID, child: Text({ text: `Scoped Badge: ${label}`, variant: "caption" }) }),
  })
  const OuterPanelScoped = macro({
    name: "OuterPanelScoped",
    description: "Scoped outer panel emitting unannotated Text alongside deferred InnerBadgeScoped.",
    params: { title: param.string() },
    render: ({ title }) =>
      Card({ child: Column({ children: [Text({ text: title, variant: "body" }), InnerBadgeScopedNode({ label: title, catalogId: BRAND_CID })] }) }),
  })
  const BrandChart = macro({
    name: "Chart",
    description: "Brand Chart macro emitting ChartCard wrapping an unannotated Chart primitive.",
    params: { series: param.string() },
    render: ({ series }) => ChartCard({ child: Chart({ series: `[Brand] ${series}` }) }),
  })
  const BrandSurfaceText = macro({
    name: "Text",
    description: "Brand surface Text macro emitting cross-catalog basic Card and Text around BrandBox.",
    params: { text: param.string(), variant: param.literal(TEXT_VARIANTS, undefined, { default: "body" }) },
    render: ({ text, variant }) =>
      Card({
        catalogId: BASIC_CATALOG_V1_0_ID,
        child: BrandBox({ catalogId: BRAND_SURFACE_CID, child: Text({ text: `[Brand] ${text}`, variant, catalogId: BASIC_CATALOG_V1_0_ID }) }),
      }),
  })
  const BrandSurfaceBadge = macro({
    name: "BrandBadge",
    description: "Brand surface badge emitting cross-catalog basic Card and Text around BrandBox.",
    params: { label: param.string() },
    render: ({ label }) =>
      Card({
        catalogId: BASIC_CATALOG_V1_0_ID,
        child: BrandBox({ catalogId: BRAND_SURFACE_CID, child: Text({ text: `[Badge] ${label}`, variant: "body", catalogId: BASIC_CATALOG_V1_0_ID }) }),
      }),
  })
  const BazMacro = macro({
    name: "BazMacro",
    description: "Composite macro combining FooCatalog and BarCatalog primitives with explicit catalogIds.",
    params: { headline: param.dynamicString(), badge_tag: param.string(), cta_label: param.string(), on_cta: param.action() },
    render: ({ headline, badge_tag, cta_label, on_cta }) =>
      FooPanel({ children: [FooHeader({ title: headline }), BarBadge({ tag: badge_tag }), BarButton({ label: cta_label, action: on_cta })] }),
  })
  const ProductCard = macro({
    name: "ProductCard",
    description: "Macro sharing its name with ProductCard primitive in catalog_a.json.",
    params: { name: param.string() },
    render: ({ name }) => Card({ child: Text({ text: `Product: ${name}` }) }),
  })
  const BrandBoxMacro = macro({
    name: "BrandBox",
    description: "Macro wrapping a same-named BrandBox primitive from catalog_a.json.",
    params: { title: param.string() },
    render: ({ title }) => Card({ child: BrandBox({ catalogId: CAT_A_CID, child: Text({ text: title }) }) }),
  })
  const InnerBadgeInherited = macro({
    name: "InnerBadgeInherited",
    description: "Deferred inner macro inheriting enclosing catalogId when surface catalog is registered.",
    params: { label: param.string() },
    render: ({ label }) => BrandBox({ catalogId: CAT_A_CID, child: Text({ text: `Inherited Badge: ${label}`, variant: "caption" }) }),
  })
  const OuterPanelInherited = macro({
    name: "OuterPanelInherited",
    description: "Outer macro emitting unannotated deferred InnerBadgeInherited node.",
    params: { title: param.string() },
    render: ({ title }) => Card({ child: Column({ children: [Text({ text: title, variant: "body" }), InnerBadgeInheritedNode({ label: title })] }) }),
  })
  const DeferredCycle = macro({
    name: "DeferredCycle",
    description: "Deferred self-recursive macro node.",
    params: { label: param.string() },
    render: ({ label }) => Card({ child: DeferredCycleNode({ label }) }),
  })
  const CycleA = macro({
    name: "CycleA",
    description: "Mutually recursive deferred macro A referencing CycleB.",
    params: { label: param.string() },
    render: ({ label }) => Card({ child: CycleBNode({ label }) }),
  })
  const CycleB = macro({
    name: "CycleB",
    description: "Mutually recursive deferred macro B referencing CycleA.",
    params: { label: param.string() },
    render: ({ label }) => Card({ child: CycleANode({ label }) }),
  })
  const EmitsSurface = macro({
    name: "EmitsSurface",
    description: "Macro illegally emitting reserved Surface component in v1.0.",
    params: {},
    render: () => FakeSurface({}),
  })
  return new Map([
    [BRAND_CID, [BrandText, UnannotatedBrandCard, BrandBadge, InnerBadgeScoped, OuterPanelScoped, BrandChart]],
    [BRAND_SURFACE_CID, [BrandSurfaceText, BrandSurfaceBadge]],
    [BAZ_MACROS_CID, [BazMacro]],
    [CAT_B_CID, [ProductCard, BrandBoxMacro, InnerBadgeInherited, OuterPanelInherited, DeferredCycle, CycleA, CycleB, EmitsSurface]],
  ])
}

/** A v1.0 macro of the name `name`, for the cases that register one (`colliding_macro`). */
export const collidingMacro = (name: string): AnyMacro => macro({ name, params: {}, render: () => Card({ child: Text({ text: "colliding" }) }) })
