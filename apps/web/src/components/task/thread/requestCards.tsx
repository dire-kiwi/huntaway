import { useAtomSet } from "@effect/atom-react"
import { mutations, PERMISSION_MODES, takesTypedAnswer } from "@huntaway/client"
import { TaskId, type PermissionMode } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Check, ChevronRight, Map as MapIcon, MessageCircleQuestion, Send, ShieldAlert, Trash2, X } from "lucide-react"
import { memo, useEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react"
import { useBoard } from "../../../state/board"
import { useProject } from "../../boardHelpers"
import { Button, Textarea, useAsyncAction } from "../../ui"
import { Markdown } from "./Markdown"
import { usePromptAnswers } from "./promptAnswers"
import type { Any } from "./threadModel"

// What the thread's requests carry, drawn as the old cards drew them (task/Questions.tsx and task/Approvals.tsx), and
// answered from them (plan task 3.3) with the host's `permissions.answer`: Claude's questions (picked with a click or
// keys 1–9, or typed), a plan (approved into a mode, or sent back with feedback), and the board's own approvals (a
// project's change, a task's deletion, an automation or a workflow: approved or denied; their detailed views come with
// `Approvals`, 3.4); and a question asked with the board's request_user_input, whose answer is the user's message
// (`threads.answerQuestion`).

/** An option of a question, with what it would look like (`preview`) if the agent gave that. */
interface AskedOption {
  readonly label: string
  readonly description: string | undefined
  readonly preview: string | undefined
}

/** A question as AskUserQuestion asks it (the old src/questions.ts `questionsOf`). */
interface AskedQuestion {
  readonly question: string
  readonly header: string | undefined
  readonly options: ReadonlyArray<AskedOption>
  readonly multiSelect: boolean
  /** Codex's: it takes an answer of one's own. */
  readonly isOther: boolean | undefined
  readonly isSecret: boolean
}

const str = (x: unknown): string => (typeof x === "string" ? x : "")

/** The questions of a question prompt's data, in a shape the cards can trust whatever the agent sent. */
export function questionsOf(data: Any): AskedQuestion[] {
  const list = data?.input?.questions
  if (!Array.isArray(list)) return []
  return list
    .filter((q: Any) => q && typeof q === "object")
    .map((q: Any) => ({
      question: str(q.question) || "(no question)",
      header: str(q.header) || undefined,
      options: (Array.isArray(q.options) ? q.options : [])
        .map((o: Any): AskedOption =>
          typeof o === "string"
            ? { label: o, description: undefined, preview: undefined }
            : { label: str(o?.label), description: str(o?.description) || undefined, preview: str(o?.preview) || undefined },
        )
        .filter((o: AskedOption) => o.label),
      multiSelect: q.multiSelect === true,
      isOther: typeof q.isOther === "boolean" ? q.isOther : undefined,
      isSecret: q.isSecret === true,
    }))
}

/** The answers the user gave, question by question, once they have. */
function askedAnswers(data: Any): string[][] | undefined {
  const a = data?.answers
  return Array.isArray(a) ? a.map((x: unknown) => (Array.isArray(x) ? x.map(str).filter(Boolean) : [])) : undefined
}

/** A plan's title: its first line if that's a heading, without a leading "Plan:". */
function planTitle(plan: string): string {
  const first =
    plan
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? ""
  if (!first.startsWith("#")) return ""
  return first
    .replace(/^#+\s*/, "")
    .replace(/^Plan:\s*/i, "")
    .trim()
}

/** A plan without its title (shown above it). */
function withoutTitle(plan: string): string {
  const lines = plan.split("\n")
  const i = lines.findIndex((l) => l.trim())
  return i >= 0 && planTitle(plan)
    ? lines
        .slice(i + 1)
        .join("\n")
        .replace(/^\s*\n/, "")
    : plan
}

/** A workflow's approval: `automation` in approvals lists, and `workflow` in the thread message that asks it. */
export const isWorkflowApproval = (a: Any): boolean =>
  (a?.kind === "automation" || a?.kind === "workflow") && !!a.input && typeof a.input === "object" && "workflow" in a.input

// ---------- keys 1–9 ----------

/** The cards waiting for an answer, each with its message's id and what keys 1–9 do in it: the latest one shown gets them. */
type Keyed = { id: number; el: () => HTMLElement | null; pick: (n: number) => void }
const keyed = new Set<Keyed>()

function onDigit(e: KeyboardEvent) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat || !/^[1-9]$/.test(e.key)) return
  const t = e.target instanceof HTMLElement ? e.target : null
  // Typing a number somewhere.
  if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return
  // Only the cards in the dialog on top, if there's one: a task open in a dialog over the page leaves the page's
  // thread on screen behind it, with its own cards.
  const dialogs = document.querySelectorAll('[aria-modal="true"]')
  const top = dialogs.length ? dialogs[dialogs.length - 1] : null
  // Not one in a part of the thread that's hidden (the main conversation, while a subagent's is shown in its place).
  const shown = [...keyed].filter((k) => {
    const el = k.el()
    return !!el?.getClientRects().length && (!top || top.contains(el))
  })
  const card = shown.reduce<Keyed | null>((a, b) => (a === null || b.id > a.id ? b : a), null)
  if (card === null) return
  e.preventDefault()
  card.pick(Number(e.key))
}

