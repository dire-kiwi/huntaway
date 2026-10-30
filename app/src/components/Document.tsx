import clsx from "clsx";
import { ClipboardList, Code, Copy, Download, Eye, ListChecks, Loader2, MessagesSquare, NotebookPen, Sparkles, Workflow, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { api, hostSupports, type DocumentType, type Message, type Task, type TaskDocument, type TaskType } from "../api";
import { frameDoc } from "../htmlFrame";
import { afterSend, answered, answersMessage, loadAnswers, readFields, resetFields, saveAnswers, withTouched, type PlanAnswers, type PlanField } from "../planAnswers";
import { isWholePage, themedPlan } from "../planTheme";
import planCss from "../planTheme.css?raw";
import { useHost, useThreadMessages } from "../store";
import type { Progress } from "./Board";
import { Composer, Markdown } from "./Thread";
import { Button, CARD_BADGE, copyText, IconButton, ProgressCount, RunningDot, timeAgo, Wide } from "./ui";

/** What each label asks its task's agent for (API 70; types of task from API 42), in the order tasks show them. */
export const LABEL_INFO: { id: DocumentType; label: string; icon: ReactNode; file: string; hint: string }[] = [
  { id: "plan", label: "Plan", icon: <ClipboardList size={12} />, file: "plan.html", hint: "An HTML plan its agent writes and you iterate on together" },
  {
    id: "artifact",
    label: "Artifact",
    icon: <Sparkles size={12} />,
    file: "artifact.html",
    hint: "A designed HTML page: a document, explainer, dashboard or prototype, kept here rather than on claude.ai",
  },
  { id: "diagram", label: "Diagram", icon: <Workflow size={12} />, file: "diagram.mmd", hint: "A Mermaid diagram" },
];

/** A scratch task, which the new task dialog offers as a type: in no project (API 47), or in a project (API 51). */
export const SCRATCH_TYPE = {
  id: "scratch" as const,
  label: "Scratch",
  icon: <NotebookPen size={12} />,
  hint: "Its agent works in its own folder, with no worktree, on whatever you ask: in a project it reads the repository, in no project it has none",
};

export const documentInfo = (t: DocumentType) => LABEL_INFO.find((x) => x.id === t) ?? LABEL_INFO[0];

export const taskTypeInfo = (t: TaskType | DocumentType): { label: string; icon: ReactNode; hint: string; file?: string } =>
  t === "scratch" ? SCRATCH_TYPE : documentInfo(t);

/** A scratch task, or a task's label, on a card: what it is or makes, or for a plan, how the tasks it created are doing.
 *  `compact`: the icon, and the words once the card has room. */
export function TaskTypeBadge({ type, progress, compact }: { type: TaskType | DocumentType; progress?: Progress; compact?: boolean }) {
  const info = taskTypeInfo(type);
  if (compact)
    return (
      <span className={clsx(CARD_BADGE, "text-accent")} title={progress?.total ? `${info.label}: ${progress.done} of the ${progress.total} tasks it created are done` : `${info.label}: ${info.hint}`}>
        {info.icon} {progress?.total ? <ProgressCount progress={progress} /> : <Wide>{info.label.toLowerCase()}</Wide>}
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-accent" title={progress?.total ? `${info.label}: ${progress.done} of the ${progress.total} tasks it created are done` : info.hint}>
      {info.icon} {progress?.total ? `${progress.done}/${progress.total} done` : info.label.toLowerCase()}
    </span>
  );
}

/** What the agent last said, as the server's `last_assistant_text` finds it. */
function lastReply(messages: Message[] | undefined): string | null {
  for (const m of [...(messages ?? [])].reverse().slice(0, 50)) {
    if (m.kind !== "claude") continue;
    if (m.data?.type === "result" && typeof m.data.result === "string" && m.data.result) return m.data.result;
    if (m.data?.type === "assistant" && Array.isArray(m.data.message?.content)) {
      const text = m.data.message.content.filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text);
      if (text.length) return text.join("\n");
    }
  }
  return null;
}

function download(name: string, text: string, type: string) {
  // Saved as a file, never opened here: a page opened from a blob URL would run with the board's origin.
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A short hash of a document's content (FNV-1a), to tell its revisions apart. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}.${(h >>> 0).toString(36)}`;
}

/** Tasks whose plan answers are being sent (`host:task`). */
const answersSending = new Set<string>();
const ANSWERS_SENT = "ia-plan-answers";
/** How a send of a task's answers is going: `sentAsIs` (the answers it sent as they are) and `left` once it's done. */
type AnswersSent = { task: string; sending: boolean; error?: string; sentAsIs?: string[]; left?: number };

