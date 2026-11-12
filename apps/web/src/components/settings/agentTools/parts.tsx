import { clsx } from "clsx"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { Effect, Exit } from "effect"
import type { AtomRegistry } from "effect/reactivity"
import { useMemo, useState, type ReactNode } from "react"
import type { McpServer, McpServerConfig, Skill } from "@huntaway/contracts"
import type { CallError, Methods } from "@huntaway/client"
import { exitError } from "../../../state/mutation"
import { Button, Input, Toggle, timeAgo } from "../../ui"

// What the agent tools' settings share (huntaway's settings/AgentTools.tsx `Section`, `OtherList`, `describe`, and
// McpSection's `serverSummary`), apart so the sections and the pages that hold them don't import each other.

/** What an editor saves with: the change (an `agentTools.*` mutation) it runs as its own action, showing its failure. */
export type Save<A extends ReadonlyArray<unknown>> = (...args: A) => Change

/** A change of a host's: one of its methods called as a mutation (`mutate`). */
export type Change = Effect.Effect<unknown, CallError<keyof Methods>, AtomRegistry.AtomRegistry>

/** An action's exit as a confirm dialog's `onConfirm` wants it: rejected with why it failed, so the dialog shows that. */
export const rejectFailure = (exit: Exit.Exit<unknown, unknown>): Promise<void> => {
  const error = exitError(exit)
  return error === null ? Promise.resolve() : Promise.reject(new Error(error))
}

export const serverSummary = (c: McpServerConfig) =>
  c.type === "http" || c.type === "sse" ? `${c.type} · ${c.url ?? ""}` : [c.command, ...(c.args ?? [])].join(" ")

export const describe = (i: Skill | McpServer) => ("content" in i ? i.description : serverSummary(i.config))

export function Section({ title, action, hint, children }: { title: string; action: ReactNode; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-3 rounded-xl border border-line p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-medium">{title}</div>
        {action}
      </div>
      <div className="text-[12px] text-faint">{hint}</div>
      {children}
    </div>
  )
}

/** Skills or servers the agents get from Claude configs, plugins or the repository, each with an on/off switch. */
export function OtherList<T extends { name: string }>({
  label,
  items,
  disabled,
  lastSeen,
  placeholder,
  detail,
  onToggle,
}: {
  label: string
  items: ReadonlyArray<T>
  disabled: ReadonlyArray<string>
  lastSeen?: string | undefined
  /** An example name, for turning off one that isn't listed. */
  placeholder: string
  detail?: ((item: T) => string | undefined) | undefined
  onToggle: (name: string, on: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState("")
  // Turned off but not seen lately: still listed, so they can be turned back on.
  const all = useMemo(() => {
    const names = new Set(items.map((i) => i.name))
    const gone = disabled.filter((n) => !names.has(n)).map((name) => ({ name, item: undefined }))
    return [...items.map((item) => ({ name: item.name, item })), ...gone].toSorted((a, b) => a.name.localeCompare(b.name))
  }, [items, disabled])
  const shown = all.filter((i) => i.name.toLowerCase().includes(filter.toLowerCase()))
  const off = all.filter((i) => disabled.includes(i.name)).length
  const [adding, setAdding] = useState("")
  const add = () => {
    const name = adding.trim()
    if (name && !disabled.includes(name)) onToggle(name, false)
    setAdding("")
  }
  return (
    <div className="rounded-md border border-line/70">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12.5px] text-muted hover:text-fg"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {label} from Claude configs, plugins and the repository
        <span className="ml-auto text-[11.5px] text-faint">{all.length ? `${all.length - off} on${off > 0 ? `, ${off} off` : ""}` : "none seen yet"}</span>
      </button>
      {open && (
        <div className="space-y-2.5 border-t border-line/70 px-3 py-2.5">
          {all.length > 10 && <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className="h-7 text-[12px]" />}
          {all.length > 0 && (
            <div className="max-h-72 space-y-1.5 overflow-y-auto">
              {shown.map((i) => {
                const more = i.item && detail?.(i.item)
                return (
                  <div key={i.name} className="flex items-center gap-2">
                    <Toggle
                      checked={!disabled.includes(i.name)}
                      onChange={(on) => onToggle(i.name, on)}
                      label={<span className={clsx("font-mono text-[12px]", disabled.includes(i.name) && "text-faint line-through")}>{i.name}</span>}
                    />
                    {more && <span className="truncate text-[11.5px] text-faint">{more}</span>}
                  </div>
                )
              })}
            </div>
          )}
          <div className="text-[11.5px] text-faint">
            {all.length > 0
              ? `What this project's agent runs have reported${lastSeen ? ` (last ${timeAgo(lastSeen)})` : ""}. `
              : "Listed once this project's agents have run. "}
            Turning one off denies it to the agents from their next message.
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              add()
            }}
          >
            <Input
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              placeholder={`Turn off another by name, e.g. ${placeholder}`}
              className="h-7 font-mono text-[12px]"
            />
            <Button size="sm" disabled={!adding.trim()}>
              Turn off
            </Button>
          </form>
        </div>
      )}
    </div>
  )
}
