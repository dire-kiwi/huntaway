import type { HostTask as Task } from "@huntaway/client"
import type { Context as ContextSummary } from "@huntaway/contracts"
import { clsx } from "clsx"
import { useState } from "react"
import { Modal, timeAgo } from "../ui"

// The breakdown of what is in the context (the old `api.context`, drawn by DetailLists) comes with `ContextMeter`
// (2.8): until then the dialog shows the total the task carries, as the old one did before a breakdown came.

/** "830", "84.2k", "1M". */
export function tokens(n: number) {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${+(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${+(n / 1_000_000).toFixed(1)}M`
}

function percent(n: number, of: number) {
  const p = (n / of) * 100
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`
}

const USED = "#3987e5"
const FREE = "rgba(255,255,255,0.07)"
const BUFFER = "repeating-linear-gradient(135deg, rgba(255,255,255,0.16) 0 2px, rgba(255,255,255,0.04) 2px 6px)"

type Segment = { id: string; name: string; tokens: number; fill: string; note?: string | undefined }

/** Bar segments: used, then free, then the compact buffer. */
function segments(ctx: ContextSummary): { max: number | null; used: number; bar: Segment[] } {
  const bar: Segment[] = [{ id: "used", name: "Used", tokens: ctx.tokens, fill: USED }]
  if (ctx.max_tokens) {
    const buffer = ctx.compact_at ? Math.max(0, ctx.max_tokens - ctx.compact_at) : 0
    bar.push({ id: "free_space", name: "Free space", tokens: Math.max(0, ctx.max_tokens - ctx.tokens - buffer), fill: FREE })
    if (buffer)
      bar.push({
        id: "autocompact_buffer",
        name: "Autocompact buffer",
        tokens: buffer,
        fill: BUFFER,
        note: "Kept free: the session compacts when it fills up to here",
      })
  }
  return { max: ctx.max_tokens, used: ctx.tokens, bar }
}

/** Whether the agent is close to compacting (or to the end of its window). */
function nearlyFull(ctx: ContextSummary) {
  const limit = ctx.compact_at ?? ctx.max_tokens
  return !!limit && ctx.tokens >= limit * 0.85
}

function summaryTitle(ctx: ContextSummary) {
  const lines = [
    ctx.max_tokens
      ? `Context: ${tokens(ctx.tokens)} of ${tokens(ctx.max_tokens)} tokens (${percent(ctx.tokens, ctx.max_tokens)})`
      : `Context: ${tokens(ctx.tokens)} tokens`,
  ]
  if (ctx.compact_at) lines.push(`Compacts at ${tokens(ctx.compact_at)}`)
  lines.push(`Updated ${timeAgo(ctx.updated_at)}`)
  return lines.join("\n")
}

/** How full the agent's context window is; opens the breakdown, like Claude Code's `/context`. */
export function ContextPill({ task, className }: { task: Task; className?: string | undefined }) {
  const [open, setOpen] = useState(false)
  const ctx = task.context
  if (!ctx) return null
  const fill = ctx.max_tokens ? Math.min(100, (ctx.tokens / ctx.max_tokens) * 100) : null
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={summaryTitle(ctx)}
        className={clsx("flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2 text-[12px] text-muted hover:bg-white/5", className)}
      >
        Context
        {fill != null && (
          <span className="h-1 w-8 overflow-hidden rounded-full bg-white/[0.07]">
            <span className={clsx("block h-full rounded-full", nearlyFull(ctx) ? "bg-st-attention" : "bg-accent")} style={{ width: `${fill}%` }} />
          </span>
        )}
        <span className={clsx("tabular-nums", nearlyFull(ctx) ? "text-st-attention" : "text-faint")}>
          {ctx.max_tokens ? percent(ctx.tokens, ctx.max_tokens) : tokens(ctx.tokens)}
        </span>
      </button>
      {open && <ContextDialog ctx={ctx} onClose={() => setOpen(false)} />}
    </>
  )
}

function ContextDialog({ ctx, onClose }: { ctx: ContextSummary; onClose: () => void }) {
  const [hover, setHover] = useState<string | null>(null)
  const { max, used, bar } = segments(ctx)
  const hovered = bar.find((s) => s.id === hover)
  const model = ctx.model

  return (
    <Modal title="Context usage" onClose={onClose} width="max-w-xl">
      <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1 text-[12.5px]">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-[20px] font-semibold tabular-nums">{max ? percent(used, max) : tokens(used)}</span>
            <span className="text-muted tabular-nums">{max ? `${tokens(used)} of ${tokens(max)} tokens` : "tokens"}</span>
            {model && <span className="ml-auto truncate font-mono text-[11px] text-faint">{model}</span>}
          </div>
          {max ? (
            <>
              <div className="mt-2 flex h-3 gap-[2px] overflow-hidden rounded" onMouseLeave={() => setHover(null)}>
                {bar
                  .filter((s) => s.tokens > 0)
                  .map((s) => (
                    <div
                      key={s.id}
                      onMouseEnter={() => setHover(s.id)}
                      className={clsx("h-full transition-opacity", hover && hover !== s.id && "opacity-40")}
                      style={{ width: `${(s.tokens / max) * 100}%`, minWidth: 3, background: s.fill }}
                    />
                  ))}
              </div>
              <div className="mt-1 h-4 text-[11.5px] text-muted tabular-nums">
                {hovered && (
                  <>
                    <span className="text-fg">{hovered.name}</span> · {tokens(hovered.tokens)} tokens · {percent(hovered.tokens, max)}
                  </>
                )}
              </div>
            </>
          ) : null}
          <div className="text-[11.5px] text-faint">
            No breakdown yet. Claude Code agents send one at the end of each turn; Codex agents only report the total.
          </div>
        </div>

        <table className="w-full tabular-nums">
          <tbody>
            {bar.map((s) => (
              <tr
                key={s.id}
                onMouseEnter={() => setHover(s.id)}
                onMouseLeave={() => setHover(null)}
                className={clsx(hover === s.id && "bg-white/5")}
                title={s.note}
              >
                <td className="w-4 py-0.5 pl-1">
                  <span
                    className="block h-2.5 w-2.5 rounded-sm"
                    style={{ background: s.fill, outline: s.fill === FREE ? "1px solid rgba(255,255,255,0.15)" : undefined }}
                  />
                </td>
                <td className="py-0.5 text-fg">{s.name}</td>
                <td className="py-0.5 text-right text-muted">{tokens(s.tokens)}</td>
                <td className="w-12 py-0.5 pr-1 pl-3 text-right text-faint">{max ? percent(s.tokens, max) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
