import { MenuButton, NotYet } from "../ui"
import type { Route } from "../../router"

// Placeholder: 6.3 brings this page over (docs/plan/13-milestones.md).
export function DocsPage(_props: { route: Extract<Route, { name: "docs" }> }) {
  return (
    <>
      <div className="flex h-12 items-center border-b border-line px-3">
        <MenuButton />
      </div>
      <NotYet what="Documents" />
    </>
  )
}