/**
 * Send the answers to a plan's questions (`fields`, of `version`) to its agent. It's done here rather than in the
 * view it's started from, which can go (and another open) before it ends: the answers saved then that are as they
 * were when it started go, and the rest are left to send.
 */
async function sendPlanAnswers(task: Task, fields: PlanField[], version: number) {
  const id = `${task.host_id}:${task.id}`;
  if (answersSending.has(id)) return;
  const tell = (d: Omit<AnswersSent, "task">) => dispatchEvent(new CustomEvent<AnswersSent>(ANSWERS_SENT, { detail: { task: id, ...d } }));
  answersSending.add(id);
  tell({ sending: true });
  const before = loadAnswers(task.host_id, task.id);
  try {
    await api.send(task.host_id, task.id, answersMessage(fields, version));
    const { answers, sentAsIs } = afterSend(before, loadAnswers(task.host_id, task.id));
    saveAnswers(task.host_id, task.id, answers);
    answersSending.delete(id);
    tell({ sending: false, sentAsIs, left: Object.keys(answers).length });
  } catch (e) {
    answersSending.delete(id);
    tell({ sending: false, error: (e as Error).message });
  }
}

/**
 * A task's document for one of its labels (a plan, artifact or diagram), as its agent writes it, with
 * the versions from earlier turns, and a composer to ask for changes.
 */
