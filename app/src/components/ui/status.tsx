import clsx from "clsx";
import { Ban, CheckCircle2, CircleAlert, CircleSlash, GitPullRequest, Hourglass } from "lucide-react";
import type { ReactNode } from "react";
import { agentWaiting, mergeAwaitsApproval, type AgentWait, type PrWaitEvent, type Resolution, type Status, type Task } from "../../api";
import { ActivityTime } from "./time";

export const STATUS_COLOR: Record<Status, string> = {
  todo: "var(--color-st-todo)",
  in_progress: "var(--color-st-progress)",
  needs_attention: "var(--color-st-attention)",
  in_review: "var(--color-st-review)",
  ready_for_merge: "var(--color-st-merge)",
  done: "var(--color-st-done)",
  backlog: "var(--color-st-backlog)",
};

/** The columns a profile's status bar counts, in its order: what's being worked on or waits for the user. */
const BAR_STATUSES: { id: Status; label: string }[] = [
  { id: "in_progress", label: "in progress" },
  { id: "needs_attention", label: "need attention" },
  { id: "in_review", label: "in review" },
  { id: "ready_for_merge", label: "merging or waiting to merge" },
];

/**
 * How many tasks are in each of BAR_STATUSES, as a rounded bar of coloured segments with the
 * counts in them. A column with none has no segment, and with none at all there's no bar.
 */
export function StatusBar({ counts, className }: { counts: Partial<Record<Status, number>>; className?: string }) {
  const shown = BAR_STATUSES.filter((s) => (counts[s.id] ?? 0) > 0);
  if (!shown.length) return null;
  const summary = shown.map((s) => `${counts[s.id]} ${s.label}`).join(", ");
  return (
    <span role="img" aria-label={summary} title={summary} className={clsx("flex h-[18px] shrink-0 overflow-hidden rounded-md", className)}>
      {shown.map((s) => (
        <span
          key={s.id}
          data-status={s.id}
          className="flex min-w-[18px] items-center justify-center px-1.5 text-[10.5px] leading-none font-semibold text-black/80 tabular-nums"
          style={{ background: STATUS_COLOR[s.id] }}
        >
          {counts[s.id]}
        </span>
      ))}
    </span>
  );
}

export function StatusIcon({ status, size = 14 }: { status: Status; size?: number }) {
  const c = STATUS_COLOR[status];
  const r = size / 2 - 1.25;
  const cx = size / 2;
  const circ = 2 * Math.PI * (r - 2);
  const frac = { todo: 0, in_progress: 0.5, needs_attention: 0.5, in_review: 0.75, ready_for_merge: 1, done: 1, backlog: 0 }[status] ?? 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={cx} cy={cx} r={r} fill="none" stroke={c} strokeWidth={1.5} strokeDasharray={status === "todo" ? "2 2" : status === "backlog" ? "1 2.5" : undefined} />
      {status === "needs_attention" ? (
        <text x={cx} y={cx + 3} textAnchor="middle" fontSize={size * 0.62} fontWeight={700} fill={c}>
          !
        </text>
      ) : status === "done" ? (
        <path d={`M${size * 0.3} ${cx} l${size * 0.14} ${size * 0.14} l${size * 0.26} -${size * 0.28}`} fill="none" stroke={c} strokeWidth={1.6} strokeLinecap="round" />
      ) : (
        frac > 0 && (
          <circle
            cx={cx}
            cy={cx}
            r={(r - 2) / 2}
            fill="none"
            stroke={c}
            strokeWidth={r - 2}
            strokeDasharray={`${(circ / 2) * frac} ${circ}`}
            transform={`rotate(-90 ${cx} ${cx})`}
          />
        )
      )}
    </svg>
  );
}

export const RESOLUTION_LABELS: Record<Resolution, string> = { done: "Done", not_done: "Not done", wont_fix: "Won't fix" };

const RESOLUTION_STYLE: Record<Resolution, { icon: ReactNode; className: string }> = {
  done: { icon: <CheckCircle2 size={11} />, className: "text-st-done" },
  not_done: { icon: <CircleSlash size={11} />, className: "text-amber-300/80" },
  wont_fix: { icon: <Ban size={11} />, className: "text-faint" },
};

/** How a done task ended. Nothing for tasks that aren't done (or hosts before API 19). */
export function ResolutionBadge({ task }: { task: Task }) {
  if (task.status !== "done" || !task.resolution) return null;
  const { icon, className } = RESOLUTION_STYLE[task.resolution];
  return (
    <span className={clsx("flex shrink-0 items-center gap-1", className)} title={`Resolution: ${RESOLUTION_LABELS[task.resolution]}`}>
      {icon} {RESOLUTION_LABELS[task.resolution]}
    </span>
  );
}

/** A badge in a card's status bar: an icon and a short value on one line. */
export const CARD_BADGE = "flex shrink-0 items-center gap-1 whitespace-nowrap";

