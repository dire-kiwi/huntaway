import { useAtomValue } from "@effect/atom-react"
import { mutate, query } from "@huntaway/client"
import type { Space, TeleportSite, WipeAfter } from "@huntaway/contracts"
import { Exit } from "effect"
import { Loader2, ShieldAlert, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { useAction } from "../../state/mutation"
import { Button, Modal, ModalFooter, resultError, resultValue, timeAgo } from "../ui"

// Bring sign-ins into a Space (HE-49, teleport): pick a browser profile on the host, tick the sites to send (those that
// look signed in are pre-ticked; identity providers never are), and send. Nothing is decrypted until you send. Below
// the form are the teleports that landed, each removable. The host's page mounts it from a Space row.

const selectClass = "h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] text-fg outline-none focus:border-accent/60"

const WIPE_LABELS: ReadonlyArray<{ readonly value: WipeAfter; readonly label: string }> = [
  { value: "never", label: "Don't wipe" },
  { value: "hour", label: "Wipe after 1 hour" },
  { value: "day", label: "Wipe after 1 day" },
]

export function BringSignInsModal({ host, space, onClose }: { host: string; space: Space; onClose: () => void }) {
  const sourcesResult = useAtomValue(query("teleport.sources", host, undefined))
  const sources = resultValue(sourcesResult) ?? null
  const sourcesError = resultError(sourcesResult)
  const [browser, setBrowser] = useState<string | null>(null)
  const source = sources?.find((s) => s.key === (browser ?? sources[0]?.key)) ?? null
  const [profile, setProfile] = useState<string | null>(null)
  const chosenProfile = source?.profiles.find((p) => p.id === (profile ?? source.profiles[0]?.id)) ?? source?.profiles[0] ?? null

  return (
    <Modal title={`Bring sign-ins into ${space.name}`} onClose={onClose} width="max-w-lg">
      <p className="mb-3 text-[12.5px] text-muted">
        Copy cookies and local storage for the sites you pick from a browser on this host into the Space, so its browser starts out signed in. Saved passwords
        aren&apos;t moved. Anything that controls the Space can use these sessions.
      </p>
      {sourcesError ? (
        <div className="rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{sourcesError}</div>
      ) : sources === null ? (
        <div className="text-[12.5px] text-faint">Looking for browsers…</div>
      ) : sources.length === 0 ? (
        <div className="text-[12.5px] text-faint">No Chrome, Chromium or Firefox profile found on this host.</div>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-2">
            <label className="flex-1">
              <div className="mb-1 text-[11px] font-medium tracking-wide text-faint uppercase">Browser</div>
              <select
                className={selectClass}
                value={source?.key ?? ""}
                onChange={(e) => {
                  setBrowser(e.target.value)
                  setProfile(null)
                }}
              >
                {sources.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex-1">
              <div className="mb-1 text-[11px] font-medium tracking-wide text-faint uppercase">Profile</div>
              <select className={selectClass} value={chosenProfile?.id ?? ""} onChange={(e) => setProfile(e.target.value)}>
                {(source?.profiles ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {source && chosenProfile && (
            <SitePicker key={`${source.key}/${chosenProfile.id}`} host={host} space={space} browser={source.key} profile={chosenProfile.id} onClose={onClose} />
          )}
        </div>
      )}
      <ImportsList host={host} space={space} />
    </Modal>
  )
}

function SitePicker({ host, space, browser, profile, onClose }: { host: string; space: Space; browser: string; profile: string; onClose: () => void }) {
  // Asked only once a browser and profile are chosen (this component isn't drawn before).
  const sitesResult = useAtomValue(query("teleport.sites", host, { browser, profile }))
  const sitesError = resultError(sitesResult)
  const sites: ReadonlyArray<TeleportSite> | null = resultValue(sitesResult)?.sites ?? null
  const [picked, setPicked] = useState<ReadonlyArray<string> | null>(null)
  const [wipe, setWipe] = useState<WipeAfter>("never")
  const [action, run] = useAction()
  // Default ticks: the sites that look signed in (never an identity provider), until the user touches the list.
  const defaults = useMemo(() => new Set((sites ?? []).filter((s) => s.signed_in).map((s) => s.site)), [sites])
  const chosen = picked === null ? defaults : new Set(picked)
  const toggle = (site: string) => {
    const next = new Set(chosen)
    if (next.has(site)) next.delete(site)
    else next.add(site)
    setPicked([...next])
  }
  const submit = () => {
    if (chosen.size === 0 || action.busy) return
    void run(mutate("teleport.bring", host, { id: space.id, browser, profile, sites: [...chosen], wipe_after: wipe })).then((exit) => {
      if (Exit.isSuccess(exit)) onClose()
    })
  }

  if (sitesError) return <div className="rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{sitesError}</div>
  if (sites === null) return <div className="text-[12.5px] text-faint">Reading sites…</div>
  if (sites.length === 0) return <div className="text-[12.5px] text-faint">This profile has no cookies to bring.</div>

  return (
    <div className="space-y-3">
      <div className="max-h-64 divide-y divide-line overflow-auto rounded-lg border border-line">
        {sites.map((s) => (
          <label key={s.site} className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[12.5px] hover:bg-panel">
            <input type="checkbox" className="accent-accent" checked={chosen.has(s.site)} onChange={() => toggle(s.site)} />
            <span className="min-w-0 flex-1 truncate font-medium text-fg">{s.site}</span>
            {s.identity_provider && (
              <span
                className="flex shrink-0 items-center gap-1 text-[11px] text-amber-400"
                title="An identity provider: bringing it can hand over the account it signs you into."
              >
                <ShieldAlert size={12} /> identity
              </span>
            )}
            <span className="shrink-0 text-[11px] text-faint">
              {s.cookie_count} cookie{s.cookie_count === 1 ? "" : "s"}
              {s.storage_count > 0 ? ` · ${s.storage_count} storage` : ""}
            </span>
          </label>
        ))}
      </div>
      {action.error && <div className="rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{action.error}</div>}
      <ModalFooter className="flex items-center justify-between gap-2">
        <select
          className={`${selectClass} w-auto`}
          value={wipe}
          onChange={(e) => setWipe(WIPE_LABELS.find((w) => w.value === e.target.value)?.value ?? "never")}
        >
          {WIPE_LABELS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
        <Button disabled={chosen.size === 0 || action.busy} onClick={submit}>
          {action.busy && <Loader2 size={12} className="animate-spin" />} Bring {chosen.size > 0 ? `${chosen.size} site${chosen.size === 1 ? "" : "s"}` : ""}
        </Button>
      </ModalFooter>
    </div>
  )
}

function ImportsList({ host, space }: { host: string; space: Space }) {
  const imports = resultValue(useAtomValue(query("teleport.imports", host, { id: space.id }))) ?? []
  const [action, run] = useAction()
  const [doing, setDoing] = useState<string | null>(null)
  if (imports.length === 0) return null
  return (
    <div className="mt-5 border-t border-line pt-3">
      <div className="mb-1.5 text-[11px] font-medium tracking-wide text-faint uppercase">Brought in</div>
      <div className="divide-y divide-line rounded-lg border border-line">
        {imports.map((im) => (
          <div key={im.import_id} className="flex items-center gap-2 px-3 py-1.5 text-[12.5px]">
            <div className="min-w-0 flex-1">
              <div className="truncate text-fg">{im.label}</div>
              <div className="truncate text-[11px] text-faint">
                {im.site_count} site{im.site_count === 1 ? "" : "s"} · {timeAgo(im.created_at)}
                {im.expires_at ? ` · wipes ${timeAgo(im.expires_at)}` : ""}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              title="Remove these sign-ins from the Space"
              disabled={action.busy}
              onClick={() => {
                setDoing(im.import_id)
                void run(mutate("teleport.remove", host, { import_id: im.import_id }))
              }}
            >
              {action.busy && doing === im.import_id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            </Button>
          </div>
        ))}
      </div>
      {action.error && <div className="mt-2 rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{action.error}</div>}
    </div>
  )
}
