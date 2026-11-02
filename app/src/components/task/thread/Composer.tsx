import clsx from "clsx";
import { ArrowUp, Clock, Loader2, MessageSquare, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, dependencyQueued, limitQueued, hostSupports, runningAgentSteers, stopTitle, type RewindResult, type Task } from "../../../api";
import { useHost } from "../../../store";
import { splitAttachments, withAttachments, type AttachmentRef } from "../../../attachments";
import { lineRange, removeComments, reviewMessage, useReview, withComments, type LineComment } from "../../changes/lineComments";
import { AttachButton, AttachmentList, DraftAttachments, useAttachmentDraft } from "../Attachments";
import { SkillHint, SkillMenu, useSkillMenu } from "../SkillMenu";
import { useTouch } from "../../../narrow";
import { RewindNote } from "../Rewind";
import { ModeSelect, useModeControl } from "./ModeSelect";

/** The diff's comments waiting to go with the next message: each one's file and lines, and its note. */
function ComposerComments({ task, comments }: { task: Task; comments: LineComment[] }) {
  return (
    <div className="border-b border-line px-4 py-2" data-comments>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-faint">
        <MessageSquare size={11} className="text-accent" />
        {comments.length === 1 ? "A comment" : `${comments.length} comments`} on the diff, sent with this message
      </div>
      <div className="flex flex-wrap gap-1.5">
        {comments.map((c) => (
          <span
            key={c.id}
            title={`${c.path}, ${lineRange(c)} (${c.source})\n\n${c.note}`}
            className="flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-line-strong bg-raised py-0.5 pr-0.5 pl-2 text-[11.5px]"
          >
            <span className="shrink-0 font-mono text-muted">
              {c.path.split("/").pop()}:{c.start === c.end ? c.start : `${c.start}–${c.end}`}
            </span>
            <span className="max-w-[28ch] min-w-0 truncate text-fg">{c.note}</span>
            <button
              onClick={() => removeComments(task.host_id, task.id, [c.id])}
              title="Remove the comment"
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-faint hover:bg-white/10 hover:text-fg"
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

function QueuedMessage({ text, hostId }: { text: string; hostId: string }) {
  const { text: body, files } = splitAttachments(text);
  return (
    <>
      {body && <div className="line-clamp-4 text-[13px] whitespace-pre-wrap text-muted">{body}</div>}
      <AttachmentList hostId={hostId} files={files} className="mt-1" />
    </>
  );
}

/** What's been written to a task's agent and not sent, so another tab, task or a reload doesn't lose it. */
const composerDraftKey = (task: Task) => `ia.composer.draft.${task.host_id}:${task.id}`;

type ComposerDraft = { text: string; files: AttachmentRef[] };

/** The drafts as last written on this page, for when the browser's storage can't take them (full, or turned off). */
const pageDrafts = new Map<string, ComposerDraft | null>();

function loadComposerDraft(key: string): ComposerDraft | null {
  if (pageDrafts.has(key)) return pageDrafts.get(key)!;
  try {
    const d = JSON.parse(localStorage.getItem(key) ?? "null");
    return d && typeof d.text === "string" ? { text: d.text, files: Array.isArray(d.files) ? d.files : [] } : null;
  } catch {
    return null;
  }
}

/** Whether the browser kept it: if not, it's only kept while the page is open. */
function saveComposerDraft(key: string, text: string, files: AttachmentRef[]) {
  const empty = !text.trim() && !files.length;
  pageDrafts.set(key, empty ? null : { text, files });
  try {
    if (empty) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ text, files }));
    return true;
  } catch {
    return false;
  }
}

/** `typed` once `sent` has gone: what was typed after it while it was sending, or all of it if what was sent was changed. */
export const afterSent = (typed: string, sent: string) => (sent && typed.startsWith(sent) ? typed.slice(sent.length).replace(/^\s+/, "") : typed);

/** How a send ended: what went (text as typed, and files), or why it didn't. */
type SendEnd = { sent: string; files: AttachmentRef[] } | { error: string };

/**
 * Messages being sent, by draft key, and the composers showing that draft. They're kept here, not in the composer
 * that sent them: it can be gone (another tab or card) before the host answers, and a composer opened meanwhile
 * shows the send under way, and takes what was sent off its draft once it's gone.
 */
const sending = new Map<string, number>();
const sendWatchers = new Map<string, Set<(end: SendEnd) => void>>();

/** Sends a message: what was typed (`sent`), the files attached and the diff comments in it (by id) come off the draft once it's gone. */
async function sendDraft(key: string, task: Task, body: string, sent: string, files: AttachmentRef[], comments: string[] = []): Promise<SendEnd> {
  sending.set(key, (sending.get(key) ?? 0) + 1);
  let end: SendEnd;
  try {
    await api.send(task.host_id, task.id, body);
    // Off the saved draft as well, for when no composer shows it.
    const d = loadComposerDraft(key);
    if (d) saveComposerDraft(key, afterSent(d.text, sent), d.files.filter((f) => !files.some((x) => x.id === f.id)));
    removeComments(task.host_id, task.id, comments);
    end = { sent, files };
  } catch (e) {
    end = { error: (e as Error).message };
  }
  const n = (sending.get(key) ?? 1) - 1;
  if (n) sending.set(key, n);
  else sending.delete(key);
  for (const watch of sendWatchers.get(key) ?? []) watch(end);
  return end;
}

/** Sends the task's diff comments (from the Changes tab) on their own, as the composer would with nothing typed. */
export const sendComments = (task: Task, comments: LineComment[]) =>
  sendDraft(
    composerDraftKey(task),
    task,
    reviewMessage(comments),
    "",
    [],
    comments.map((c) => c.id),
  );

/** The composers showing each draft, to put text into. */
const composerFills = new Map<string, (text: string, files: AttachmentRef[]) => void>();

/**
 * After a rewind that took the conversation back: the message rewound to goes into the task's composer (ahead of
 * what's there), to edit and send again. Not the board's own messages (a review's issues, say).
 */
export function rewound(task: Task, r: RewindResult, conversation: boolean) {
  if (!conversation || r.message.auto || !r.message.text?.trim()) return;
  const { text, files } = splitAttachments(r.message.text.trim());
  const key = composerDraftKey(task);
  const fill = composerFills.get(key);
  if (fill) return fill(text, files);
  const d = loadComposerDraft(key);
  saveComposerDraft(key, d?.text.trim() ? `${text}\n\n${d.text}` : text, [...files, ...(d?.files ?? [])]);
}

export function Composer({ task, placeholder }: { task: Task; placeholder?: string }) {
  const draftKey = composerDraftKey(task);
  const [saved] = useState(() => loadComposerDraft(draftKey));
  const [text, setText] = useState(saved?.text ?? "");
  const [busy, setBusy] = useState(() => sending.has(draftKey));
  const [err, setErr] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Set by Escape, so the next Shift+Tab leaves the field rather than cycling the permission mode.
  const tabLeaves = useRef(false);
  const modeControl = useModeControl(task);
  // Hosts before API 10 refuse messages while the agent is running.
  const host = useHost(task.host_id);
  const canQueue = hostSupports(host, 10);
  // A message goes to the running agent straight away, if its run takes them.
  const canSteer = runningAgentSteers(host, task);
  // On a touch screen's keyboard Enter starts a new line, and the send button sends (as Ctrl/Cmd+Enter does).
  const touch = useTouch();
  const enter = touch ? "" : " (Enter)";
  const blocked = task.running && !canQueue;
  const attach = useAttachmentDraft(task.host_id, hostSupports(host, 18), saved?.files);
  const skills = useSkillMenu(task, text, setText);
  // Comments on lines of the diff (the Changes tab's), which go with the message.
  const { comments } = useReview(task.host_id, task.id);
  // Saved as it's written. Files still uploading are left out until they're on the host.
  const draftJson = JSON.stringify({ text, files: attach.files });
  useEffect(() => {
    const { text, files } = JSON.parse(draftJson);
    setUnsaved(!saveComposerDraft(draftKey, text, files));
  }, [draftKey, draftJson]);
  // A send of this draft that ends, from this composer or one that was here before: only what was sent goes, and text
  // typed and files added while it was sending stay.
  const { drop } = attach;
  useEffect(() => {
    const watch = (end: SendEnd) => {
      setBusy(sending.has(draftKey));
      if ("error" in end) return setErr(end.error);
      setText((cur) => afterSent(cur, end.sent));
      drop(end.files);
    };
    const watchers = sendWatchers.get(draftKey) ?? new Set();
    watchers.add(watch);
    sendWatchers.set(draftKey, watchers);
    return () => {
      watchers.delete(watch);
      if (!watchers.size) sendWatchers.delete(draftKey);
    };
  }, [draftKey, drop]);

  const fitText = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 260) + "px";
  };
  useLayoutEffect(fitText, [text]);
  // And when it gets wider or narrower, which wraps the text again (a phone turned round, say).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitText();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A rewound message to edit and send again (see `rewound`).
  const restore = useRef(attach.restore);
  restore.current = attach.restore;
  useEffect(() => {
    composerFills.set(draftKey, (fill, files) => {
      setText((cur) => (cur.trim() ? `${fill}\n\n${cur}` : fill));
      restore.current(files);
      ref.current?.focus();
    });
    return () => void composerFills.delete(draftKey);
  }, [draftKey]);

  const send = () => {
    const files = attach.files;
    const body = withAttachments(withComments(text, comments), files);
    if (blocked || busy || attach.uploading) return;
    if (!body && (task.session_id || task.running)) return;
    setBusy(true);
    setErr(null);
    void sendDraft(
      draftKey,
      task,
      body,
      text,
      files,
      comments.map((c) => c.id),
    );
  };

  /** Take the queued message back into the composer to edit it. */
  const unqueue = async () => {
    setErr(null);
    try {
      const { text: queued, files } = splitAttachments((await api.unqueue(task.host_id, task.id)).queued_message?.trim() ?? "");
      if (queued) setText((cur) => (cur.trim() ? `${queued}\n\n${cur}` : queued));
      attach.restore(files);
      ref.current?.focus();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const canStartEmpty = task.kind === "task" && !task.session_id && !task.running;
  return (
    <div className="shrink-0 px-5 pb-4 narrow:px-2 narrow:pb-2">
      <div className="mx-auto w-full max-w-3xl">
        <RewindNote task={task} />
        {(err || modeControl.err) && <div className="mb-2 text-xs text-red-400">{err || modeControl.err}</div>}
        {unsaved && (
          <div className="mb-2 text-xs text-amber-400">
            This browser couldn't save the draft (its storage may be full), so it's only kept until the page is closed or reloaded.
          </div>
        )}
        <div
          {...attach.dropProps}
          // Keeps the side panel open on a click outside it (see TaskPanel).
          data-draft={text.trim() !== "" || attach.items.length > 0 || undefined}
          className={clsx("rounded-2xl border border-line-strong bg-panel-2 focus-within:border-accent/50", attach.dragging && "border-accent! bg-accent/5")}
        >
          {task.steering?.map((s) => (
            <div key={s.id} className="flex items-start gap-2 border-b border-line py-2 pr-2 pl-4">
              <Loader2 size={12} className="mt-1 shrink-0 animate-spin text-faint" />
              <div className="min-w-0 flex-1">
                <QueuedMessage text={s.text} hostId={task.host_id} />
                <div className="mt-0.5 text-[11px] text-faint">
                  {s.from_agent ? "From another agent: " : "Sent: "}the agent reads it once it finishes its current step
                </div>
              </div>
            </div>
          ))}
          {task.queued_message && (
            <div className="flex items-start gap-2 border-b border-line py-2 pr-2 pl-4">
              <Clock size={12} className="mt-1 shrink-0 text-faint" />
              <div className="min-w-0 flex-1">
                <QueuedMessage text={task.queued_message} hostId={task.host_id} />
                <div className="mt-0.5 text-[11px] text-faint">
                  {task.running
                    ? "Queued: sends when the agent finishes, or press Stop to send it now"
                    : dependencyQueued(task)
                      ? "Queued: sends when the agent starts, once the tasks it depends on are merged"
                      : limitQueued(task)
                        ? "Queued: sends when the agent carries on, once its usage limit resets"
                      : "Queued: sends with the next message"}
                </div>
              </div>
              <button
                onClick={unqueue}
                title="Unqueue and edit"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-white/5 hover:text-fg"
              >
                <X size={13} />
              </button>
            </div>
          )}
          {comments.length > 0 && <ComposerComments task={task} comments={comments} />}
          <SkillMenu menu={skills} />
          {skills.hint && <SkillHint item={skills.hint} />}
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={attach.onPaste}
            onKeyDown={(e) => {
              if (skills.onKeyDown(e)) return;
              // Shift+Tab cycles the permission mode; after Escape it moves focus out of the field, as it does elsewhere.
              const leaving = tabLeaves.current;
              tabLeaves.current = e.key === "Escape" || (leaving && e.key === "Shift");
              if (e.key === "Tab" && e.shiftKey && !leaving) {
                e.preventDefault();
                modeControl.cycle();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (!touch || e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={
              comments.length && !blocked
                ? `Add a message to the comment${comments.length === 1 ? "" : "s"}, or press Enter to send ${comments.length === 1 ? "it" : "them"}…`
                : task.running
                ? canQueue
                  ? task.queued_message
                    ? "Add to the queued message…"
                    : canSteer
                      ? "Message the agent: it reads it after its current step…"
                      : "Queue a message for when the agent finishes…"
                  : "Agent is working…"
                : dependencyQueued(task) || limitQueued(task)
                  ? "Queue a message for when its agent starts…"
                  : (placeholder ?? (canStartEmpty ? "Add extra instructions, or press Enter to start" : "Reply to the agent…"))
            }
            className="block max-h-[260px] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[13.5px] text-fg placeholder:text-faint outline-none"
          />
          <DraftAttachments draft={attach} hostId={task.host_id} className="px-4 pt-1 pb-2" />
          <div className="flex items-center gap-2 px-3 pb-2">
            <ModeSelect control={modeControl} running={task.running} />
            <span className="text-[11px] text-faint narrow:min-w-0 narrow:truncate">
              {task.session_id ? `session ${task.session_id.slice(0, 8)}` : "new session"}
              {task.model ? ` · ${task.model}` : ""}
              {task.effort ? ` · ${task.effort} effort` : ""}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <AttachButton draft={attach} />
              {task.running && canQueue && (text.trim() || attach.items.length > 0 || comments.length > 0) && (
                <button
                  onClick={send}
                  disabled={busy || attach.uploading}
                  title={(canSteer && !task.queued_message ? "Send to the agent now" : "Queue") + enter}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-strong text-white hover:bg-accent disabled:bg-white/10 disabled:text-faint narrow:h-9 narrow:w-9"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
                </button>
              )}
              {task.running ? (
                <button
                  onClick={() => {
                    setErr(null);
                    api.stop(task.host_id, task.id).catch((e) => setErr(`Couldn't stop the agent: ${(e as Error).message}`));
                  }}
                  title={stopTitle(task, canSteer)}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-fg hover:bg-white/15 narrow:h-9 narrow:w-9"
                >
                  <Square size={11} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={busy || attach.uploading || (!text.trim() && !attach.items.length && !comments.length && !canStartEmpty)}
                  title={`Send${enter}`}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-strong text-white hover:bg-accent disabled:bg-white/10 disabled:text-faint narrow:h-9 narrow:w-9"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
