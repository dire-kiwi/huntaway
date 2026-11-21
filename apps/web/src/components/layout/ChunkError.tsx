import { clsx } from "clsx"
import { Component } from "react"
import type { ReactNode } from "react"
import { RefreshCw, TriangleAlert } from "lucide-react"

/**
 * A part of the app that is a chunk of its own (a page, the task's views) didn't load (HE-71): most often a tab opened
 * before the server was updated, which asks for a chunk the new build doesn't have, or the network. Reloading fetches the
 * build there is now. `floating` sits over the page, for what opens over it (the task panel, the task dialog).
 */
export function ChunkError({ floating = false }: { floating?: boolean }) {
  return (
    <div
      role="alert"
      className={clsx(
        "flex items-center justify-center gap-3 text-[13px] text-muted",
        floating
          ? "fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line-strong bg-panel-2 px-4 py-3 shadow-2xl shadow-black/50"
          : "h-full",
      )}
    >
      <TriangleAlert size={14} className="text-st-attention" />
      This part of the app couldn't load: it may have been updated since this page was opened.
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1 text-fg hover:bg-raised"
      >
        <RefreshCw size={12} /> Reload
      </button>
    </div>
  )
}

interface BoundaryProps {
  readonly children: ReactNode
  /** The page: another one tries again. */
  readonly resetKey?: string
}
interface BoundaryState {
  readonly failed: boolean
  readonly key: string | undefined
}

/**
 * Around what loads a chunk (`React.lazy` under a `Suspense`): a chunk that fails to load throws as it renders, which
 * would otherwise unmount the whole app and leave a blank page. React logs what it caught to the console.
 */
export class ChunkBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false, key: this.props.resetKey }

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey }
  }

  override render(): ReactNode {
    return this.state.failed ? <ChunkError /> : this.props.children
  }
}
