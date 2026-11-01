// Questions and plans from agents, as cards in the thread: a question asked with the board's
// request_user_input (a "question" message), Claude's AskUserQuestion and Codex's questions
// (permission prompts, answered with the user's answers), and a plan from plan mode's ExitPlanMode
// (approved, or sent back with feedback). They look like the questions in plan documents
// (<ia-question>, planTheme.css).

import clsx from "clsx";
import { Check, ChevronRight, Map as MapIcon, MessageCircleQuestion, Send, X } from "lucide-react";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { api, hostSupports, PERMISSION_MODES, type PermissionMode } from "../api";
import { useHost, useProject, useStore } from "../store";
import { askedAnswers, declinedWithAnswers, planTitle, questionsOf, withoutTitle, type AskedQuestion } from "../questions";
import { Button, Textarea } from "./ui";
import { Markdown } from "./Thread";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** The host API that takes answers and a plan's mode with a prompt's decision, and answers questions from their cards. */
export const QUESTIONS_API = 64;

// ---------- keys 1–9 ----------

/** The cards waiting for an answer, each with its message's id and what keys 1–9 do in it: the latest one shown gets them. */
type Keyed = { id: number; el: () => HTMLElement | null; pick: (n: number) => void };
const keyed = new Set<Keyed>();

function onDigit(e: KeyboardEvent) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat || !/^[1-9]$/.test(e.key)) return;
  const t = e.target as HTMLElement | null;
  // Typing a number somewhere.
  if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
  // Not one in a part of the thread that's hidden (the main conversation, while a subagent's is shown in its place).
  const shown = [...keyed].filter((k) => !!k.el()?.getClientRects().length);
  if (!shown.length) return;
  const card = shown.reduce((a, b) => (b.id > a.id ? b : a));
  // Nor one behind a dialog it isn't in.
  const dialogs = document.querySelectorAll('[aria-modal="true"]');
  if (dialogs.length && !dialogs[dialogs.length - 1].contains(card.el())) return;
  e.preventDefault();
  card.pick(Number(e.key));
}

/** While `on`, keys 1–9 call `pick` (with the number) for the card `ref` is on, if it's the thread's latest such card (message `id`). */
function useDigitKeys(id: number, on: boolean, ref: React.RefObject<HTMLElement | null>, pick: (n: number) => void) {
  const latest = useRef(pick);
  latest.current = pick;
  useEffect(() => {
    if (!on) return;
    const entry: Keyed = { id, el: () => ref.current, pick: (n) => latest.current(n) };
    if (!keyed.size) document.addEventListener("keydown", onDigit);
    keyed.add(entry);
    return () => {
      keyed.delete(entry);
      if (!keyed.size) document.removeEventListener("keydown", onDigit);
    };
  }, [id, on, ref]);
}

// ---------- pieces ----------

/** A card's frame: the left border of a plan document's question while it waits for an answer. */
function Frame({ pending, children, cardRef, label }: { pending: boolean; children: ReactNode; cardRef?: React.Ref<HTMLDivElement>; label: string }) {
  return (
    <div
      ref={cardRef}
      role="group"
      aria-label={label}
      className={clsx(
        "rounded-lg border p-3",
        pending ? "border-line border-l-[3px] border-l-st-attention bg-panel" : "border-line bg-panel/60",
      )}
    >
      {children}
    </div>
  );
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
  );
}

type Option = { label: string; description?: string; preview?: string };

/**
 * One choice of a question: a numbered row (its number is its key while the question's the one keys pick in), ticked
 * when it's picked. Shown as picked or not, and not clickable, once the question's answered.
 */
function Choice({ option, n, picked, multi, onPick, disabled, keys }: {
  option: Option;
  n: number;
  picked: boolean;
  multi: boolean;
  onPick?: () => void;
  disabled?: boolean;
  keys: boolean;
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
  );
}

/** A free-text answer: picked as soon as there's text in it. Enter sends it when `onEnter` is given. */
function OtherField({ value, onChange, placeholder, disabled, secret, onEnter, label }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  disabled?: boolean;
  secret?: boolean;
  onEnter?: () => void;
  label: string;
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
          e.preventDefault();
          onEnter();
        }
      }}
      className={clsx(
        "h-8 w-full rounded-md border bg-panel-2 px-2.5 text-[13px] text-fg placeholder:text-faint outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/15",
        value.trim() ? "border-accent/60" : "border-line",
      )}
    />
  );
}

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, run };
}

// ---------- request_user_input ----------

/**
 * A question an agent asked with the board's request_user_input. With options, picking one answers it (or, when it
 * takes several, ticking them and Send), and keys 1–9 pick them; a free-text answer goes with Send or Enter. Answering
 * sends the answer as the user's message. Without options, the reply is typed in the thread as before. Once a message
 * has been sent to the agent after it (`movedOn`), it isn't answered any more.
 */
