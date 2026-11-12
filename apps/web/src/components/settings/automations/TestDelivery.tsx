import { useAtomValue } from "@effect/atom-react"
import { Exit, Option, Schema } from "effect"
import { automationRunsAtom } from "@huntaway/client"
import type { Automation, AutomationRun } from "@huntaway/contracts"
import { Play } from "lucide-react"
import { useState } from "react"
import { useMutation } from "../../../state/mutation"
import { Button, Field, Input, Modal, ModalFooter, SUBMIT_KEYS, Textarea, useDraft } from "../../ui"
import { RunStatus, RunTask } from "./RunHistory"

const PrettyJson = Schema.fromJsonString(Schema.Unknown, { space: 2 })
const pretty = (v: unknown) => Option.getOrElse(Schema.encodeUnknownOption(PrettyJson)(v), () => "{}")
const parse = Schema.decodeUnknownOption(PrettyJson)

const EXAMPLE = { action: "opened", issue: { number: 1, title: "An issue", body: "What it says", labels: [] } }

/** Sends a webhook automation a delivery from the board, to try its filters and templates. */
export function TestDelivery({ hostId, automation, onClose }: { hostId: string; automation: Automation; onClose: () => void }) {
  const latest = useAtomValue(automationRunsAtom({ host_id: hostId, automation_id: automation.id }))
  const loaded = latest.data !== null || latest.failed !== null
  const delivery = latest.data?.latest_delivery ?? null
  // It starts from the latest delivery the automation got, once that's read.
  const { draft: event, setDraft: setEvent } = useDraft(loaded ? (delivery?.event ?? "issues") : "")
  const { draft: body, setDraft: setBody } = useDraft<string | null>(loaded ? pretty(delivery?.body ?? EXAMPLE) : null)
  const [sending, run] = useMutation("automations.run")
  const busy = sending.busy
  // Why the body can't be sent, else why the last send failed.
  const [invalid, setErr] = useState<string | null>(null)
  const err = invalid ?? sending.error
  const [result, setResult] = useState<AutomationRun | null>(null)
  const send = () => {
    setErr(null)
    setResult(null)
    const parsed = parse(body ?? "{}")
    if (Option.isNone(parsed)) return setErr("The body isn't valid JSON.")
    const payload = parsed.value
    void run(hostId, { id: automation.id, payload, event }).then((exit) => {
      if (Exit.isSuccess(exit)) setResult(exit.value)
    })
  }
  return (
    <Modal title={`Test ${automation.name}`} onClose={onClose} onSubmit={() => send()} width="max-w-2xl">
      <div className="space-y-3">
        <div className="text-[12px] text-faint">
          Runs it now with this delivery, through its filters (but not its secret, duplicate check or coalescing), whether or not it's on. It starts from the
          latest delivery it got.
        </div>
        <Field label="Event (X-GitHub-Event)">
          <Input className="font-mono text-[12px]" value={event} onChange={(e) => setEvent(e.target.value)} placeholder="issues" />
        </Field>
        <Field label="Body">
          <Textarea rows={14} className="font-mono text-[12px]" value={body ?? ""} spellCheck={false} onChange={(e) => setBody(e.target.value)} />
        </Field>
        {result && (
          <div className="flex min-w-0 items-center gap-2 rounded-md border border-line/70 px-3 py-2 text-[12.5px]" data-testid="test-result">
            <RunStatus run={result} />
            <RunTask run={result} />
            {result.detail && <span className="min-w-0 truncate text-faint">{result.detail}</span>}
          </div>
        )}
        <ModalFooter className="space-y-3">
          {(err ?? latest.failed) && <div className="text-xs text-red-400">{err ?? latest.failed}</div>}
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[11.5px] text-faint">{SUBMIT_KEYS} to send</span>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" disabled={busy || body === null} onClick={() => send()}>
              <Play size={12} /> Send test delivery
            </Button>
          </div>
        </ModalFooter>
      </div>
    </Modal>
  )
}
