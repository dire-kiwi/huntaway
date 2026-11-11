import { MenuButton, NotYet } from "../ui"

// Placeholder: 6.9 brings this page over (docs/plan/13-milestones.md).
export function Analytics(_props: { profile: string | null }) {
  return (
    <>
      <div className="flex h-12 items-center border-b border-line px-3">
        <MenuButton />
      </div>
      <NotYet what="Analytics" />
    </>
  )
}
