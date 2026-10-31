import clsx from "clsx";
import { AlertTriangle, CheckCircle2, CircleSlash, Loader2, MessageSquareText, ScanSearch } from "lucide-react";
import { useState, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, type Review, type ReviewerRun, type ReviewState, type Task } from "../api";
import { openTask } from "../router";
import { useProject, useStore } from "../store";
import { Markdown } from "./Thread";
import { Button, CARD_BADGE, Wide } from "./ui";

/** Each reviewer's part: a review from before there could be several has just its own. */
export const reviewParts = (r: Review): ReviewerRun[] =>
  r.reviewers?.length ? r.reviewers : [{ thread_id: r.thread_id, label: "", state: r.state, summary: r.summary, issues: r.issues }];

/** The review threads' own state, for prompts they're waiting on. */
const useThreads = (r: Review | null | undefined) =>
  useStore(useShallow((s) => (r ? reviewParts(r).map((p) => s.tasks[p.thread_id]) : [])));

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** How a review reads on a card: what it's doing or what it found. */
type Described = { label: string; headline: string; title: string; tone: "running" | "ok" | "warn" | "muted" };

/** How a review (or one reviewer's part) reads: `label` on a card, `headline` in the task's review tab.
 * `threads` are the running reviewers' threads, `done` how many of `of` reviewers have finished. */
function describe(r: { state: ReviewState; summary: string | null; issues: string[] }, threads: (Task | undefined)[], done = 0, of = 1): Described {
  switch (r.state) {
    case "running": {
      const waiting = threads.find((t) => t?.running && t.attention_reason);
      const progress = of > 1 ? ` ${done}/${of}` : "";
      return waiting
        ? { label: "review waiting", headline: "The reviewer is waiting for you", title: `The reviewer is waiting: ${waiting.attention_reason}`, tone: "warn" }
        : { label: `reviewing${progress}`, headline: `Reviewing…${progress}`, title: of > 1 ? `${of} reviewers are checking this task's changes` : "A reviewer is checking this task's changes", tone: "running" };
    }
    case "passed":
      return { label: "reviewed", headline: "No serious issues", title: r.summary ?? "The review found no serious issues", tone: "ok" };
    case "issues":
      return {
        label: plural(r.issues.length, "issue"),
        headline: `Found ${plural(r.issues.length, "serious issue")}`,
        title: r.summary ?? "The review found serious issues",
        tone: "warn",
      };
    case "failed":
      return { label: "review failed", headline: "Review failed", title: r.summary ?? "The review didn't finish", tone: "muted" };
    case "stopped":
      return { label: "review stopped", headline: "Review stopped", title: r.summary ?? "The review was stopped", tone: "muted" };
  }
}

const describeReview = (r: Review, threads: (Task | undefined)[]) => {
  const parts = reviewParts(r);
  const running = parts.map((p, i) => (p.state === "running" ? threads[i] : undefined));
  return describe(r, running, parts.filter((p) => p.state !== "running").length, parts.length);
};

/** The thread a card's review opens: the first reviewer that found issues, else one still at it. */
const threadToOpen = (r: Review) => {
  const parts = reviewParts(r);
  return (parts.find((p) => p.state === "issues") ?? parts.find((p) => p.state === "running") ?? parts[0]).thread_id;
};

const TONE_TEXT = { running: "text-st-review", ok: "text-success", warn: "text-st-attention", muted: "text-faint" };

/** Whether a card shows its review: always while it runs, and its outcome until the agent works again. */
export const showsReview = (t: Task) => !!t.review && (t.review.state === "running" || (!t.running && t.status !== "done"));

/** A task's review on its card. Opens the review thread. `compact`: the icon and how many issues, and the words once the card has room. */
export function ReviewBadge({ task, compact }: { task: Task; compact?: boolean }) {
  const r = task.review;
  const threads = useThreads(r);
  if (!r || !showsReview(task)) return null;
  const { label, title, tone } = describeReview(r, threads);
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    openTask(threadToOpen(r));
  };
  return (
    <button
      onClick={open}
      title={`${compact ? `Review: ${label}\n` : ""}${title}\n\nClick to open the review thread.`}
      className={clsx(CARD_BADGE, "hover:underline", TONE_TEXT[tone])}
    >
      {tone === "running" ? (
        <span className="inline-block h-1.5 w-1.5 animate-pulse-dot rounded-full bg-st-review" />
      ) : tone === "ok" ? (
        <CheckCircle2 size={11} />
      ) : tone === "warn" ? (
        <AlertTriangle size={11} />
      ) : (
        <CircleSlash size={11} />
      )}
      {!compact ? (
        label
      ) : r.state === "issues" ? (
        <span>
          {r.issues.length}
          <Wide> {r.issues.length === 1 ? "issue" : "issues"}</Wide>
        </span>
      ) : (
        <Wide>{label}</Wide>
      )}
    </button>
  );
}