/** While `on`, keys 1–9 call `pick` (with the number) for the card `ref` is on, if it's the thread's latest such card (message `id`). */
function useDigitKeys(id: number, on: boolean, ref: RefObject<HTMLElement | null>, pick: (n: number) => void) {
  const latest = useRef(pick)
  useEffect(() => {
    latest.current = pick
  })
  useEffect(() => {
    if (!on) return undefined
    const entry: Keyed = { id, el: () => ref.current, pick: (n) => latest.current(n) }
    if (!keyed.size) document.addEventListener("keydown", onDigit)
    keyed.add(entry)
    return () => {
      keyed.delete(entry)
      if (!keyed.size) document.removeEventListener("keydown", onDigit)
    }
  }, [id, on, ref])
}

// ---------- pieces ----------

function Frame({ pending, children, label, cardRef }: { pending: boolean; children: ReactNode; label: string; cardRef?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={cardRef}
      role="group"
      aria-label={label}
      className={clsx("rounded-lg border p-3", pending ? "border-line border-l-[3px] border-l-st-attention bg-panel" : "border-line bg-panel/60")}
    >
      {children}
    </div>
  )
}

/** What became of a question or plan, once it's settled. */
function Outcome({ tone, children }: { tone: "good" | "bad" | "plain"; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px]",
        tone === "good" ? "bg-emerald-500/10 text-emerald-300" : tone === "bad" ? "bg-red-500/10 text-red-300" : "bg-white/5 text-faint",
      )}
    >
      {children}
    </span>
  )
}

/**
 * One choice of a question: a numbered row (its number is its key while the question's the one keys pick in), ticked
 * when it's picked. Shown as picked or not, and not clickable, once the question's answered.
 */
function Choice({
  option,
  n,
  picked,
  multi,
  onPick,
  disabled,
  keys,
}: {
  option: AskedOption
  n: number
  picked: boolean
  multi: boolean
  onPick?: (() => void) | undefined
  disabled?: boolean
  keys: boolean
}) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={picked}
      disabled={disabled || !onPick}
      onClick={onPick}
      className={clsx(
        "flex w-full items-start gap-2.5 rounded-md border px-2.5 py-1.5 text-left text-[13px] transition-colors",
        picked ? "border-accent/60 bg-accent/10" : "border-line bg-panel-2",
        onPick && !disabled ? "hover:border-line-strong hover:bg-raised" : "cursor-default",
      )}
    >
      <span
        className={clsx(
          "mt-px flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded border font-mono text-[11px]",
          picked ? "border-accent bg-accent text-white" : "border-line-strong text-faint",
          multi ? "rounded" : "rounded-full",
        )}
        aria-hidden
      >
        {picked ? <Check size={11} strokeWidth={3} /> : keys && n <= 9 ? n : ""}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-fg">{option.label}</span>
        {option.description && option.description !== option.label && <span className="block text-[12px] text-muted">{option.description}</span>}
      </span>
    </button>
  )
}

