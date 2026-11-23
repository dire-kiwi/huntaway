import { useAtomValue } from "@effect/atom-react"
import { mutate, query } from "@huntaway/client"
import type { SpeechModel } from "@huntaway/contracts"
import { clsx } from "clsx"
import type { Effect } from "effect"
import type { AtomRegistry } from "effect/reactivity"
import { Check, Loader2 } from "lucide-react"
import { useState } from "react"
import { cannotRecord } from "../../speech/recorder"
import { useBoard } from "../../state/board"
import { useAction } from "../../state/mutation"
import { DICTATION_KEYS } from "../task/Dictation"
import { Button, resultError, resultValue, useConfirm } from "../ui"
import { PanelHeading } from "./parts"

const size = (n: number) => (n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)} GB` : `${Math.round(n / 1_000_000)} MB`)

const languages = (m: SpeechModel) =>
  m.languages.length === 1 && m.languages[0] === "en" ? "English" : m.languages.length > 4 ? `${m.languages.length} languages` : m.languages.join(", ")

/**
 * Settings → Voice input (HE-89): the speech models this server can download for dictation, which it has, and the one
 * it uses. What is said into a message field's microphone is transcribed here, on this server, with that model.
 */
export function VoicePanel() {
  const host = useBoard((s) => s.localHostId)
  const [fast, setFast] = useState(false)
  const result = useAtomValue(query("speech.status", host ?? "", undefined, { refresh: fast ? "1 second" : undefined }))
  const st = resultValue(result)
  const [doing, setDoing] = useState<string | null>(null)
  const [action, run] = useAction()
  const confirm = useConfirm()
  const downloading = st?.downloading ?? null
  if ((downloading !== null) !== fast) setFast(downloading !== null)
  const err = action.error ?? resultError(result)
  const act = <A, E>(what: string, change: Effect.Effect<A, E, AtomRegistry.AtomRegistry>) => {
    setDoing(what)
    return run(change)
  }
  const busy = action.busy ? doing : null
  const cantRecord = cannotRecord()

  return (
    <section>
      <PanelHeading
        title="Voice input"
        description={`Dictate into a message with the microphone beside it, or ${DICTATION_KEYS} in the field. It's transcribed on this server, with a model it downloads.`}
        help={
          <>
            Press {DICTATION_KEYS} once to start and again to finish, or hold it down while you speak; Esc cancels. A recording can be up to five minutes.
            Nothing you say leaves this server: the models come from Hugging Face (transcribe.cpp&apos;s builds, as T3 Code uses), and once one is downloaded,
            dictation works offline. The model is loaded the first time you dictate, and let go after ten minutes without.
          </>
        }
      />
      {!st || host === null ? (
        err && <div className="mt-4 text-[12.5px] text-red-400">{err}</div>
      ) : (
        <div className="mt-5 space-y-3 text-[12.5px] text-muted">
          {st.unsupported !== null && <div className="rounded-lg border border-line p-3">This server can't transcribe: {st.unsupported}.</div>}
          {cantRecord !== null && <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-amber-200">{cantRecord}.</div>}
          {err && <div className="text-red-400">{err}</div>}
          {st.failed && (
            <div className="rounded bg-red-500/10 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-red-300">
              Downloading {st.models.find((m) => m.id === st.failed?.model)?.name ?? st.failed.model} failed: {st.failed.reason}
            </div>
          )}
          <div className="divide-y divide-line rounded-xl border border-line">
            {st.models.map((m) => {
              const active = st.active === m.id
              const mine = downloading?.model === m.id ? downloading : null
              return (
                <div key={m.id} className="flex items-start gap-3 p-3">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-x-2 text-[13px] text-fg">
                      {m.name}
                      {m.recommended && <span className="rounded bg-accent/15 px-1.5 text-[10.5px] text-accent">Recommended</span>}
                      {active && (
                        <span className="flex items-center gap-1 text-[11.5px] text-green-400">
                          <Check size={12} /> In use
                        </span>
                      )}
                    </div>
                    <div>
                      {m.description} · {languages(m)} · {size(m.size)}
                    </div>
                    {mine && (
                      <div className="space-y-1 pt-1">
                        <div className="flex items-center gap-2 text-fg">
                          <Loader2 size={12} className="animate-spin text-accent" />
                          {mine.phase === "downloading" ? `Downloading… ${size(mine.received)} of ${size(mine.total)}` : "Checking the download…"}
                        </div>
                        <div className="h-1 overflow-hidden rounded bg-line">
                          <div className="h-full bg-accent" style={{ width: `${Math.round((mine.received / Math.max(1, mine.total)) * 100)}%` }} />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className={clsx("flex shrink-0 items-center gap-1.5", st.unsupported !== null && "hidden")}>
                    {mine ? (
                      <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void act("cancel", mutate("speech.cancel", host, undefined))}>
                        Cancel
                      </Button>
                    ) : m.installed ? (
                      <>
                        {!active && (
                          <Button size="sm" disabled={!!busy} onClick={() => void act(`use ${m.id}`, mutate("speech.select", host, { model: m.id }))}>
                            Use
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!!busy}
                          onClick={() =>
                            confirm.ask({
                              title: "Remove the model",
                              body: `Delete ${m.name} (${size(m.size)}) from this server? You can download it again.`,
                              action: "Remove",
                              danger: true,
                              onConfirm: () => act(`remove ${m.id}`, mutate("speech.remove", host, { model: m.id })),
                            })
                          }
                        >
                          Remove
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        disabled={!!busy || downloading !== null}
                        onClick={() => void act(`download ${m.id}`, mutate("speech.download", host, { model: m.id }))}
                      >
                        {busy === `download ${m.id}` && <Loader2 size={12} className="animate-spin" />} Download
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {confirm.dialog}
    </section>
  )
}