export const BoardQuestionCard = memo(function BoardQuestionCard({ id, data, hostId, taskId, movedOn }: {
  id: number;
  data: Any;
  hostId: string;
  taskId: string;
  movedOn: boolean;
}) {
  const options: Option[] = Array.isArray(data.options) ? data.options : [];
  const multi = !!data.multi_select;
  const other = data.allow_other !== false;
  const pending = data.status === "pending" && !movedOn;
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const { busy, err, run } = useBusy();
  const ref = useRef<HTMLDivElement>(null);
  const answer = (choices: string[], typed: string) => run(() => api.answerQuestion(hostId, taskId, id, { choices, text: typed.trim() || null }));
  const pick = (label: string) => {
    if (busy) return;
    if (!multi) return void answer([label], "");
    setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
  };
  useDigitKeys(id, pending && options.length > 0 && !busy, ref, (n) => options[n - 1] && pick(options[n - 1].label));
  const answered: { choices?: string[]; text?: string | null } = data.answer ?? {};
  const shown = pending ? picked : answered.choices ?? [];
  const canSend = multi ? picked.length > 0 || !!text.trim() : !!text.trim();
  // The board's own question, whether to merge (API 89): answering it is the decision, not a message to the agent.
  const merge = data.merge_approval === true;
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
        {data.status === "replaced" && <Outcome tone="plain">not answered</Outcome>}
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
        <div className="mt-2 rounded-md border-l-2 border-line-strong bg-white/[0.03] px-3 py-1.5 text-[13px] whitespace-pre-wrap text-muted">{answered.text}</div>
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
      {err && <div className="mt-1.5 text-xs text-red-400">{err}</div>}
    </Frame>
  );
});

// ---------- AskUserQuestion, and Codex's questions ----------

type Draft = { picked: string[]; other: string };

/**
 * The questions of Claude's AskUserQuestion (or Codex's request_user_input), each with its options and descriptions, a
 * free-text answer (Claude always takes one; Codex says which questions do), and several picks where a question takes
 * them. Keys 1–9 pick in the question that's current; picking the one answer of a question moves on to the next, and
 * answers a lone question outright. The answers go back to the agent as its tool's answers. A question whose run ended
 * first can still be answered, until a message is sent to the agent after it (`movedOn`): the answers go as the user's message.
 */
export const AskCard = memo(function AskCard({ id, data, hostId, from, movedOn }: { id: number; data: Any; hostId: string; from?: ReactNode; movedOn: boolean }) {
  const questions = questionsOf(data);
  const codex = data.agent === "codex" || data.tool_name === "request_user_input";
  const host = useHost(hostId);
  const structured = hostSupports(host, QUESTIONS_API);
  // A run that ended first: answerable by message, by hosts that do that, while the conversation hasn't moved on.
  const late = data.status === "expired" && structured && !movedOn;
  const open = data.status === "pending" || late;
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => ({ picked: [], other: "" })));
  const [current, setCurrent] = useState(0);
  const { busy, err, run } = useBusy();
  const ref = useRef<HTMLDivElement>(null);
  // A typed answer goes with the options ticked, or in place of the one picked.
  const answerOf = (q: AskedQuestion, d: Draft) => {
    const typed = d.other.trim() ? [d.other.trim()] : [];
    return q.multiSelect ? [...d.picked, ...typed] : typed.length ? typed : d.picked;
  };
  const answers = questions.map((q, i) => answerOf(q, drafts[i] ?? { picked: [], other: "" }));
  const complete = answers.every((a) => a.length > 0);
  const submit = (list = answers) =>
    run(() =>
      structured
        ? api.resolvePermission(hostId, data.request_id, "allow", undefined, { answers: list })
        : // A host that can't give the tool the answers: it's declined with them, so the agent still gets them.
          api.resolvePermission(hostId, data.request_id, "deny", declinedWithAnswers(questions, list)),
    );
  const dismiss = () => run(() => api.resolvePermission(hostId, data.request_id, "deny", "The user dismissed these questions without answering them."));
  const set = (i: number, d: Partial<Draft>) => setDrafts((all) => all.map((x, j) => (j === i ? { ...x, ...d } : x)));
  const pick = (i: number, label: string) => {
    const q = questions[i];
    if (!q || busy) return;
    if (q.multiSelect) {
      const p = drafts[i].picked;
      return set(i, { picked: p.includes(label) ? p.filter((x) => x !== label) : [...p, label] });
    }
    const next = drafts.map((x, j) => (j === i ? { picked: [label], other: "" } : x));
    setDrafts(next);
    if (questions.length === 1) return void submit([[label]]);
    // On to the next question that isn't answered yet.
    const after = questions.findIndex((qq, j) => j > i && !answerOf(qq, next[j]).length);
    setCurrent(after >= 0 ? after : i);
  };
  useDigitKeys(id, open && !busy, ref, (n) => {
    const o = questions[current]?.options[n - 1];
    if (o) pick(current, o.label);
  });
  const shown = askedAnswers(data);
  const asker = codex ? "Codex" : "Claude";
  const header = open
    ? `${asker} ${questions.length === 1 ? "asks" : `asks ${questions.length} questions`}`
    : `${asker} asked ${questions.length === 1 ? "a question" : `${questions.length} questions`}`;
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
            <Outcome tone="plain">{data.status}</Outcome>
          ))}
      </div>
      {late && (
        <div className="mb-2 rounded-md bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-muted">
          The agent's run ended before these were answered. Your answers go to it as your message.
        </div>
      )}
      <div className="grid gap-3">
        {questions.map((q, i) => {
          const d = drafts[i] ?? { picked: [], other: "" };
          const given = shown?.[i];
          const active = open && i === current && questions.length > 1;
          const takesOther = !codex || q.isOther !== false;
          const picked = open ? (q.multiSelect ? d.picked : d.other.trim() ? [] : d.picked) : given ?? [];
          const preview = q.options.find((o) => picked.includes(o.label) && o.preview)?.preview;
          return (
            <div
              key={i}
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
                    multi={!!q.multiSelect}
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
          );
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
          {err && <span className="text-xs text-red-400">{err}</span>}
        </div>
      )}
    </Frame>
  );
});

