import type { ReactNode } from "react"

/** What a page or panel of a later milestone shows on this server until its components come over. */
export function NotYet({ what, children }: { what: string; children?: ReactNode }) {
  return (
    <div className="p-8 text-[13px] text-muted">
      <div className="mb-1 text-[14px] font-semibold text-fg">{what}</div>
      Not yet on this server.
      {children}
    </div>
  )
}
