import { CircleAlert, X } from "lucide-react"
import { useEffect, useState } from "react"

import { IconButton } from "../ui"

/**
 * A request that failed with nobody to catch it (a button that doesn't show its own errors): says so in a bar at the
 * bottom of the window, rather than leaving the page looking as if it worked. Other rejections stay in the console.
 */
export function UnhandledErrors() {
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      const r: unknown = e.reason
      // A call's failure is a tagged error (state/rpc.ts); Unauthorized signs out instead.
      if (typeof r !== "object" || r === null || !("_tag" in r) || typeof r._tag !== "string") return
      const tag = r._tag
      if (tag === "Unauthorized") return
      const message = "message" in r && typeof r.message === "string" ? r.message : ""
      // The connection's own failure: the server didn't answer.
      setError(tag === "RpcClientError" ? "Couldn't reach the server" : message || `The request failed (${tag})`)
      e.preventDefault()
    }
    window.addEventListener("unhandledrejection", onRejection)
    return () => window.removeEventListener("unhandledrejection", onRejection)
  }, [])
  useEffect(() => {
    if (!error) return undefined
    const id = setTimeout(() => setError(null), 10_000)
    return () => clearTimeout(id)
  }, [error])
  if (!error) return null
  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 z-[60] flex max-w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-start gap-2 rounded-lg border border-red-500/30 bg-panel py-2 pr-1.5 pl-3 text-[12.5px] text-red-300 shadow-xl shadow-black/40"
    >
      <CircleAlert size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{error}</span>
      <IconButton className="-my-1 h-6 w-6" title="Dismiss" aria-label="Dismiss" onClick={() => setError(null)}>
        <X size={13} />
      </IconButton>
    </div>
  )
}