/** A free-text answer: picked as soon as there's text in it. Enter sends it when `onEnter` is given. */
function OtherField({
  value,
  onChange,
  placeholder,
  disabled,
  secret,
  onEnter,
  label,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  disabled?: boolean
  secret?: boolean
  onEnter?: () => void
  label: string
}) {
  return (
    <input
      type={secret ? "password" : "text"}
      aria-label={label}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && onEnter) {
          e.preventDefault()
          onEnter()
        }
      }}
      className={clsx(
        "h-8 w-full rounded-md border bg-panel-2 px-2.5 text-[13px] text-fg placeholder:text-faint outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/15",
        value.trim() ? "border-accent/60" : "border-line",
      )}
    />
  )
}

// ---------- AskUserQuestion, and Codex's questions ----------

type Draft = { picked: string[]; other: string }

const DISMISSED = "The user dismissed these questions without answering them."

/**
 * The questions of Claude's AskUserQuestion (or Codex's request_user_input), each with its options and descriptions, a
 * free-text answer, and several picks where a question takes them. Keys 1–9 pick in the question that's current;
 * picking the one answer of a question moves on to the next, and answers a lone question outright. The answers go back
 * to the agent as its tool's answers. A question whose run ended first can still be answered, until a message is sent
 * to the agent after it (`movedOn`): the answers go as the user's message.
 */
