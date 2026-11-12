// The assistant's approval rules in its details (6.7): what they come to, and a dialog to change them
// (`approvalRules.get`, `approvalRules.set`), read again on the profile's `approval_rules` events.
import { useAtomValue } from "@effect/atom-react"
import { mutate, query, RULE_DECISIONS, ruleFor, type HostTask as Task } from "@huntaway/client"
import { ProfileId, type ApprovalRule, type ApprovalRulesUpdate, type ApprovalRulesView as ApprovalRules, type RuleDecision } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Effect, Exit } from "effect"
import { Plus, RotateCcw, X } from "lucide-react"
import { useMemo, useState } from "react"
import { useAction } from "../../state/mutation"
import { Button, IconButton, Input, Modal, ModalFooter, resultError, resultValue, Toggle, toJson } from "../ui"

/** A profile's approval rules, read again as they change on its host (its `approval_rules` events, invalidate.ts). */
export function useApprovalRules(hostId: string, profileId: string): { rules: ApprovalRules | null; error: string | null } {
  const read = useAtomValue(query("approvalRules.get", hostId, { profile_id: ProfileId.make(profileId) }))
  return { rules: resultValue(read) ?? null, error: resultError(read) }
}

const DECISION_STYLE: Record<RuleDecision, string> = {
  allow: "text-emerald-300",
  ask: "text-st-attention",
  never: "text-red-300",
}

const count = (rules: ReadonlyArray<ApprovalRule>, d: RuleDecision) => rules.filter((r) => r.decision === d).length

