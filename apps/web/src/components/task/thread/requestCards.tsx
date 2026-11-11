import { clsx } from "clsx"
import { Map as MapIcon, MessageCircleQuestion, ShieldAlert, Trash2 } from "lucide-react"
import type { ReactNode } from "react"
import { Markdown } from "./Markdown"
import type { Any } from "./threadModel"

// What the thread's requests carry, drawn as the old cards drew them (task/Questions.tsx and task/Approvals.tsx):
// questions with their options and the answers given, a plan, and the board's own approvals (a project's change, a
// task's deletion, an automation or a workflow). Answering them, with their buttons, keys and fields, is plan task 3.3,
// which brings the old cards over whole; until then a card shows what is asked and what became of it.

/** A question as AskUserQuestion asks it (the old src/questions.ts `questionsOf`). */
interface AskedQuestion {
  readonly question: string
  readonly header: string | undefined
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string | undefined }>
  readonly multiSelect: boolean
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
        .map((o: Any) =>
          typeof o === "string" ? { label: o, description: undefined } : { label: str(o?.label), description: str(o?.description) || undefined },
        )
        .filter((o: { label: string }) => o.label),
      multiSelect: q.multiSelect === true,
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

function Frame({ pending, children, label }: { pending: boolean; children: ReactNode; label: string }) {
  return (
    <div
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

/** One choice of a question, shown picked or not (picking it is 3.3's). */
function Choice({ label, description, picked }: { label: string; description: string | undefined; picked: boolean }) {
  return (
    <div
      role="radio"
      aria-checked={picked}
      className={clsx(
        "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[13px]",
        picked ? "border-accent/60 bg-accent/10" : "border-line bg-panel-2/60",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-fg">{label}</span>
        {description && description !== label && <span className="block text-[12px] text-muted">{description}</span>}
      </span>
    </div>
  )
}

/** Questions the agent asked with AskUserQuestion (or Codex's requestUserInput), with the answers once given. */
export function AskCard({ data, from, movedOn }: { id: number; data: Any; hostId: string; from?: ReactNode; movedOn: boolean }) {
  const questions = questionsOf(data)
  const open = data.status === "pending" && !movedOn
  const asker = data.agent === "codex" ? "Codex" : "Claude"
  const header = open
    ? `${asker} ${questions.length === 1 ? "asks" : `asks ${questions.length} questions`}`
    : `${asker} asked ${questions.length === 1 ? "a question" : `${questions.length} questions`}`
  const shown = askedAnswers(data)
  return (
    <Frame pending={open} label={`Questions from ${asker}`}>
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
            <Outcome tone="plain">{movedOn && data.status === "pending" ? "not answered" : data.status}</Outcome>
          ))}
      </div>
      <div className="grid gap-3">
        {questions.map((q, i) => {
          const picked = shown?.[i] ?? []
          return (
            <div key={q.question} className={clsx("rounded-md", questions.length > 1 && "border-l-2 border-l-line py-0.5 pl-2.5")}>
              <div className="mb-1 flex items-baseline gap-2">
                {q.header && <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-px text-[11px] text-muted">{q.header}</span>}
                <span className={clsx("text-[13.5px] font-semibold", open ? "text-fg" : "text-muted")}>{q.question}</span>
                {q.multiSelect && open && <span className="shrink-0 text-[11px] text-faint">pick any</span>}
              </div>
              <div className="grid gap-1.5" role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question}>
                {q.options.map((o) => (
                  <Choice key={o.label} label={o.label} description={o.description} picked={picked.includes(o.label)} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </Frame>
  )
}

/** A question the board asked (request_user_input, or whether to merge), with its answer once given. */
export function BoardQuestionCard({ data, movedOn }: { id: number; data: Any; hostId: string; taskId: string; movedOn: boolean }) {
  const options: Array<{ label: string; description?: string }> = (Array.isArray(data.options) ? data.options : [])
    .map((o: Any) => (typeof o === "string" ? { label: o } : { label: str(o?.label), description: str(o?.description) || undefined }))
    .filter((o: { label: string }) => o.label)
  const pending = data.status === "pending" && !movedOn
  const answered: { choices?: string[]; text?: string | null } = data.answer ?? {}
  const merge = data.merge_approval === true
  return (
    <Frame pending={pending} label={merge ? "Merge approval" : "Question from the agent"}>
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
        {data.status === "replaced" && <Outcome tone="plain">not answered</Outcome>}
        {data.status === "pending" && movedOn && <Outcome tone="plain">not answered</Outcome>}
      </div>
      <div className={clsx("text-[13.5px] font-semibold whitespace-pre-wrap", pending ? "text-fg" : "text-muted")}>{data.question}</div>
      {options.length > 0 && (
        <div className="mt-2 grid gap-1.5" role={data.multi_select ? "group" : "radiogroup"} aria-label={data.question}>
          {options.map((o) => (
            <Choice key={o.label} label={o.label} description={o.description} picked={(answered.choices ?? []).includes(o.label)} />
          ))}
        </div>
      )}
      {!pending && answered.text && <div className="mt-2 text-[13px] whitespace-pre-wrap text-muted">{answered.text}</div>}
    </Frame>
  )
}

/** A plan the agent asks to start on (ExitPlanMode), and what became of it. */
export function PlanCard({ data, from, movedOn }: { data: Any; hostId: string; taskId: string; from?: ReactNode; movedOn: boolean }) {
  const plan: string = typeof data.input?.plan === "string" ? data.input.plan : ""
  const open = data.status === "pending" && !movedOn
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
            <Outcome tone="plain">{movedOn && data.status === "pending" ? "not answered" : data.status}</Outcome>
          ))}
      </div>
      <div className={clsx("overflow-auto rounded-md border border-line bg-panel-2 px-3.5 py-2.5", open && "max-h-[28rem]")}>
        {plan ? <Markdown text={withoutTitle(plan)} /> : <span className="text-[12px] text-faint">(The plan is empty.)</span>}
      </div>
    </Frame>
  )
}

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

/** One of the board's own approvals in its thread: what it asks, and its answer once given. */
function ApprovalCard({ data, title, deletion }: { data: Any; title: ReactNode; deletion?: boolean }) {
  const pending = data.status === "pending"
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
    </div>
  )
}

const taskName = (t: Any): string => (t ? `${t.key ?? ""}${t.key && t.title ? " " : ""}${t.title ?? ""}` : "")

export function TaskDeletionCard({ data }: { data: Any; hostId: string }) {
  const others = data.input?.tasks_with_it?.length ?? 0
  return (
    <ApprovalCard
      data={data}
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

export function ProjectChangeCard({ data }: { data: Any; hostId: string }) {
  const name = data.input?.project?.name
  return (
    <ApprovalCard
      data={data}
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

export function AutomationChangeCard({ data }: { data: Any; hostId: string }) {
  return <ApprovalCard data={data} title={data.input?.op === "delete" ? "Delete an automation?" : "Approve an automation?"} />
}

export function WorkflowChangeCard({ data }: { data: Any; hostId: string }) {
  return <ApprovalCard data={data} title={data.input?.op === "delete" ? "Delete a workflow?" : "Approve a workflow?"} />
}