export const AskCard = memo(function AskCard({
  id,
  data,
  hostId,
  from,
  movedOn,
}: {
  id: number
  data: Any
  hostId: string
  from?: ReactNode
  movedOn: boolean
}) {
  const questions = questionsOf(data)
  const codex = data.agent === "codex" || data.tool_name === "request_user_input"
  // A run that ended first: answerable by message, while the conversation hasn't moved on.
  const late = data.status === "expired" && !movedOn
  const open = data.status === "pending" || late
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => ({ picked: [], other: "" })))
  const [current, setCurrent] = useState(0)
  const { busy, error, run } = useAsyncAction()
  const ref = useRef<HTMLDivElement>(null)
  const respond = usePromptAnswers(hostId)
  // A typed answer goes with the options ticked, or in place of the one picked.
  const answerOf = (q: AskedQuestion, d: Draft) => {
    const typed = d.other.trim() ? [d.other.trim()] : []
    return q.multiSelect ? [...d.picked, ...typed] : typed.length ? typed : d.picked
  }
  const answers = questions.map((q, i) => answerOf(q, drafts[i] ?? { picked: [], other: "" }))
  const complete = answers.every((a) => a.length > 0)
  const submit = (list = answers) => void run(() => respond(data.request_id, { decision: "allow", answers: list }))
  const dismiss = () => void run(() => respond(data.request_id, { decision: "deny", message: DISMISSED }))
  const set = (i: number, d: Partial<Draft>) => setDrafts((all) => all.map((x, j) => (j === i ? { ...x, ...d } : x)))
  const pick = (i: number, label: string) => {
    const q = questions[i]
    if (!q || busy) return
    if (q.multiSelect) {
      const p = drafts[i]?.picked ?? []
      return set(i, { picked: p.includes(label) ? p.filter((x) => x !== label) : [...p, label] })
    }
    const next = drafts.map((x, j) => (j === i ? { picked: [label], other: "" } : x))
    setDrafts(next)
    if (questions.length === 1) return submit([[label]])
    // On to the next question that isn't answered yet.
    const after = questions.findIndex((qq, j) => j > i && !answerOf(qq, next[j] ?? { picked: [], other: "" }).length)
    setCurrent(after >= 0 ? after : i)
  }
  useDigitKeys(id, open && !busy, ref, (n) => {
    const o = questions[current]?.options[n - 1]
    if (o) pick(current, o.label)
  })
  const shown = askedAnswers(data)
  const asker = codex ? "Codex" : "Claude"
  const header = open
    ? `${asker} ${questions.length === 1 ? "asks" : `asks ${questions.length} questions`}`
    : `${asker} asked ${questions.length === 1 ? "a question" : `${questions.length} questions`}`
  return (
    <Frame pending={open} cardRef={ref} label={`Questions from ${asker}`}>
      <div className="mb-2 flex items-center gap-2 text-[12px] text-faint">
        <MessageCircleQuestion size={14} className={open ? "text-st-attention" : "text-faint"} />
        {header}
        {from}
        {!open &&
          (data.status === "allowed" ? (
            <Outcome tone="good">{data.late ? "answered by message" : "answered"}</Outcome>
          ) : data.status === "denied" ? (
            <Outcome tone="bad">{data.note?.startsWith("The user dismissed") || !data.note ? "dismissed" : "declined"}</Outcome>
          ) : (
            <Outcome tone="plain">{data.status === "expired" && movedOn ? "not answered" : data.status}</Outcome>
          ))}
      </div>
      {late && (
        <div className="mb-2 rounded-md bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-muted">
          The agent's run ended before these were answered. Your answers go to it as your message.
        </div>
      )}
      <div className="grid gap-3">
        {questions.map((q, i) => {
          const d = drafts[i] ?? { picked: [], other: "" }
          const given = shown?.[i]
          const active = open && i === current && questions.length > 1
          const takesOther = takesTypedAnswer(codex, q.isOther === undefined ? { options: q.options } : { isOther: q.isOther, options: q.options })
          const picked = open ? (q.multiSelect ? d.picked : d.other.trim() ? [] : d.picked) : (given ?? [])
          const preview = q.options.find((o) => picked.includes(o.label) && o.preview)?.preview
          return (
            <div
              key={q.question}
              onFocusCapture={() => open && setCurrent(i)}
              onMouseDown={() => open && setCurrent(i)}
              className={clsx("rounded-md", questions.length > 1 && "border-l-2 py-0.5 pl-2.5", active ? "border-l-accent" : "border-l-line")}
            >
              <div className="mb-1 flex items-baseline gap-2">
                {q.header && <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-px text-[11px] text-muted">{q.header}</span>}
                <span className={clsx("text-[13.5px] font-semibold", open ? "text-fg" : "text-muted")}>{q.question}</span>
                {q.multiSelect && open && <span className="shrink-0 text-[11px] text-faint">pick any</span>}
              </div>
              <div className="grid gap-1.5" role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question}>
                {q.options.map((o, j) => (
                  <Choice
                    key={o.label}
                    option={o}
                    n={j + 1}
                    multi={q.multiSelect}
                    picked={picked.includes(o.label)}
                    keys={open && (i === current || questions.length === 1)}
                    disabled={busy}
                    onPick={open ? () => pick(i, o.label) : undefined}
                  />
                ))}
              </div>
              {preview && (
                <pre className="mt-1.5 max-h-60 overflow-auto rounded-md border border-line bg-[#0c0c10] p-2 font-mono text-[12px] leading-[1.45] text-[#c9c9d6]">
                  {preview}
                </pre>
              )}
              {open && takesOther && (
                <div className="mt-1.5">
                  <OtherField
                    label={`Your own answer to: ${q.question}`}
                    value={d.other}
                    secret={q.isSecret}
                    onChange={(v) => set(i, { other: v })}
                    disabled={busy}
                    placeholder={q.options.length ? (q.multiSelect ? "Something else too (optional)" : "Other: your own answer") : "Your answer"}
                    onEnter={() => complete && submit()}
                  />
                </div>
              )}
              {!open && given && given.some((a) => !q.options.some((o) => o.label === a)) && (
                <div className="mt-1.5 rounded-md border-l-2 border-line-strong bg-white/[0.03] px-3 py-1.5 text-[13px] whitespace-pre-wrap text-muted">
                  {given.filter((a) => !q.options.some((o) => o.label === a)).join(", ")}
                </div>
              )}
              {!open && given && !given.length && <div className="mt-1 text-[12px] text-faint">(no answer)</div>}
            </div>
          )
        })}
      </div>
      {open && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={busy || !complete} onClick={() => submit()}>
            <Send size={13} /> {late ? "Send answers" : questions.length === 1 ? "Answer" : "Submit answers"}
          </Button>
          {!late && (
            <Button size="sm" disabled={busy} onClick={dismiss} title="Tell the agent you won't answer these">
              <X size={13} /> Dismiss
            </Button>
          )}
          <span className="text-[11.5px] text-faint">{questions[current]?.options.length ? "Keys 1–9 pick an answer." : ""}</span>
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      )}
    </Frame>
  )
})