/** A task's review on its review tab: a dot while it runs or when it found something to look at. */
export function ReviewDot({ task }: { task: Task }) {
  const r = task.review;
  const threads = useThreads(r);
  if (!r || !showsReview(task)) return null;
  const { title, tone } = describeReview(r, threads);
  if (tone !== "running" && tone !== "warn") return null;
  return <span title={title} className={clsx("inline-block h-1.5 w-1.5 rounded-full", tone === "running" ? "animate-pulse-dot bg-st-review" : "bg-st-attention")} />;
}

/** What a review (or a reviewer) reported: its summary and the serious issues it found. */
function Findings({ summary, issues, running }: { summary: string | null; issues: string[]; running: boolean }) {
  return (
    <>
      {summary && !running && (
        <div className="text-muted">
          <Markdown text={summary} />
        </div>
      )}
      {issues.length > 0 && (
        <ol className="list-decimal space-y-1.5 pl-4 text-muted">
          {issues.map((i, n) => (
            <li key={n}>
              <Markdown text={i} />
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/** One reviewer's part of a review with several. */
function ReviewerPart({ part, thread, current }: { part: ReviewerRun; thread: Task | undefined; current: boolean }) {
  const d = describe(part, [thread]);
  return (
    <div className={clsx("space-y-1.5 rounded-lg border p-2.5", current ? "border-st-review/40" : "border-line")}>
      <div className="flex items-center gap-1.5">
        {part.state === "running" ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-st-review" />
        ) : (
          <span className={clsx("shrink-0", TONE_TEXT[d.tone])}>
            {d.tone === "ok" ? <CheckCircle2 size={11} /> : d.tone === "warn" ? <AlertTriangle size={11} /> : <CircleSlash size={11} />}
          </span>
        )}
        <span className="min-w-0 truncate font-medium text-fg" title={part.label}>
          {part.label || "Reviewer"}
        </span>
        <span className={clsx("shrink-0", TONE_TEXT[d.tone])}>{d.label}</span>
        {!current && (
          <button className="ml-auto shrink-0 text-faint hover:text-fg" title="Open this reviewer's thread" onClick={() => openTask(part.thread_id)}>
            <MessageSquareText size={12} />
          </button>
        )}
      </div>
      <Findings summary={part.summary} issues={part.issues} running={part.state === "running"} />
    </div>
  );
}

/** A task's review tab: the latest review and a way to run one. `threadId` is
 * the review thread it's shown beside, if any. */
export function ReviewSummary({ task, threadId }: { task: Task; threadId?: string }) {
  const r = task.review;
  const threads = useThreads(r);
  const rounds = useProject(task.project_id)?.review_rounds;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reviewNow = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.review(task.host_id, task.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const d = r && describeReview(r, threads);
  const parts = r ? reviewParts(r) : [];
  return (
    <div className="space-y-2.5 text-[12.5px]">
      {!r || !d ? (
        <div className="text-muted">Not reviewed yet. The task's changes are reviewed when it moves to In review.</div>
      ) : (
        <>
          <div
            className={clsx(
              "flex items-center gap-1.5",
              d.tone === "running" && "text-st-review",
              d.tone === "ok" && "text-success",
              d.tone === "warn" && "text-st-attention",
              d.tone === "muted" && "text-muted",
            )}
          >
            {r.state === "running" ? <Loader2 size={12} className="animate-spin" /> : <ScanSearch size={12} />}
            <span>{d.headline}</span>
            {r.head && <span className="ml-auto font-mono text-[11px] text-faint">{r.head.slice(0, 7)}</span>}
          </div>
          {parts.length > 1 ? (
            parts.map((p, i) => <ReviewerPart key={p.thread_id} part={p} thread={threads[i]} current={p.thread_id === threadId} />)
          ) : (
            <Findings summary={r.summary} issues={r.issues} running={r.state === "running"} />
          )}
          {r.state === "issues" && r.fixes > 0 && (
            <div className="text-[11.5px] text-faint">
              Sent to the agent to fix (round {r.fixes}
              {rounds !== undefined && ` of ${rounds}`}).
            </div>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {r && !threadId && parts.length === 1 && (
          <Button size="sm" variant="ghost" onClick={() => openTask(r.thread_id)}>
            <MessageSquareText size={12} /> Review thread
          </Button>
        )}
        {r?.state !== "running" && task.kind === "task" && (
          <Button size="sm" disabled={busy || task.running} onClick={reviewNow} title={task.running ? "Wait for the agent to finish" : undefined}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <ScanSearch size={12} />} {r ? "Review again" : "Review now"}
          </Button>
        )}
      </div>
      {err && <div className="rounded bg-danger/10 p-2 text-[11.5px] whitespace-pre-wrap text-danger">{err}</div>}
    </div>
  );
}
