import type { TerminalTool } from "@huntaway/contracts"
import { Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { useBoard } from "../../../state/board"
import { rpc } from "../../../state/rpc"
import { Button, errorText, IconButton, Input } from "../../ui"

const NO_TOOLS: readonly TerminalTool[] = []

/**
 * TUI programs offered as shortcuts in every task's terminal on this host. Step 1 (docs/plan/09-frontend.md): the host's
 * settings come with the board (and its `settings_changed` event), so there is nothing to load or to put back after a save.
 */
export function TerminalToolsRow({ host }: { host: { readonly id: string } }) {
  const saved = useBoard((s) => s.hostSettings[host.id]?.terminal_tools) ?? NO_TOOLS
  const loaded = useBoard((s) => !!s.hostSettings[host.id])
  const [draft, setDraft] = useState<readonly TerminalTool[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const rows = draft ?? saved
  const edit = (i: number, b: Partial<TerminalTool>) =>
    setDraft(rows.map((t, j) => (j === i ? { id: t.id, name: b.name ?? t.name, command: b.command ?? t.command } : t)))
  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      const terminal_tools = rows.map((t) => ({ id: t.id, name: t.name.trim(), command: t.command.trim() })).filter((t) => t.name || t.command)
      await rpc(host.id, "host.updateSettings", { patch: { terminal_tools } })
      setDraft(null)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  if (!loaded) return null
  return (
    <div className="space-y-2 rounded-xl border border-line px-4 py-3">
      {rows.length === 0 && <div className="text-[12.5px] text-faint">No tools yet.</div>}
      {rows.map((t, i) => (
        <div key={t.id || `new-${i}`} className="flex items-center gap-2">
          <div className="w-36 shrink-0">
            <Input value={t.name} placeholder="Name, e.g. git" onChange={(e) => edit(i, { name: e.target.value })} />
          </div>
          <div className="min-w-0 flex-1">
            <Input
              value={t.command}
              placeholder="Command, e.g. lazygit or ~/bin/review.sh"
              className="font-mono text-[12px]"
              onChange={(e) => edit(i, { command: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && draft && void save()}
            />
          </div>
          <IconButton title="Remove" onClick={() => setDraft(rows.filter((_, j) => j !== i))}>
            <Trash2 size={13} />
          </IconButton>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={() => setDraft([...rows, { id: "", name: "", command: "" }])}>
          <Plus size={13} /> Add tool
        </Button>
        {draft && (
          <>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => (setDraft(null), setErr(null))}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
              Save
            </Button>
          </>
        )}
      </div>
      {err && <div className="text-xs text-red-400">{err}</div>}
    </div>
  )
}
