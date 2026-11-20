import { Exit } from "effect"
import { useBoard } from "../../../state/board"
import { useMutation } from "../../../state/mutation"
import { Button, Input, useDraft } from "../../ui"

/**
 * HE-67: the SOCKS proxy the host's preview checks and its tasks' browser reach pages through. The host's settings come
 * with the board (and its `settings_changed` event), so a save shows once the host says so. Null where the host is
 * older than the setting.
 */
export function SocksProxyRow({ host }: { host: { readonly id: string } }) {
  const saved = useBoard((s) => s.hostSettings[host.id]?.socks_proxy)
  // Follows the saved proxy until it's edited, so a refresh of the host's settings doesn't overwrite what's typed.
  const { draft, setDraft } = useDraft(saved ?? "")
  const [{ busy, error }, updateSettings] = useMutation("host.updateSettings")
  if (saved === undefined) return null
  const changed = draft.trim() !== (saved ?? "")
  // What's stored may be written otherwise (`socks5h://proxy` is `socks5://proxy:1080`): the field shows that.
  const save = () =>
    void updateSettings(host.id, { patch: { socks_proxy: draft.trim() || null } }).then((exit) => {
      if (Exit.isSuccess(exit)) setDraft(exit.value.socks_proxy ?? "")
    })
  return (
    <section>
      <h2 className="mb-1 text-[13px] font-semibold">SOCKS proxy</h2>
      <p className="mb-3 text-[12.5px] text-muted">
        For previews only reachable through a VPN or an SSH tunnel (<code>ssh -D 1080 host</code>): this host checks them, and its tasks&apos; browser opens
        every page, through it. Pages on this machine don&apos;t go through it.
      </p>
      <div className="space-y-2 rounded-xl border border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Input
            aria-label="SOCKS proxy"
            spellCheck={false}
            className="font-mono text-[12px]"
            value={draft}
            placeholder="socks5://127.0.0.1:1080"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && changed) save()
            }}
          />
          {changed && (
            <Button size="sm" disabled={busy} onClick={save}>
              Save
            </Button>
          )}
        </div>
        {error && <div className="text-xs text-red-400">{error}</div>}
      </div>
    </section>
  )
}