// ---------- request_user_input ----------

/**
 * A question an agent asked with the board's request_user_input. With options, picking one answers it (or, when it
 * takes several, ticking them and Send), and keys 1–9 pick them; a free-text answer goes with Send or Enter. Answering
 * sends the answer as the user's message (`threads.answerQuestion`). Without options, the reply is typed in the thread.
 * Once a message has been sent to the agent after it (`movedOn`), it isn't answered any more.
 */
export const BoardQuestionCard = memo(function BoardQuestionCard({
  id,
  data,
  hostId,
  taskId,
  movedOn,
}: {
  id: number
  data: Any
  hostId: string
  taskId: string
  movedOn: boolean
}) {
  const options: AskedOption[] = (Array.isArray(data.options) ? data.options : [])
    .map((o: Any) =>
      typeof o === "string"
        ? { label: o, description: undefined, preview: undefined }
        : { label: str(o?.label), description: str(o?.description) || undefined, preview: undefined },
    )
    .filter((o: AskedOption) => o.label)
  const multi = !!data.multi_select
  const other = data.allow_other !== false
  const pending = data.status === "pending" && !movedOn
  const [picked, setPicked] = useState<string[]>([])
  const [text, setText] = useState("")
  const { busy, error, run } = useAsyncAction()
  const ref = useRef<HTMLDivElement>(null)
  const answerQuestion = useAtomSet(mutations.threads.answerQuestion, { mode: "promise" })
  const answer = (choices: string[], typed: string) =>
    void run(() => answerQuestion({ host: hostId, payload: { task_id: TaskId.make(taskId), request_id: `legacy:${id}`, choices, text: typed.trim() || null } }))
  const pick = (label: string) => {
    if (busy) return
    if (!multi) answer([label], "")
    else setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]))
  }
  useDigitKeys(id, pending && options.length > 0 && !busy, ref, (n) => {
    const o = options[n - 1]
    if (o) pick(o.label)
  })
  const answered: { choices?: string[]; text?: string | null } = data.answer ?? {}
  const shown = pending ? picked : (answered.choices ?? [])
  const canSend = multi ? picked.length > 0 || !!text.trim() : !!text.trim()
  // The board's own question, whether to merge: answering it is the decision, not a message to the agent (M4).
  const merge = data.merge_approval === true
  return (
    <Frame pending={pending} cardRef={ref} label={merge ? "Merge approval" : "Question from the agent"}>
      <div className="mb-1.5 flex items-center gap-2 text-[12px] text-faint">
        <MessageCircleQuestion size={14} className={pending ? "text-st-attention" : "text-faint"} />
        {merge ? "Merge approval" : pending ? "The agent asks" : "The agent asked"}
        {data.status === "answered" &&
          (merge ? (
            <Outcome tone={answered.choices?.includes("Approve") ? "good" : "bad"}>{answered.choices?.includes("Approve") ? "approved" : "denied"}</Outcome>
          ) : (
            <Outcome tone="good">answered</Outcome>
          ))}
        {data.status === "replied" && <Outcome tone="plain">{merge ? "not answered" : "answered in the thread"}</Outcome>}
        {(data.status === "replaced" || data.status === "expired") && <Outcome tone="plain">not answered</Outcome>}
        {data.status === "pending" && movedOn && <Outcome tone="plain">not answered</Outcome>}
      </div>
      <div className={clsx("text-[13.5px] font-semibold whitespace-pre-wrap", pending ? "text-fg" : "text-muted")}>{data.question}</div>
      {options.length > 0 && (
        <div className="mt-2 grid gap-1.5" role={multi ? "group" : "radiogroup"} aria-label={data.question}>
          {options.map((o, i) => (
            <Choice
              key={o.label}
              option={o}
              n={i + 1}
              multi={multi}
              picked={shown.includes(o.label)}
              keys={pending}
              disabled={busy}
              onPick={pending ? () => pick(o.label) : undefined}
            />
          ))}
        </div>
      )}
      {pending && options.length > 0 && other && (
        <div className="mt-1.5 flex gap-2">
          <OtherField
            label="Your own answer"
            value={text}
            onChange={setText}
            disabled={busy}
            placeholder={multi ? "Something else (optional)" : "Or write your own answer"}
            onEnter={() => canSend && answer(picked, text)}
          />
          {!multi && (
            <Button size="md" disabled={busy || !text.trim()} onClick={() => answer([], text)} title="Send your answer">
              <Send size={13} /> Send
            </Button>
          )}
        </div>
      )}
      {pending && multi && (
        <div className="mt-2.5">
          <Button size="sm" variant="primary" disabled={busy || !canSend} onClick={() => answer(picked, text)}>
            <Send size={13} /> Send answer
          </Button>
        </div>
      )}
      {!pending && answered.text && (
        <div className="mt-2 rounded-md border-l-2 border-line-strong bg-white/[0.03] px-3 py-1.5 text-[13px] whitespace-pre-wrap text-muted">
          {answered.text}
        </div>
      )}
      {pending && (
        <div className="mt-2 text-[11.5px] text-faint">
          {merge
            ? "Pick one (keys 1–2). To ask the agent about the merge first, reply below: you're asked again once it answers."
            : options.length > 0
              ? "Pick an answer (keys 1–9), or reply below in your own words."
              : "Reply below to answer it."}
        </div>
      )}
      {error && <div className="mt-1.5 text-xs text-red-400">{error}</div>}
    </Frame>
  )
})