/**
 * Words in a card's status bar that only show once the card has room: the card is a `@container`, and
 * 254px is its content box when the card is 280px wide (12px padding and a 1px border each side).
 */
export function Wide({ children }: { children: ReactNode }) {
  return <span className="hidden @min-[254px]:inline">{children}</span>;
}

/** "2/8", and on a card with room "2/8 done" (`word`). */
export function ProgressCount({ progress, word = "done" }: { progress: { done: number; total: number }; word?: string }) {
  return (
    <span>
      {progress.done}/{progress.total}
      <Wide> {word}</Wide>
    </span>
  );
}

/**
 * The one state at the right of a card's status bar, with the time: the task needing you, its agent working
 * (or merging) or waiting, or how a done task ended. Otherwise just the time.
 */
export function CardState({ task }: { task: Task }) {
  const wait = agentWaiting(task);
  const at = (iso: string) => new Date(iso).toLocaleString();
  const working = `${mergeAwaitsApproval(task) ? "Summarizing the merge" : task.merging ? "Merging" : "Working"}${task.run_started_at ? ` since ${at(task.run_started_at)}` : ""}`;
  // Needing you comes first: an agent stopped on a permission prompt is still running.
  const [icon, className, title]: [ReactNode, string, string | undefined] =
    task.status === "needs_attention"
      ? [<CircleAlert size={11} />, "text-st-attention", `Needs your input · ${task.running ? working.toLowerCase() : at(task.last_activity_at)}`]
      : task.running
        ? wait
          ? [<Hourglass size={11} />, "text-muted", waitTitle(wait)]
          : [<RunningDot />, "text-st-progress", working]
        : task.status === "done" && task.resolution
        ? [RESOLUTION_STYLE[task.resolution].icon, RESOLUTION_STYLE[task.resolution].className, `Resolution: ${RESOLUTION_LABELS[task.resolution]} · ${at(task.last_activity_at)}`]
        : [null, "", undefined];
  const ended = !task.running && task.status === "done" && task.resolution;
  return (
    <span className={clsx("ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums", className)} title={title}>
      {icon}
      <span>
        {ended && <Wide>{RESOLUTION_LABELS[task.resolution!]} · </Wide>}
        <ActivityTime task={task} title={title} />
      </span>
    </span>
  );
}

export function RunningDot({ className }: { className?: string }) {
  return <span className={clsx("inline-block h-1.5 w-1.5 rounded-full bg-st-progress animate-pulse-dot", className)} />;
}

/** What a running task's agent is doing: working (or merging), or waiting (the `wait` tool). */
export function RunState({ task }: { task: Task }) {
  const wait = agentWaiting(task);
  if (wait) {
    return (
      <span className="flex items-center gap-1 whitespace-nowrap text-muted" title={waitTitle(wait)}>
        <Hourglass size={11} /> waiting
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-st-progress">
      <RunningDot /> {mergeAwaitsApproval(task) ? "summarizing" : task.merging ? "merging" : "working"}
    </span>
  );
}

/** "Waiting for CI · until 3:40 pm · or until `./deploy-done` exits · or until o/r#12 has failed checks, … or is merged or closed" */
export function waitTitle(w: AgentWait) {
  return [
    w.reason || "Waiting",
    `until ${new Date(w.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
    w.tasks?.length ? `or until ${w.tasks.map((t) => t.key).join(", ")} ${w.tasks.length === 1 ? "moves" : "move"} on` : null,
    w.command ? `or until \`${w.command}\` exits` : null,
    w.pull_request ? `or until ${w.pull_request.repo}#${w.pull_request.number} ${prWaitNews(w.pull_request.events)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const PR_WAIT_NEWS: Record<PrWaitEvent, string> = {
  checks_failed: "failed checks",
  checks_passed: "passing checks",
  comments: "new comments or reviews",
  conflicts: "a conflict",
};

/** "has failed checks, new comments or reviews, or is merged or closed" */
function prWaitNews(events: PrWaitEvent[]) {
  const news = events.map((e) => PR_WAIT_NEWS[e]).filter(Boolean);
  return news.length ? `has ${news.join(", ")}, or is merged or closed` : "is merged or closed";
}

/** What a waiting agent said it's waiting for, with the pull request it watches (linked), as a card or list row shows it. */
export function WaitReason({ wait, className }: { wait: AgentWait; className?: string }) {
  const pr = wait.pull_request;
  if (!wait.reason && !pr) return null;
  return (
    <div className={className} title={waitTitle(wait)}>
      {wait.reason}
      {pr && (
        <>
          {wait.reason && " · "}
          <a href={pr.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="whitespace-nowrap hover:text-fg">
            <GitPullRequest size={11} className="inline align-[-1px]" /> watching #{pr.number}
          </a>
        </>
      )}
    </div>
  );
}
