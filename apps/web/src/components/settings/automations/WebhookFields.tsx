import { FilterOp, type Automation } from "@huntaway/contracts"
import { Copy, Plus, RefreshCw, X } from "lucide-react"
import { useCallback, useState } from "react"
import { useBoard } from "../../../state/board"
import { useRpc } from "../../../state/rpc"
import { useHost } from "../../boardHelpers"
import { Button, copyText, Field, IconButton, Input, useAsyncAction, useConfirm, useDraft } from "../../ui"
import { OP_LABELS } from "./text"
import { type Draft, type DraftFilter, listText } from "./draft"
import { selectClass } from "./controls"

const FILTER_OPS: ReadonlyArray<FilterOp> = FilterOp.literals

/** Whether `v` is a filter's condition. */
const isOp = (v: string): v is FilterOp => FILTER_OPS.some((op) => op === v)

/** A random signing secret. */
function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** A webhook's URL, signing secret, filters and coalescing. */
export function WebhookFields({
  hostId,
  draft: d,
  saved,
  set,
  onRotated,
}: {
  hostId: string
  draft: Draft
  saved: Automation | null
  set: <K extends keyof Draft>(k: K, v: Draft[K]) => void
  onRotated: (a: Automation) => void
}) {
  const rpc = useRpc()
  const host = useHost(hostId)
  const publicUrl = useBoard((s) => s.hostSettings[hostId]?.public_url ?? "")
  // Follows the saved address until it's edited, so a refresh of the host's settings doesn't overwrite what's typed.
  const { draft: address, setDraft: setAddress } = useDraft(publicUrl)
  const saveAddress = useAsyncAction()
  const confirm = useConfirm()
  const [copied, setCopied] = useState(false)
  const base = publicUrl || (host?.local ? window.location.origin : "")
  const path = saved?.trigger.kind === "webhook" ? saved.hook_path : undefined
  const url = path ? `${base}${path}` : null
  // Shown once it's saved (or made anew): brought into view.
  const urlField = useCallback((el: HTMLDivElement | null) => {
    el?.scrollIntoView({ block: "nearest" })
  }, [])
  const setFilter = (i: number, f: Partial<DraftFilter>) =>
    set(
      "filters",
      d.filters.map((x, j) => (j === i ? { ...x, ...f } : x)),
    )
  return (
    <div className="space-y-3">
      <Field
        label="URL"
        hint={
          <>
            Deliveries are POSTed here, as JSON or as GitHub's form-encoded <code>payload</code>. The URL is its only key: keep it secret, or make a new one if
            it gets out.{" "}
            {!publicUrl &&
              (host?.local
                ? "Something outside (GitHub, say) needs a public address for this host: set it below, once a tunnel or proxy reaches it."
                : `This is the path on ${host?.name ?? "the host"}; set its public address below.`)}
          </>
        }
      >
        {url ? (
          <div ref={urlField} className="flex items-center gap-2">
            <Input
              readOnly
              aria-label="Webhook URL"
              className="font-mono text-[12px]"
              value={url}
              onFocus={(e) => e.target.select()}
              data-testid="webhook-url"
            />
            <IconButton
              title="Copy the URL"
              onClick={(e) => {
                e.preventDefault()
                copyText(url)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? <span className="text-[11px]">✓</span> : <Copy size={13} />}
            </IconButton>
            <IconButton
              title="Make a new URL (the old one stops working)"
              onClick={(e) => {
                e.preventDefault()
                if (!saved) return
                confirm.ask({
                  title: "Make a new URL",
                  body: "Make a new URL? The current one stops working, so update it wherever it's used.",
                  action: "Make a new URL",
                  danger: true,
                  onConfirm: async () => onRotated(await rpc(hostId, "automations.update", { id: saved.id, patch: { rotate_token: true } })),
                })
              }}
            >
              <RefreshCw size={13} />
            </IconButton>
          </div>
        ) : (
          <div className="text-[12px] text-faint">Shown here once it's saved.</div>
        )}
      </Field>
      <Field label="This host's public address" hint="For every webhook on this host. Where a tunnel or proxy reaches it from outside.">
        <div className="flex items-center gap-2">
          <Input
            className="font-mono text-[12px]"
            value={address}
            placeholder={host?.local ? window.location.origin : "https://board.example.com"}
            onChange={(e) => setAddress(e.target.value)}
          />
          {address.trim() !== publicUrl && (
            <Button
              size="sm"
              disabled={saveAddress.busy}
              onClick={(e) => {
                e.preventDefault()
                // The board's settings follow from the host's event.
                void saveAddress.run(() => rpc(hostId, "host.updateSettings", { patch: { public_url: address.trim() || null } }))
              }}
            >
              Save address
            </Button>
          )}
        </div>
        {saveAddress.error && <div className="text-xs text-red-400">{saveAddress.error}</div>}
      </Field>
      <Field
        label="Secret"
        hint="GitHub's webhook Secret: deliveries without a matching X-Hub-Signature-256 are rejected. Copy a new one into GitHub: once this dialog closes, it isn't shown again."
      >
        <div className="flex items-center gap-2">
          <Input
            className="font-mono text-[12px]"
            value={d.secret}
            aria-label="Secret"
            autoComplete="off"
            placeholder={saved?.has_secret && !d.removeSecret ? "Saved (type a new one to replace it)" : "None: deliveries aren't checked"}
            onChange={(e) => set("secret", e.target.value)}
          />
          <Button
            size="sm"
            onClick={(e) => {
              e.preventDefault()
              set("secret", newSecret())
            }}
          >
            Generate
          </Button>
          {saved?.has_secret && !d.secret && (
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.preventDefault()
                set("removeSecret", !d.removeSecret)
              }}
            >
              {d.removeSecret ? "Keep it" : "Remove"}
            </Button>
          )}
        </div>
      </Field>
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted">Only when</div>
        <div className="grid grid-cols-3 gap-2">
          <Input
            value={d.simple.event}
            placeholder="Events, e.g. issues"
            aria-label="Events"
            onChange={(e) => set("simple", { ...d.simple, event: e.target.value })}
          />
          <Input
            value={d.simple.action}
            placeholder="Actions, e.g. opened"
            aria-label="Actions"
            onChange={(e) => set("simple", { ...d.simple, action: e.target.value })}
          />
          <Input
            value={d.simple.labels}
            placeholder="Labels, e.g. bug, triage"
            aria-label="Labels"
            onChange={(e) => set("simple", { ...d.simple, labels: e.target.value })}
          />
        </div>
        {d.filters.map((f, i) => (
          <div key={f.key} className="grid grid-cols-[1fr_9rem_1fr_auto] gap-2">
            <Input
              className="font-mono text-[12px]"
              value={f.path}
              placeholder="body.issue.user.login"
              aria-label="Value to check"
              onChange={(e) => setFilter(i, { path: e.target.value })}
            />
            <select
              className={selectClass}
              value={f.op}
              aria-label="Condition"
              onChange={(e) => {
                const op = e.target.value
                if (isOp(op)) setFilter(i, { op })
              }}
            >
              {FILTER_OPS.map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </select>
            {f.op === "exists" || f.op === "not_exists" ? (
              <div />
            ) : (
              <Input
                value={listText(f.value)}
                placeholder={f.op === "in" || f.op === "not_in" ? "a, b, c" : "value"}
                aria-label="Filter value"
                onChange={(e) => setFilter(i, { value: e.target.value })}
              />
            )}
            <IconButton
              title="Remove this filter"
              onClick={(e) => {
                e.preventDefault()
                set(
                  "filters",
                  d.filters.filter((_, j) => j !== i),
                )
              }}
            >
              <X size={13} />
            </IconButton>
          </div>
        ))}
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.preventDefault()
              set("filters", [...d.filters, { key: Math.max(-1, ...d.filters.map((f) => f.key)) + 1, path: "", op: "equals", value: "" }])
            }}
          >
            <Plus size={12} /> Another condition
          </Button>
          <span className="text-[12px] text-faint">
            Lists are comma-separated; each condition has to hold. <code>event</code> is GitHub's X-GitHub-Event, <code>labels</code> the issue's or pull
            request's labels.
          </span>
        </div>
      </div>
      <div className="grid grid-cols-[10rem_1fr] gap-3">
        <Field label="Coalesce for (seconds)">
          <Input
            type="number"
            min={0}
            max={3600}
            value={d.coalesce}
            onChange={(e) => set("coalesce", Math.max(0, Math.min(3600, Number(e.target.value) || 0)))}
          />
        </Field>
        <Field
          label="…deliveries with the same"
          hint="A burst of deliveries in the window becomes one run, with the latest delivery's values. 0 runs each one."
        >
          <Input
            className="font-mono text-[12px]"
            value={d.coalesceKey}
            placeholder="{{body.issue.number}} (blank: all of them)"
            onChange={(e) => set("coalesceKey", e.target.value)}
          />
        </Field>
      </div>
      {confirm.dialog}
    </div>
  )
}