// ---------- ExitPlanMode ----------

/** Modes a thread can carry on in once its plan's approved, as Claude Code offers them. */
const AFTER_PLAN: PermissionMode[] = ["default", "acceptEdits", "auto", "bypassPermissions"]
const modeLabel = (m: PermissionMode) => PERMISSION_MODES.find((x) => x.id === m)?.label ?? m

/**
 * A plan presented with ExitPlanMode: the plan as Markdown, **Approve** (which takes the thread out of Plan mode, into
 * the mode picked beside it) and **Keep planning**, which sends the agent back to it with the user's feedback. As with
 * questions, one whose run ended first is answered by message until the conversation moves on (`movedOn`).
 */
export const PlanCard = memo(function PlanCard({
  data,
  hostId,
  taskId,
  from,
  movedOn,
}: {
  data: Any
  hostId: string
  taskId: string
  from?: ReactNode
  movedOn: boolean
}) {
  const plan: string = typeof data.input?.plan === "string" ? data.input.plan : ""
  const late = data.status === "expired" && !movedOn
  const open = data.status === "pending" || late
  const task = useBoard((s) => s.tasks[taskId])
  const project = useProject(task?.project_id)
  const hostMode = useBoard((s) => s.hostSettings[hostId]?.default_permission_mode)
  // What it carries on in unless another's picked: the thread's own mode, if it has one other than Plan (the agent
  // went into plan mode by itself), else its default without Plan, as approving does on its own.
  const inherited: PermissionMode = project?.permission_mode ?? hostMode ?? "default"
  const own = task?.permission_mode !== "plan" ? task?.permission_mode : null
  const [mode, setMode] = useState<PermissionMode>(own ?? (inherited === "plan" ? "default" : inherited))
  const modes = AFTER_PLAN.includes(mode) ? AFTER_PLAN : [...AFTER_PLAN, mode]
  const [expanded, setExpanded] = useState(open)
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    setExpanded(open)
  }
  const [feedback, setFeedback] = useState<string | null>(null)
  const { busy, error, run } = useAsyncAction()
  const form = useRef<HTMLDivElement>(null)
  const asking = feedback !== null
  // Its buttons may be under the composer.
  useEffect(() => {
    if (asking) form.current?.scrollIntoView({ block: "nearest" })
  }, [asking])
  const respond = usePromptAnswers(hostId)
  const approve = () => void run(() => respond(data.request_id, { decision: "allow", mode }))
  const keepPlanning = () => void run(() => respond(data.request_id, { decision: "deny", feedback: feedback?.trim() ?? "" }))
  const title = planTitle(plan)
  return (
    <Frame pending={open} label="Plan from the agent">
      <div className="mb-2 flex items-center gap-2 text-[12px] text-faint">
        <MapIcon size={14} className={open ? "text-st-attention" : "text-faint"} />
        <span className="min-w-0 truncate">
          {open ? "Plan ready for approval" : "Plan"}
          {title && <span className={clsx("ml-1.5 font-medium", open ? "text-fg" : "text-muted")}>{title}</span>}
        </span>
        {from}
        {!open &&
          (data.status === "allowed" ? (
            <Outcome tone="good">approved{data.late ? " by message" : ""}</Outcome>
          ) : data.status === "denied" ? (
            <Outcome tone="plain">kept planning</Outcome>
          ) : (
            <Outcome tone="plain">{data.status === "expired" && movedOn ? "not answered" : data.status}</Outcome>
          ))}
      </div>
      {late && (
        <div className="mb-2 rounded-md bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-muted">
          The agent's run ended before the plan was answered. Your answer goes to it as your message.
        </div>
      )}
      {expanded ? (
        <div className="relative">
          <div className={clsx("overflow-auto rounded-md border border-line bg-panel-2 px-3.5 py-2.5", open && "max-h-[28rem]")}>
            {plan ? <Markdown text={withoutTitle(plan)} /> : <span className="text-[12px] text-faint">(The plan is empty.)</span>}
          </div>
          {!open && (
            <button className="mt-1 text-[12px] text-faint hover:text-muted" onClick={() => setExpanded(false)}>
              Hide the plan
            </button>
          )}
        </div>
      ) : (
        <button className="flex items-center gap-1 text-[12px] text-faint hover:text-muted" onClick={() => setExpanded(true)}>
          <ChevronRight size={12} /> Show the plan
        </button>
      )}
      {!open && data.feedback && (
        <div className="mt-2 rounded-md border-l-2 border-line-strong bg-white/[0.03] px-3 py-1.5 text-[13px] whitespace-pre-wrap text-muted">
          {data.feedback}
        </div>
      )}
      {open && feedback === null && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={approve}>
            <Check size={13} /> Approve
          </Button>
          <label className="flex items-center gap-1.5 text-[12px] text-faint">
            and continue in
            <select
              aria-label="Mode to continue in"
              value={mode}
              disabled={busy}
              onChange={(e) => setMode(modes.find((m) => m === e.target.value) ?? mode)}
              className="h-7 rounded-md border border-line bg-raised px-1.5 text-[12px] text-fg outline-none hover:border-line-strong focus:border-accent/60"
            >
              {modes.map((m) => (
                <option key={m} value={m}>
                  {modeLabel(m)}
                  {m === own ? " (this thread's)" : m === inherited ? " (thread default)" : ""}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" disabled={busy} onClick={() => setFeedback("")}>
            Keep planning
          </Button>
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      )}
      {open && feedback !== null && (
        <div className="mt-3 grid gap-2" ref={form}>
          <Textarea
            autoFocus
            rows={3}
            aria-label="What should change in the plan"
            placeholder="What should change? (optional)"
            value={feedback}
            disabled={busy}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                keepPlanning()
              }
              if (e.key === "Escape") {
                e.preventDefault()
                setFeedback(null)
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={keepPlanning}>
              <Send size={13} /> Keep planning
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setFeedback(null)}>
              Cancel
            </Button>
            {error && <span className="text-xs text-red-400">{error}</span>}
          </div>
        </div>
      )}
      {!open && data.status === "allowed" && data.mode && <div className="mt-1.5 text-[12px] text-faint">Continued in {modeLabel(data.mode)}.</div>}
    </Frame>
  )
})

