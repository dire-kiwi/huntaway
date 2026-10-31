import clsx from "clsx";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleSlash, Loader2, MessageSquareText, ScanSearch } from "lucide-react";
import { lazy, Suspense, useMemo, useState, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, type Review, type ReviewerRun, type ReviewState, type Task, type Turn, type TurnDiff } from "../api";
import { openTask } from "../router";
import { useProject, useStore } from "../store";
import { turnStat, useTurns } from "../turns";
import { Markdown } from "./Thread";
import { Button, CARD_BADGE, Wide } from "./ui";

const PatchBox = lazy(() => import("./Changes").then((m) => ({ default: m.PatchBox })));

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

const TONE_TEXT = { running: "text-st-review", ok: "text-emerald-400/90", warn: "text-st-attention", muted: "text-faint" };

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

/** What a task's latest review found, as the compare view shows it (HA-51): its verdict, and each reviewer's. */
export function ReviewVerdict({ task }: { task: Task }) {
  const r = task.review;
  const threads = useThreads(r);
  if (!r) return <div className="text-faint">Not reviewed yet</div>;
  const d = describeReview(r, threads);
  const parts = reviewParts(r);
  return (
    <div className="space-y-1.5">
      <button className={clsx("flex items-center gap-1.5 hover:underline", TONE_TEXT[d.tone])} title={`${d.title}\n\nClick to open the review thread.`} onClick={() => openTask(threadToOpen(r))}>
        {r.state === "running" ? <Loader2 size={12} className="animate-spin" /> : <ScanSearch size={12} />}
        {d.headline}
      </button>
      {parts.length > 1 ? (
        parts.map((p, i) => <ReviewerPart key={p.thread_id} part={p} thread={threads[i]} current={false} />)
      ) : (
        <Findings summary={r.summary} issues={r.issues} running={r.state === "running"} />
      )}
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
              d.tone === "ok" && "text-emerald-300",
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
      {err && <div className="rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
      {!threadId && task.kind === "task" && <FixRounds task={task} />}
    </div>
  );
}

/** A round of fixes a review sent back: the turns of the run it started. */
interface Round {
  round: number;
  first: Turn;
  last: Turn;
  turns: number;
}

/** What each round of fixes changed, from the checkpoints taken around it (API 70). */
function FixRounds({ task }: { task: Task }) {
  const { data } = useTurns(task);
  const rounds = useMemo(() => {
    const out: Round[] = [];
    for (const t of data?.turns ?? []) {
      const last = out.at(-1);
      if (t.review_round) out.push({ round: t.review_round, first: t, last: t, turns: 1 });
      else if (last && t.run_id && t.run_id === last.first.run_id) Object.assign(last, { last: t, turns: last.turns + 1 });
    }
    return out.reverse();
  }, [data]);
  if (!rounds.length) return null;
  return (
    <div className="space-y-1.5 border-t border-line pt-3">
      <div className="text-[11.5px] font-medium text-muted">What each round of fixes changed</div>
      {rounds.map((r) => (
        <FixRound key={r.first.n} task={task} r={r} />
      ))}
    </div>
  );
}

function FixRound({ task, r }: { task: Task; r: Round }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<TurnDiff | { error: string } | null>(null);
  const from = r.first.before_n;
  const can = from !== null && r.first.diff && r.last.diff;
  const toggle = () => {
    setOpen(!open);
    if (open || !can || diff) return;
    api
      .turnDiff(task.host_id, task.id, from, r.last.n)
      .then(setDiff)
      .catch((e) => setDiff({ error: (e as Error).message }));
  };
  const stat = diff && "stats" in diff ? turnStat({ ...r.last, stats: diff.stats }) : r.turns === 1 ? turnStat(r.last) : `${r.turns} turns`;
  return (
    <div className="rounded-lg border border-line">
      <button className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-white/[0.03]" onClick={toggle} disabled={!can} title={can ? undefined : "There are no checkpoints from around this round"}>
        {open ? <ChevronDown size={12} className="shrink-0 text-faint" /> : <ChevronRight size={12} className="shrink-0 text-faint" />}
        <span className="font-medium text-fg">Round {r.round}</span>
        <span className="min-w-0 flex-1 truncate text-faint">
          {stat}
          {r.last.stale && " · rewound"}
        </span>
        <span className="shrink-0 text-[11px] text-faint">{new Date(r.last.at).toLocaleString()}</span>
      </button>
      {open && (
        <div className="px-2.5 pb-2.5">
          {!diff ? (
            <Loader2 size={12} className="animate-spin text-faint" />
          ) : "error" in diff ? (
            <div className="text-[11.5px] text-red-300">{diff.error}</div>
          ) : (
            <>
              {diff.excluded.length > 0 && (
                <div className="mb-1.5 text-[11.5px] text-faint" title={diff.excluded.join("\n")}>
                  Left out: {diff.excluded.length} file{diff.excluded.length === 1 ? "" : "s"} git brought in (a merge, pull or rebase).
                </div>
              )}
              {diff.too_large ? (
                <div className="text-[11.5px] text-amber-300">The diff is too big to show here: see the Changes tab's Turns.</div>
              ) : (
                <Suspense fallback={null}>
                  <PatchBox patch={diff.patch} empty="No changes in this round" />
                </Suspense>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