// ---------- ExitPlanMode ----------

/** What a plan's sent back with, by a host that doesn't take feedback (before API 64; server: permissions::answer). */
const KEEP_PLANNING = "The user wants you to keep planning rather than start on this plan.";

/** Modes a thread can carry on in once its plan's approved, as Claude Code offers them. */
const AFTER_PLAN: PermissionMode[] = ["default", "acceptEdits", "auto", "bypassPermissions"];
const modeLabel = (m: PermissionMode) => PERMISSION_MODES.find((x) => x.id === m)?.label ?? m;

/**
 * A plan presented with ExitPlanMode: the plan as Markdown, **Approve** (which takes the thread out of Plan mode, into
 * the mode picked beside it) and **Keep planning**, which sends the agent back to it with the user's feedback. As with
 * questions, one whose run ended first is answered by message until the conversation moves on (`movedOn`).
 */
export const PlanCard = memo(function PlanCard({ data, hostId, taskId, from, movedOn }: {
  data: Any;
  hostId: string;
  taskId: string;
  from?: ReactNode;
  movedOn: boolean;
}) {
  const plan: string = typeof data.input?.plan === "string" ? data.input.plan : "";
  const host = useHost(hostId);
  const structured = hostSupports(host, QUESTIONS_API);
  const late = data.status === "expired" && structured && !movedOn;
  const open = data.status === "pending" || late;
  const task = useStore((s) => s.tasks[taskId]);
  const project = useProject(task?.project_id);
  const hostMode = useStore((s) => s.hostSettings[hostId]?.default_permission_mode);
  // What it carries on in unless another's picked: the thread's own mode, if it has one other than Plan (the agent
  // went into plan mode by itself), else its default without Plan, as approving does on its own.
  const inherited: PermissionMode = project?.permission_mode ?? hostMode ?? "default";
  const own = task?.permission_mode !== "plan" ? task?.permission_mode : null;
  const [mode, setMode] = useState<PermissionMode>(own ?? (inherited === "plan" ? "default" : inherited));
  const modes = AFTER_PLAN.includes(mode) ? AFTER_PLAN : [...AFTER_PLAN, mode];
  const [expanded, setExpanded] = useState(open);
  const [feedback, setFeedback] = useState<string | null>(null);
  const { busy, err, run } = useBusy();
  const form = useRef<HTMLDivElement>(null);
  const asking = feedback !== null;
  useEffect(() => setExpanded(open), [open]);
  // Its buttons may be under the composer.
  useEffect(() => {
    if (asking) form.current?.scrollIntoView({ block: "nearest" });
  }, [asking]);
  const approve = () => run(() => api.resolvePermission(hostId, data.request_id, "allow", undefined, structured ? { mode } : undefined));
  const keepPlanning = () => {
    const f = feedback?.trim() ?? "";
    return run(() =>
      structured
        ? api.resolvePermission(hostId, data.request_id, "deny", undefined, { feedback: f })
        : api.resolvePermission(hostId, data.request_id, "deny", `${KEEP_PLANNING}${f ? ` Their feedback:\n\n${f}` : ""}`),
    );
  };
  const title = planTitle(plan);
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
            <Outcome tone="plain">{data.status}</Outcome>
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
        <div className="mt-2 rounded-md border-l-2 border-line-strong bg-white/[0.03] px-3 py-1.5 text-[13px] whitespace-pre-wrap text-muted">{data.feedback}</div>
      )}
      {open && feedback === null && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={approve}>
            <Check size={13} /> Approve
          </Button>
          {structured && (
            <label className="flex items-center gap-1.5 text-[12px] text-faint">
              and continue in
              <select
                aria-label="Mode to continue in"
                value={mode}
                disabled={busy}
                onChange={(e) => setMode(e.target.value as PermissionMode)}
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
          )}
          <Button size="sm" disabled={busy} onClick={() => setFeedback("")}>
            Keep planning
          </Button>
          {err && <span className="text-xs text-red-400">{err}</span>}
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
                e.preventDefault();
                keepPlanning();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setFeedback(null);
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
            {err && <span className="text-xs text-red-400">{err}</span>}
          </div>
        </div>
      )}
      {!open && data.status === "allowed" && data.mode && <div className="mt-1.5 text-[12px] text-faint">Continued in {modeLabel(data.mode)}.</div>}
    </Frame>
  );
});