/** How a board approval was answered, once it was. */
function Answer({ status, deletion }: { status: string; deletion?: boolean | undefined }) {
  return (
    <span
      className={clsx(
        "ml-auto rounded px-1.5 py-0.5 text-[11px]",
        status === "allowed" ? "bg-emerald-500/10 text-emerald-300" : status === "denied" ? "bg-red-500/10 text-red-300" : "bg-white/5 text-faint",
      )}
    >
      {status === "allowed" ? (deletion ? "confirmed" : "approved") : status === "denied" && deletion ? "kept" : status}
    </span>
  )
}

/** One of the board's own approvals in its thread: what it asks, Approve and Deny while it waits, and its answer once given. */
function ApprovalCard({ data, hostId, title, deletion }: { data: Any; hostId: string; title: ReactNode; deletion?: boolean }) {
  const pending = data.status === "pending"
  const respond = usePromptAnswers(hostId)
  const { busy, error, run } = useAsyncAction()
  const decide = (decision: "allow" | "deny") => void run(() => respond(data.request_id, { decision }))
  const Icon = deletion ? Trash2 : ShieldAlert
  return (
    <div
      className={clsx(
        "rounded-lg border p-3",
        pending ? (deletion ? "border-red-500/40 bg-red-500/[0.05]" : "border-st-attention/50 bg-st-attention/[0.06]") : "border-line bg-panel/60",
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-[13px]">
        <Icon size={15} className={pending ? (deletion ? "text-red-400" : "text-st-attention") : "text-faint"} />
        <span className={clsx("min-w-0 truncate", pending ? "text-fg" : "text-muted")}>{title}</span>
        {!pending && <Answer status={data.status} deletion={deletion} />}
      </div>
      {data.input?.reason && <div className="truncate text-[12px] text-faint">{data.input.reason}</div>}
      {pending && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant={deletion ? "danger" : "primary"} disabled={busy} onClick={() => decide("allow")}>
            <Check size={13} /> {deletion ? "Delete" : "Approve"}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => decide("deny")}>
            {deletion ? "Keep it" : "Deny"}
          </Button>
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      )}
    </div>
  )
}

