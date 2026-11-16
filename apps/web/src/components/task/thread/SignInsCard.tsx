import { clsx } from "clsx"
import { Check, KeyRound, ShieldAlert } from "lucide-react"
import { memo, useState, type ReactNode } from "react"
import { useAction } from "../../../state/mutation"
import { Button } from "../../ui"
import { answerPrompt } from "./promptAnswers"
import { SkippedLine } from "./requestCards"
import { signInsAnswer, type SignInsAsk } from "./signIns"
import type { PromptData } from "./threadModel"

// HE-49: an agent's `space_request_sign_ins`, which asks the user itself whatever the thread's mode. The card says which
// Space and which browser profile on the host, and lists the sites with their cookie counts: identity providers start
// unticked, and the user can untick any site (or tick a provider back) before allowing it. Only the ticked sites go.

export const SignInsCard = memo(function SignInsCard({ ask, data, hostId, from }: { ask: SignInsAsk; data: PromptData; hostId: string; from: ReactNode }) {
  const pending = data.status === "pending"
  const [ticked, setTicked] = useState<ReadonlyArray<string>>(ask.ticked)
  const [{ busy, error }, run] = useAction()
  const toggle = (site: string) => setTicked((t) => (t.includes(site) ? t.filter((s) => s !== site) : [...t, site]))
  const allow = () => void run(answerPrompt(hostId, data.request_id, { decision: "allow", input: signInsAnswer(data.input, ticked) }))
  const deny = () => void run(answerPrompt(hostId, data.request_id, { decision: "deny" }))
  const shown = pending ? ask.offered : ask.offered.filter((o) => ask.ticked.includes(o.site))
  return (
    <div data-card="sign-ins" className={clsx("rounded-lg border p-3", pending ? "border-st-attention/50 bg-st-attention/[0.06]" : "border-line bg-panel/60")}>
      <div className="mb-2 flex items-center gap-2 text-[13px]">
        <KeyRound size={15} className={pending ? "text-st-attention" : "text-faint"} />
        <span className={pending ? "text-fg" : "text-muted"}>
          {pending ? `${data.agent === "codex" ? "Codex" : "Claude"} asks to bring your sign-ins into ` : "Sign-ins for "}
          <span className="font-medium">{ask.space}</span>
        </span>
        {from}
        {!pending && (
          <span
            className={clsx(
              "ml-auto rounded px-1.5 py-0.5 text-[11px]",
              data.status === "allowed"
                ? "bg-emerald-500/10 text-emerald-300"
                : data.status === "denied"
                  ? "bg-red-500/10 text-red-300"
                  : "bg-white/5 text-faint",
            )}
          >
            {data.status === "allowed" ? "brought" : data.status === "denied" ? "not brought" : data.status}
          </span>
        )}
      </div>
      <div className="mb-2 text-[12px] text-muted">
        From {ask.browser} ({ask.profile}) on this host: cookies and local storage, not saved passwords. Anything that controls the Space can use them.
      </div>
      <div className="divide-y divide-line rounded-md border border-line">
        {shown.map((o) => (
          <label key={o.site} className={clsx("flex items-center gap-2.5 px-3 py-1.5 text-[12.5px]", pending && "cursor-pointer hover:bg-panel")}>
            {pending && <input type="checkbox" className="accent-accent" checked={ticked.includes(o.site)} onChange={() => toggle(o.site)} />}
            <span className="min-w-0 flex-1 truncate font-medium text-fg">{o.site}</span>
            {o.identity && (
              <span
                className="flex shrink-0 items-center gap-1 text-[11px] text-amber-400"
                title="An identity provider: bringing it can hand over the account it signs you into."
              >
                <ShieldAlert size={12} /> identity
              </span>
            )}
            <span className="shrink-0 text-[11px] text-faint">
              {o.cookies} cookie{o.cookies === 1 ? "" : "s"}
              {o.storage > 0 ? ` · ${o.storage} storage` : ""}
            </span>
          </label>
        ))}
      </div>
      {ask.notFound.length > 0 && <div className="mt-1.5 text-[11.5px] text-faint">Not in this profile: {ask.notFound.join(", ")}</div>}
      <SkippedLine status={data.status} />
      {pending && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={busy || ticked.length === 0} onClick={allow}>
            <Check size={13} /> Bring {ticked.length} site{ticked.length === 1 ? "" : "s"}
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={deny}>
            Deny
          </Button>
          {error && <span className="self-center text-xs text-red-400">{error}</span>}
        </div>
      )}
    </div>
  )
})