export function DocumentView({ task, label: type, onShowThread }: { task: Task; label: DocumentType; onShowThread: () => void }) {
  // Keyed by the task and label, so another starts over.
  const info = documentInfo(type);
  // Null follows the latest version.
  const [picked, setPicked] = useState<number | null>(null);
  const [doc, setDoc] = useState<TaskDocument | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [source, setSource] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .document(task.host_id, task.id, type, picked ?? undefined)
      .then((d) => {
        if (!live) return;
        setDoc(d);
        setErr(null);
      })
      .catch((e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [task.host_id, task.id, type, picked, task.document_at]);

  const messages = useThreadMessages(task.id);
  const reply = useMemo(() => (task.running ? null : lastReply(messages)), [messages, task.running]);

  const versions = doc?.versions ?? [];
  const latest = versions[versions.length - 1];
  const current = versions.find((v) => v.version === doc?.version);
  const content = doc?.content ?? null;
  const writing = !!current?.open && task.running;
  // An earlier version than the latest, whose questions can't be answered.
  const old = !!doc && !!latest && doc.version !== latest.version;
  // A plan in the board's theme, with its components, unless it's a whole page of its own.
  const ownPage = content !== null && (type === "artifact" || (type === "plan" && isWholePage(content)));
  const themed = type === "plan" && content !== null && !ownPage;

  // The plan's questions as its frame reports them, and the answers the user hasn't sent yet (put back in the
  // plan each time it reloads: after each change the agent makes, and on a new version).
  const frame = useRef<HTMLIFrameElement>(null);
  // The answers are kept in storage only, so a view of the task opened since (switching tabs makes another) and a
  // send started from an earlier one agree on them.
  const answers = () => loadAnswers(task.host_id, task.id);
  const keep = (saved: PlanAnswers) => saveAnswers(task.host_id, task.id, saved);
  // Which document the fields are from (formKey): the version and its content (a version is written over while the
  // agent's turn goes on), or null for an earlier version's, which can't be answered.
  const contentId = useMemo(() => (content === null ? "" : hash(content)), [content]);
  const formKey = old || !doc?.version || content === null ? null : `${doc.version}:${contentId}`;
  const [form, setFormState] = useState<{ fields: PlanField[]; key: string | null }>({ fields: [], key: null });
  // The latest, for Reset.
  const latestForm = useRef(form);
  const setForm = (f: { fields: PlanField[]; key: string | null }) => {
    latestForm.current = f;
    setFormState(f);
  };
  // Only the fields of the document shown: in the source view there's no frame to report another's.
  const fields = form.key !== null && form.key === formKey ? form.fields : [];
  const sendKey = `${task.host_id}:${task.id}`;
  const [sending, setSending] = useState(() => answersSending.has(sendKey));
  const [sent, setSent] = useState(false);
  const page = useMemo(() => (themed ? themedPlan(content!, planCss) : content), [content, themed]);
  // The frame reports its questions each time it loads, and as the user answers them.
  const onForm = (list: PlanField[], user: boolean, key: string | null, dropped: string[]) => {
    setForm({ fields: list, key });
    if (!user) setSent(false);
    if (!user || key === null) return;
    const saved = answers();
    for (const name of dropped) delete saved[name];
    keep(withTouched(saved, list));
    setSent(false);
  };
  const host = useHost(task.host_id);
  // Hosts before API 10 refuse messages while the agent is running (as in the composer).
  const canSend = !task.running || hostSupports(host, 10);
  // A send can end after this view is gone (and another is open): it says how it went to the views of the task.
  useEffect(() => {
    const onSent = (e: Event) => {
      const d = (e as CustomEvent<AnswersSent>).detail;
      if (d.task !== sendKey) return;
      setSending(d.sending);
      if (d.error) setErr(d.error);
      if (!d.sentAsIs) return;
      frame.current?.contentWindow?.postMessage({ iaFormSent: d.sentAsIs }, "*");
      const f = latestForm.current;
      setForm({ ...f, fields: f.fields.map((x) => (d.sentAsIs!.includes(x.name) ? { ...x, touched: false } : x)) });
      setSent(!d.left);
    };
    addEventListener(ANSWERS_SENT, onSent);
    return () => removeEventListener(ANSWERS_SENT, onSent);
  }, [sendKey]);
  const sendAnswers = () => {
    setErr(null);
    void sendPlanAnswers(task, fields, parseInt(form.key ?? "", 10));
  };
  const resetAnswers = () => {
    keep({});
    // Here as well as in the frame, which isn't there in the source view (and reports them again when it is).
    setForm({ ...latestForm.current, fields: resetFields(latestForm.current.fields) });
    frame.current?.contentWindow?.postMessage({ iaFormReset: true }, "*");
    setSent(false);
  };
  const questions = themed && fields.length > 0;
  const done = answered(fields);
  // A plan or diagram runs to the bottom, under the reply and the composer, and leaves room (`inset`) to
  // scroll clear of them. A page of its own design (an artifact) is often sized to the window, so it stops above them.
  const floating = !ownPage;
  const overlay = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const inset = floating ? height : 0;
  useEffect(() => {
    const el = overlay.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(Math.round(el.offsetHeight)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const sendFix = (error: string) =>
    api
      .send(task.host_id, task.id, `The diagram doesn't render. Mermaid says:\n\n\`\`\`\n${error}\n\`\`\`\n\nPlease fix it.`)
      .catch((e) => setErr((e as Error).message));

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px]">
        <span className="flex items-center gap-1.5 text-muted narrow:hidden">
          {info.icon} {info.label}
        </span>
        {versions.length > 0 && (
          <select
            className="h-6 rounded border border-line bg-panel px-1 text-[12px] text-fg outline-none"
            title="Versions: one from each turn that changed it"
            value={doc?.version ?? ""}
            onChange={(e) => {
              const v = Number(e.target.value);
              setPicked(v === latest?.version ? null : v);
            }}
          >
            {[...versions].reverse().map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} · {timeAgo(v.updated_at)}
                {v.version === latest?.version ? (v.open && task.running ? " (being written)" : " (latest)") : ""}
              </option>
            ))}
          </select>
        )}
        {writing && (
          <span className="flex items-center gap-1.5 text-muted">
            <RunningDot /> Writing…
          </span>
        )}
        {picked !== null && (
          <button className="text-accent hover:underline" onClick={() => setPicked(null)}>
            Back to the latest
          </button>
        )}
        {content !== null && (
          <div className="ml-auto flex items-center gap-1">
            <div className="flex items-center rounded-md border border-line p-0.5">
              {[
                { on: false, icon: <Eye size={12} />, label: "Preview" },
                { on: true, icon: <Code size={12} />, label: "Source" },
              ].map((m) => (
                <button
                  key={m.label}
                  onClick={() => setSource(m.on)}
                  aria-label={m.label}
                  className={clsx("flex h-5 items-center gap-1 rounded px-1.5 text-[11.5px] narrow:h-7 narrow:px-2", source === m.on ? "bg-raised text-fg" : "text-muted hover:text-fg")}
                >
                  {m.icon} <span className="narrow:hidden">{m.label}</span>
                </button>
              ))}
            </div>
            <IconButton title="Copy the source" onClick={() => copyText(content)}>
              <Copy size={13} />
            </IconButton>
            <IconButton title={`Download ${info.file}`} onClick={() => download(info.file, page ?? content, type === "diagram" ? "text/plain" : "text/html")}>
              <Download size={13} />
            </IconButton>
            {type === "diagram" && svg && (
              <Button size="sm" variant="ghost" title="Download the rendered diagram" onClick={() => download("diagram.svg", svg, "image/svg+xml")}>
                SVG
              </Button>
            )}
          </div>
        )}
      </div>
      {err && <div className="shrink-0 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-300">{err}</div>}
      <div className="relative min-h-0 flex-1">
        {doc === null && !err ? (
          <div className="flex h-full items-center justify-center text-muted">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : content === null ? (
          <div className="flex h-full items-center justify-center p-8" style={{ paddingBottom: inset + 32 }}>
            <div className="max-w-md rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">
              {task.running
                ? `The agent is working on the ${type}. It shows here as it's written.`
                : !task.session_id
                  ? `No ${type} yet. Press Start, or send instructions below, and its agent writes one here (in ${info.file} in the task's folder).`
                  : `The agent hasn't written the ${type} yet (it goes in ${info.file} in the task's folder). Ask it below.`}
            </div>
          </div>
        ) : source ? (
          <pre className="h-full overflow-auto p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fg/90" style={{ paddingBottom: inset + 16 }}>
            {content}
          </pre>
        ) : type === "diagram" ? (
          <MermaidView source={content} inset={inset} onSvg={setSvg} onFix={task.running ? undefined : sendFix} />
        ) : (
          <HtmlFrame
            frame={frame}
            html={themed ? content : (page ?? content)}
            plan={themed ? { readOnly: old, key: formKey, answers, onForm } : undefined}
            inset={inset}
            title={`${info.label}: ${task.title}`}
          />
        )}
      </div>
      <div
        ref={overlay}
        className={clsx(floating ? "pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-bg from-60% to-transparent pt-6" : "shrink-0 pt-2")}
      >
        {reply && (
          <div className="pointer-events-auto mx-auto w-full max-w-3xl px-5">
            <div className="max-h-28 overflow-y-auto rounded-lg border border-line bg-panel px-3 py-2 [&_.prose-chat]:text-[12.5px]!">
              <Markdown text={reply} />
            </div>
          </div>
        )}
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-5 pt-2 text-[12px] text-muted">
          {task.running && (
            <span className="flex items-center gap-1.5">
              <RunningDot /> {task.agent_wait ? "Waiting…" : "Working…"}
            </span>
          )}
          {questions && (
            <span className="pointer-events-auto flex items-center gap-2" title="The plan's questions: answer them in the plan, then send the answers to the agent">
              <ListChecks size={12} />
              {sent ? "Answers sent" : `${done} of ${fields.length} ${fields.length === 1 ? "question" : "questions"} answered`}
              {fields.some((f) => f.touched) && (
                <button className="hover:text-fg" onClick={resetAnswers} title="Put back the plan's own answers">
                  Reset
                </button>
              )}
              <Button
                size="sm"
                variant="primary"
                disabled={sending || sent || done === 0 || !canSend}
                onClick={sendAnswers}
                title={canSend ? "Send your answers to the agent, to update the plan with them" : "This host takes messages once the agent's turn ends"}
              >
                {sending ? <Loader2 size={12} className="animate-spin" /> : null} Send answers
              </Button>
            </span>
          )}
          <button className="pointer-events-auto ml-auto flex items-center gap-1 hover:text-fg" onClick={onShowThread} title="The whole conversation with its agent">
            <MessagesSquare size={12} /> Thread
          </button>
        </div>
        <div className="pointer-events-auto">
          <Composer key={task.id} task={task} placeholder={`Ask for changes to the ${type}…`} />
        </div>
      </div>
    </div>
  );
}