/** How long prompts from routine runs wait, in words. */
function expiryText(minutes: number) {
  if (minutes <= 0) return "Prompts from routines wait until they're answered."
  const n = minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minute${minutes === 1 ? "" : "s"}`
  return `Prompts from routines are denied after ${n} unanswered.`
}

/** The assistant's Rules, in its details: what they come to, and a dialog to change them. */
export function RulesSection({ task }: { task: Task }) {
  const { rules: read, error } = useApprovalRules(task.host_id, task.profile_id)
  // What a save gave back, until the rules are read again (on the event it makes).
  const [saved, setSaved] = useState<{ over: ApprovalRules | null; rules: ApprovalRules } | null>(null)
  const rules = saved && saved.over === read ? saved.rules : read
  const [editing, setEditing] = useState(false)
  if (error) return <div className="text-[12px] text-red-400">Couldn't load the rules: {error}</div>
  if (!rules) return <div className="text-[12px] text-faint">Loading…</div>
  return (
    <div className="space-y-2 text-[12.5px] text-muted">
      <div>
        What the assistant may do outside the board, asks you first, or never does, whatever its thread's mode:{" "}
        {RULE_DECISIONS.map((d, i) => (
          <span key={d}>
            {i > 0 && ", "}
            <span className={DECISION_STYLE[d]}>
              {count(rules.rules, d)} {d}
            </span>
          </span>
        ))}
        {rules.is_default && " (the defaults, for Google)"}.
      </div>
      <div className="text-faint">{expiryText(rules.expiry_minutes)}</div>
      <Button size="sm" onClick={() => setEditing(true)}>
        Edit rules…
      </Button>
      {editing && <RulesDialog task={task} rules={rules} onSaved={(r) => setSaved({ over: read, rules: r })} onClose={() => setEditing(false)} />}
    </div>
  )
}

/** A rule being edited, with an id of its own for its row (rules have none). */
type DraftRule = { tool: string; decision: RuleDecision; id: number }
let lastId = 0
const nextId = () => ++lastId
const plain = (d: ReadonlyArray<DraftRule>): ApprovalRule[] => d.map((r) => ({ tool: r.tool, decision: r.decision }))

const decisionOf = (v: string): RuleDecision => RULE_DECISIONS.find((d) => d === v) ?? "ask"

/** What two rules with the same tool or pattern have in common, as the host compares them. */
const patternKey = (tool: string) => tool.trim().toLowerCase()

/** The rule that asks before the assistant creates a task, if it has one. */
const createTaskRules = (r: ApprovalRules) => r.create_task_tools.map((t) => `mcp__${r.board_server}__${t}`)

function RulesDialog({ task, rules, onSaved, onClose }: { task: Task; rules: ApprovalRules; onSaved: (r: ApprovalRules) => void; onClose: () => void }) {
  // A draft of their own: changes made elsewhere meanwhile don't overwrite what's being edited.
  const [draft, setDraft] = useState<DraftRule[]>(() => rules.rules.map((r) => ({ tool: r.tool, decision: r.decision, id: nextId() })))
  const [expiry, setExpiry] = useState(String(rules.expiry_minutes))
  const [tryTool, setTryTool] = useState("")
  const [save, run] = useAction()
  const creates = createTaskRules(rules)
  const asksToCreate = creates.every((t) => draft.some((r) => r.tool === t && r.decision === "ask"))
  const minutes = Number(expiry)
  const expiryOk = expiry.trim() !== "" && Number.isInteger(minutes) && minutes >= 0 && minutes <= 7 * 24 * 60
  const dirty = toJson(plain(draft)) !== toJson(rules.rules) || expiry !== String(rules.expiry_minutes)
  const decided = useMemo(() => (tryTool.trim() ? ruleFor(draft, tryTool.trim()) : undefined), [draft, tryTool])
  // A tool or pattern with more than one rule isn't saved (the host refuses it too): which would hold isn't for it to guess.
  const repeated = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of draft) if (patternKey(r.tool)) counts.set(patternKey(r.tool), (counts.get(patternKey(r.tool)) ?? 0) + 1)
    return new Set([...counts].filter(([, n]) => n > 1).map(([k]) => k))
  }, [draft])
  const firstRepeated = draft.find((r) => repeated.has(patternKey(r.tool)))?.tool.trim()

  const change = (i: number, r: { tool?: string; decision?: RuleDecision }) =>
    setDraft((d) => d.map((x, j) => (j === i ? { tool: r.tool ?? x.tool, decision: r.decision ?? x.decision, id: x.id } : x)))
  const setCreates = (on: boolean) =>
    setDraft((d) =>
      on
        ? [...d.filter((r) => !creates.includes(r.tool)), ...creates.map((tool) => ({ tool, decision: "ask" as const, id: nextId() }))]
        : d.filter((r) => !creates.includes(r.tool)),
    )
  // Saves the rules (or says why they can't be), and closes with what the host kept.
  const saveRules = (update: Effect.Effect<ApprovalRulesUpdate, string>) => {
    if (save.busy) return
    const saving = Effect.flatMap(update, (u) => mutate("approvalRules.set", task.host_id, { profile_id: ProfileId.make(task.profile_id), update: u }))
    void run(saving).then((exit) => {
      if (!Exit.isSuccess(exit)) return
      onSaved(exit.value)
      onClose()
    })
  }
  const submit = () =>
    saveRules(
      !expiryOk
        ? Effect.fail("The expiry is a whole number of minutes, at most a week (10080)")
        : firstRepeated
          ? Effect.fail(`"${firstRepeated}" has more than one rule: keep one for each tool or pattern`)
          : Effect.succeed({ rules: plain(draft.filter((r) => r.tool.trim())), expiry_minutes: minutes }),
    )
  const reset = () => {
    if (!save.busy && window.confirm("Go back to the default rules? Your own rules are dropped.")) saveRules(Effect.succeed({ reset: true }))
  }

  return (
    <Modal title="Approval rules" onClose={onClose} onSubmit={submit} width="max-w-2xl">
      <div className="space-y-3 text-[12.5px]" data-draft={dirty ? "" : undefined}>
        <p className="text-muted">
          For each tool or MCP server, the assistant may use it (<span className={DECISION_STYLE.allow}>allow</span>), asks you first each time (
          <span className={DECISION_STYLE.ask}>ask</span>) or never does (<span className={DECISION_STYLE.never}>never</span>), whatever its thread's mode. Name
          a tool (<code>mcp__{rules.google_server}__send_gmail_message</code>), a server for all its tools (<code>mcp__{rules.google_server}</code>) or a
          pattern (<code>mcp__{rules.google_server}__*delete*</code>). When several match, never beats ask, and ask beats allow. They hold from the assistant's
          next run.
        </p>
        <div className="max-h-[42vh] space-y-1 overflow-y-auto pr-1" aria-label="Rules">
          {draft.map((r, i) => (
            <div key={r.id} className="flex items-center gap-2">
              <Input
                value={r.tool}
                aria-label={`Rule ${i + 1}'s tool`}
                aria-invalid={repeated.has(patternKey(r.tool)) || undefined}
                placeholder="mcp__server__tool, or a pattern with *"
                className={clsx("h-7 flex-1 font-mono text-[12px]", repeated.has(patternKey(r.tool)) && "border-red-500/60")}
                onChange={(e) => change(i, { tool: e.target.value })}
              />
              <select
                className={clsx("h-7 rounded-md border border-line bg-panel px-1.5 text-[12px] outline-none", DECISION_STYLE[r.decision])}
                value={r.decision}
                aria-label={`Rule ${i + 1}'s decision`}
                onChange={(e) => change(i, { decision: decisionOf(e.target.value) })}
              >
                {RULE_DECISIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <IconButton title={`Remove rule ${i + 1}`} onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}>
                <X size={13} />
              </IconButton>
            </div>
          ))}
          {draft.length === 0 && <div className="py-2 text-faint">No rules: the thread's mode decides everything.</div>}
        </div>
        {firstRepeated && (
          <div role="alert" className="text-red-400">
            "{firstRepeated}" has more than one rule: keep one for each tool or pattern.
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setDraft((d) => [...d, { tool: "", decision: "ask", id: nextId() }])}>
            <Plus size={13} /> Add a rule
          </Button>
          <Button size="sm" variant="ghost" disabled={rules.is_default && !dirty} onClick={reset} title="Go back to the default rules">
            <RotateCcw size={13} /> Defaults
          </Button>
        </div>
        <Toggle checked={asksToCreate} onChange={setCreates} label="Ask before the assistant creates a task on the board" />
        <label className="flex flex-wrap items-center gap-2">
          <span className="text-fg">Prompts from routines expire after</span>
          <span className="w-20 shrink-0">
            <Input
              value={expiry}
              inputMode="numeric"
              aria-label="Minutes until a prompt from a routine is denied"
              className={clsx("h-7 text-[12px]", !expiryOk && "border-red-500/60")}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </span>
          <span className="text-muted">minutes (0: never). Unanswered, the prompt is denied and the routine carries on without it.</span>
        </label>
        <label className="flex flex-wrap items-center gap-2">
          <span className="text-fg">Try a tool</span>
          <Input
            value={tryTool}
            aria-label="A tool name to try the rules on"
            placeholder={`mcp__${rules.google_server}__send_gmail_message`}
            className="h-7 flex-1 font-mono text-[12px]"
            onChange={(e) => setTryTool(e.target.value)}
          />
          {tryTool.trim() && (
            <span className="text-muted" aria-live="polite">
              {decided ? (
                <>
                  <span className={DECISION_STYLE[decided.decision]}>{decided.decision}</span> (<span className="font-mono">{decided.tool}</span>)
                </>
              ) : (
                "no rule: the thread's mode decides"
              )}
            </span>
          )}
        </label>
        <div className="rounded-md border border-line bg-panel-2/60 p-2.5 text-[11.5px] text-faint">
          <p>
            <span className="text-muted">Claude:</span> ask and never hold in every mode, Bypass included; in Don't ask, what a rule asks about is denied.
          </p>
          <p className="mt-1">
            <span className="text-muted">Codex:</span> for MCP tools, you answer its approvals yourself in Auto (not its reviewer); in Bypass and Don't ask it
            can't ask, so what a rule asks about is refused, as is a tool that only a pattern allows. For its own tools (<code>Bash</code>,{" "}
            <code>ApplyPatch</code>), an ask rule makes it ask about every command and file change in any mode, except commands it takes as safe (reading files,
            listing them), which it runs without asking. It can't be kept from its own tools, so with a never rule on them (or <code>*</code>) the assistant
            won't run on Codex.
          </p>
          <p className="mt-1">
            <span className="text-muted">The board's tools</span> (<code>mcp__{rules.board_server}__…</code>) are held by the board, for both. Deleting tasks,
            adding projects and changing automations always ask you, so an ask rule doesn't ask about them twice.
          </p>
        </div>
        <ModalFooter className="flex items-center justify-end gap-2">
          {save.error && <span className="mr-auto text-xs text-red-400">{save.error}</span>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={save.busy || !dirty || !!firstRepeated} onClick={submit}>
            Save rules
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  )
}
