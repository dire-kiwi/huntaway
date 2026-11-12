// The types the Docs page's parts share.
import type { DocSummary } from "@huntaway/contracts"
import type { DocsHome } from "../docs"
import type { Route } from "../../../router"

export type DocsRoute = Extract<Route, { name: "docs" }>

export type Row = DocSummary & DocsHome