/**
 * An HTML page in a sandboxed frame: its scripts run, but in an origin of their own, so it can't
 * reach the board (or its token). It keeps its scroll position as the page changes, and leaves
 * `inset` pixels at its bottom for what covers it. With `plan`, `html` is a plan's content, shown in
 * the theme, with the answers to its questions that haven't been sent put back in each time it loads.
 */
function HtmlFrame({
  frame,
  html,
  title,
  inset,
  plan,
}: {
  frame: RefObject<HTMLIFrameElement | null>;
  html: string;
  title: string;
  inset: number;
  plan?: { readOnly: boolean; key: string | null; answers: () => PlanAnswers; onForm: (fields: PlanField[], user: boolean, key: string | null, dropped: string[]) => void };
}) {
  const scroll = useRef(0);
  const bottom = useRef(inset);
  bottom.current = inset;
  const form = useRef(plan?.onForm);
  form.current = plan?.onForm;
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      if (typeof e.data?.iaScroll === "number") scroll.current = e.data.iaScroll;
      const fields = readFields(e.data);
      if (!fields || !form.current) return;
      const dropped = Array.isArray(e.data.iaFormDropped) ? e.data.iaFormDropped.filter((n: unknown) => typeof n === "string") : [];
      form.current(fields, e.data.iaFormUser === true, typeof e.data.iaFormKey === "string" ? e.data.iaFormKey : null, dropped);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  const sendInset = () => frame.current?.contentWindow?.postMessage({ iaInset: bottom.current }, "*");
  useEffect(sendInset, [inset]);
  // Each change reloads the frame; this puts it back where it was scrolled to.
  // A plan is built here rather than by the caller, so that the answers put back in are those of the time it
  // loads, here as well as when the frame is mounted again.
  const themed = !!plan;
  const readOnly = !!plan?.readOnly;
  const key = plan?.key ?? undefined;
  const doc = useMemo(
    () => frameDoc(plan ? themedPlan(html, planCss, undefined, readOnly ? { readOnly } : { answers: plan.answers(), key }) : html, scroll.current, bottom.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, themed, readOnly, key],
  );
  return (
    <iframe
      ref={frame}
      title={title}
      srcDoc={doc}
      onLoad={sendInset}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals"
      referrerPolicy="no-referrer"
      className={clsx("block h-full w-full", plan ? "bg-bg" : "bg-white")}
    />
  );
}