const taskName = (t: Any): string => (t ? `${t.key ?? ""}${t.key && t.title ? " " : ""}${t.title ?? ""}` : "")

export function TaskDeletionCard({ data, hostId }: { data: Any; hostId: string }) {
  const others = data.input?.tasks_with_it?.length ?? 0
  return (
    <ApprovalCard
      data={data}
      hostId={hostId}
      deletion
      title={
        <>
          Delete the task <span className="font-medium">{taskName(data.input?.delete)}</span>
          {others > 0 && ` and its ${others} task${others === 1 ? "" : "s"}`}
        </>
      }
    />
  )
}

export function ProjectChangeCard({ data, hostId }: { data: Any; hostId: string }) {
  const name = data.input?.project?.name
  return (
    <ApprovalCard
      data={data}
      hostId={hostId}
      title={
        data.tool_name === "create_project" ? (
          <>
            Add the project <span className="font-medium">{name}</span>
          </>
        ) : (
          <>
            Change the project <span className="font-medium">{name}</span>
          </>
        )
      }
    />
  )
}

export function AutomationChangeCard({ data, hostId }: { data: Any; hostId: string }) {
  return <ApprovalCard data={data} hostId={hostId} title={data.input?.op === "delete" ? "Delete an automation?" : "Approve an automation?"} />
}

export function WorkflowChangeCard({ data, hostId }: { data: Any; hostId: string }) {
  return <ApprovalCard data={data} hostId={hostId} title={data.input?.op === "delete" ? "Delete a workflow?" : "Approve a workflow?"} />
}