type Mermaid = (typeof import("mermaid"))["default"];
let mermaidLoaded: Promise<Mermaid> | null = null;
// Mermaid is large; it loads with the first diagram.
const loadMermaid = () =>
  (mermaidLoaded ??= import("mermaid").then((m) => {
    m.default.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" });
    return m.default;
  }));
let renders = 0;

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** The width a Mermaid SVG is drawn at, from its viewBox. */
const svgWidth = (svg: string) => Number(/viewBox="[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)/.exec(svg)?.[1]) || null;

/**
 * A Mermaid diagram, rendered here. While its source doesn't parse, the last one that did stays,
 * under the error. It's shown as an image, where an SVG can't run scripts, in case something the
 * agent wrote gets past Mermaid's sanitizing.
 */
function MermaidView({ source, inset, onSvg, onFix }: { source: string; inset: number; onSvg: (svg: string | null) => void; onFix?: (error: string) => void }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Null fits the diagram to the width (no wider than its own size).
  const [zoom, setZoom] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const width = svg ? svgWidth(svg) : null;
  const src = useMemo(() => svg && `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, [svg]);
  useEffect(() => {
    let live = true;
    loadMermaid()
      .then(async (mermaid) => {
        const id = `ia-mermaid-${++renders}`;
        try {
          const { svg } = await mermaid.render(id, source);
          if (!live) return;
          setSvg(svg);
          setError(null);
          onSvg(svg);
        } catch (e) {
          // What a failed render leaves behind.
          document.getElementById(id)?.remove();
          document.getElementById(`d${id}`)?.remove();
          if (live) setError((e as Error)?.message ?? String(e));
        }
      })
      .catch((e) => live && setError(`Couldn't load Mermaid: ${(e as Error).message}`));
    return () => {
      live = false;
    };
  }, [source, onSvg]);
  const step = (dir: 1 | -1) => {
    const now = zoom ?? (width && box.current ? Math.min(1, box.current.clientWidth / width) : 1);
    const next = dir > 0 ? ZOOMS.find((z) => z > now + 0.01) : [...ZOOMS].reverse().find((z) => z < now - 0.01);
    if (next) setZoom(next);
  };
  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="flex shrink-0 items-start gap-3 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
          <pre className="min-w-0 flex-1 font-mono text-[11.5px] whitespace-pre-wrap">{error}</pre>
          {onFix && (
            <Button size="sm" onClick={() => onFix(error)} title="Send the error to the agent">
              Ask the agent to fix it
            </Button>
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={box} className="h-full overflow-auto p-6" style={{ paddingBottom: inset + 24 }}>
          {src && (
            <img
              src={src}
              alt="Diagram"
              className={clsx("mx-auto block max-w-none", error && "opacity-40")}
              style={zoom === null ? { width: "100%", maxWidth: width ?? undefined } : { width: width ? width * zoom : undefined }}
            />
          )}
          {!svg && !error && (
            <div className="flex h-full items-center justify-center text-muted">
              <Loader2 size={16} className="animate-spin" />
            </div>
          )}
        </div>
        {svg && (
          <div style={{ bottom: inset + 12 }} className="absolute right-3 flex items-center gap-0.5 rounded-md border border-line bg-panel/90 p-0.5 text-[11.5px] text-muted">
            <IconButton title="Zoom out" onClick={() => step(-1)}>
              <ZoomOut size={13} />
            </IconButton>
            <button className="h-6 min-w-11 rounded px-1 hover:text-fg" title="Fit to the width" onClick={() => setZoom(null)}>
              {zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`}
            </button>
            <IconButton title="Zoom in" onClick={() => step(1)}>
              <ZoomIn size={13} />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  );
}
