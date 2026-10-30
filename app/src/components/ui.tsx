import clsx from "clsx";
import { Ban, Check, CheckCircle2, CircleAlert, CircleSlash, GitBranch, GitPullRequest, Hourglass, Menu, X } from "lucide-react";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ComponentProps, type InputHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { agentWaiting, type AgentWait, type PrWaitEvent, type Resolution, type Status, type Task } from "../api";
import { useDrawer, useNarrow } from "../narrow";
import { usePreviewUp } from "../preview";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" }) {
  return (
    <button
      {...props}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap",
        // Taller in the narrow layout, to tap.
        size === "sm" ? "h-7 px-2.5 text-xs narrow:h-9" : "h-8 px-3 text-[13px] narrow:h-10",
        variant === "primary" && "bg-accent-strong text-white hover:bg-accent",
        variant === "secondary" && "bg-raised text-fg border border-line hover:border-line-strong hover:bg-[#22222c]",
        variant === "ghost" && "text-muted hover:text-fg hover:bg-white/5",
        variant === "danger" && "bg-red-500/10 text-red-300 border border-red-500/25 hover:bg-red-500/20",
        className,
      )}
    />
  );
}

export function IconButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={clsx(
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:text-fg hover:bg-white/5 transition-colors disabled:opacity-40 narrow:h-9 narrow:w-9",
        className,
      )}
    />
  );
}

/** Opens the sidebar's drawer, at the start of a page's header in the narrow layout (nothing otherwise). */
export function MenuButton() {
  const narrow = useNarrow();
  if (!narrow) return null;
  return (
    <IconButton className="no-drag -ml-1.5 shrink-0" title="Menu" aria-label="Menu" onClick={() => useDrawer.getState().setOpen(true)}>
      <Menu size={18} />
    </IconButton>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        "h-8 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] text-fg placeholder:text-faint outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/15",
        className,
      )}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      {...props}
      className={clsx(
        "w-full rounded-md border border-line bg-panel px-2.5 py-2 text-[13px] text-fg placeholder:text-faint outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/15",
        className,
      )}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-faint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-center gap-2.5 text-[13px] text-fg">
      <span
        className={clsx(
          "relative h-4.5 w-8 rounded-full transition-colors",
          checked ? "bg-accent-strong" : "bg-line-strong",
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all",
            checked ? "left-4" : "left-0.5",
          )}
        />
      </span>
      {label}
    </button>
  );
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
/** How the submit shortcut is written on this platform. */
export const SUBMIT_KEYS = IS_MAC ? "⌘↵" : "Ctrl+Enter";

/** Ctrl+Enter, or Cmd+Enter on a Mac: submits a dialog or editor. */
export function isSubmitShortcut(e: KeyboardEvent | ReactKeyboardEvent) {
  const composing = "nativeEvent" in e ? e.nativeEvent.isComposing : e.isComposing;
  return e.key === "Enter" && (e.ctrlKey || e.metaKey) && !composing;
}

/** The fields, buttons and links in `el` that Tab stops at, in order. */
function focusables(el: HTMLElement): HTMLElement[] {
  const sel = "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
  return [...el.querySelectorAll<HTMLElement>(sel)].filter((f) => !f.hidden && f.getClientRects().length > 0);
}

/** Whether this dialog is the one on top (a dialog can open another). */
const topModal = (el: HTMLElement) => [...document.querySelectorAll("[data-modal]")].at(-1) === el.parentElement;

export function Modal({
  title,
  onClose,
  onSubmit,
  children,
  width = "max-w-lg",
}: {
  title: ReactNode;
  onClose: () => void;
  /** Runs on Ctrl/Cmd+Enter anywhere while the dialog is open, not just inside its form. */
  onSubmit?: () => void;
  children: ReactNode;
  width?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (onSubmit && isSubmitShortcut(e)) {
        // Stops the textarea newline, or a click on a focused button.
        e.preventDefault();
        onSubmit();
      } else if (e.key === "Tab" && box.current && topModal(box.current)) {
        // Tab goes round the dialog's fields and buttons, not the page behind it.
        const all = focusables(box.current);
        const at = document.activeElement;
        if (!all.length) return;
        const wraps = !box.current.contains(at) || (e.shiftKey ? at === all[0] || at === box.current : at === all[all.length - 1]);
        if (!wraps) return;
        e.preventDefault();
        (e.shiftKey ? all[all.length - 1] : all[0]).focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onSubmit]);
  // Focus goes into the dialog (unless a field in it took it), and back to where it was when it closes: what had it
  // before the dialog's fields were there to take it.
  const [before] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    const el = box.current;
    if (el && !el.contains(document.activeElement)) el.focus();
    return () => {
      if (before?.isConnected && (!document.activeElement || document.activeElement === document.body || el?.contains(document.activeElement))) before.focus();
    };
  }, [before]);
  return (
    <div
      data-modal
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[10vh] backdrop-blur-[2px] narrow:overflow-y-auto narrow:p-2 narrow:pt-[max(0.5rem,env(safe-area-inset-top))]"
      onMouseDown={onClose}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={clsx("w-full rounded-xl border border-line bg-panel shadow-2xl shadow-black/50 outline-none", width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div id={titleId} className="text-[14px] font-semibold">
            {title}
          </div>
          <IconButton onClick={onClose} title="Close" aria-label="Close" className="narrow:-mr-1">
            <X size={15} />
          </IconButton>
        </div>
        <div className="p-4 narrow:p-3">{children}</div>
      </div>
    </div>
  );
}

/** `divider` puts a line above the item, to set it apart from the ones before. */
export type MenuItem = { label: ReactNode; checked?: boolean; divider?: boolean; onSelect: () => void };

/**
 * A menu at the cursor (for a right-click), kept on screen. Pressing outside it, Escape, scrolling,
 * resizing or leaving the window closes it; the arrow keys move between its items.
 */
export function ContextMenu({ x, y, title, items, onClose }: { x: number; y: number; title?: ReactNode; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
    (el.querySelector<HTMLElement>("[aria-checked=true]") ?? el.querySelector<HTMLElement>("[role^=menuitem]"))?.focus();
  }, [x, y]);
  useEffect(() => {
    // Closed after the event, so whatever else handles it (the side panel closing on a click
    // outside it) still sees the menu, marked data-modal, and leaves it alone.
    const close = () => setTimeout(onClose);
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    // Not its own scrolling: a long menu scrolls on a short screen.
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        close();
        return;
      }
      const all = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? []);
      const i = all.indexOf(document.activeElement as HTMLElement);
      const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: all.length - 1 }[e.key];
      if (next === undefined || !all.length) return;
      e.preventDefault();
      all[(next + all.length) % all.length].focus();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      data-modal
      role="menu"
      style={pos}
      className="fixed z-50 min-w-44 rounded-lg border border-line bg-panel p-1 shadow-2xl shadow-black/50 narrow:max-h-[calc(100%-8px)] narrow:overflow-y-auto"
      onContextMenu={(e) => e.preventDefault()}
    >
      {title && <div className="px-2 pt-1 pb-1.5 text-[11.5px] text-faint">{title}</div>}
      {items.map((item, i) => (
        <Fragment key={i}>
          {item.divider && i > 0 && <div role="separator" className="mx-1 my-1 h-px bg-line" />}
          <button
            role="menuitemradio"
            aria-checked={!!item.checked}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-fg outline-none hover:bg-white/5 focus:bg-white/5 narrow:py-2.5"
          >
            <span className="w-3.5 shrink-0 text-accent">{item.checked && <Check size={14} />}</span>
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

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
  const working = `${task.merging ? "Merging" : "Working"}${task.run_started_at ? ` since ${at(task.run_started_at)}` : ""}`;
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
      <RunningDot /> {task.merging ? "merging" : "working"}
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

/** A task in review with a preview URL: polled while shown, the dot is green once it answers 200. */
export const showsPreview = (t: Task) => t.status === "in_review" && !!t.preview_url;

/** Green when the preview answers 200, yellow until then. Links to it. */
export function PreviewDot({ url, label, className }: { url: string; label?: boolean; className?: string }) {
  const up = usePreviewUp(url);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={up ? `Preview is up: ${url}` : `Preview isn't running yet: ${url}`}
      className={clsx("inline-flex shrink-0 items-center gap-1 hover:text-fg", className)}
    >
      <span className={clsx("inline-block h-2 w-2 rounded-full", up ? "bg-emerald-400" : "bg-amber-400")} />
      {label && <span>preview</span>}
    </a>
  );
}

/** Copy text, also where the async clipboard API is missing (plain HTTP on the LAN). */
export function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => {});
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  const focused = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* ignore */
  }
  ta.remove();
  focused?.focus();
}

/** A task's branch as just an icon: hover shows it, a click copies it. */
export function BranchIcon({ branch, className }: { branch: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        copyText(branch);
        setCopied(true);
      }}
      title={copied ? `Copied ${branch}` : `${branch} (click to copy)`}
      className={clsx("inline-flex shrink-0 items-center hover:text-fg", copied ? "text-st-done" : className)}
    >
      {copied ? <Check size={11} /> : <GitBranch size={11} />}
    </button>
  );
}

/** "#12" for a GitHub-style pull request URL, else the URL. */
export const prLabel = (url: string) => {
  const n = url.match(/\/pull\/(\d+)/)?.[1];
  return n ? `#${n}` : url;
};

/** A task's pull request as an icon (with `label`, also its number) that links to it. */
export function PrIcon({ url, label, className }: { url: string; label?: boolean; className?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`Pull request ${prLabel(url)}: ${url}`}
      className={clsx("inline-flex shrink-0 items-center gap-1 hover:text-fg", className)}
    >
      <GitPullRequest size={11} />
      {label && <span>{prLabel(url)}</span>}
    </a>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-raised px-1 font-mono text-[10px] text-muted">{children}</kbd>;
}

export function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** How long, e.g. "45s", "3m 12s", "1h 04m". */
export function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor(s / 3600) % 24}h`;
}

// One clock for every running timer on screen, ticking only while something shows one.
const clockSubs = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;
function subscribeClock(cb: () => void) {
  clockSubs.add(cb);
  clockTimer ??= setInterval(() => clockSubs.forEach((f) => f()), 1000);
  return () => {
    clockSubs.delete(cb);
    if (!clockSubs.size) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}
const nowSecond = () => Math.floor(Date.now() / 1000) * 1000;

/** The time now, to the `step` (in ms): re-renders once it's moved on a step. */
export function useClock(step: number) {
  return useSyncExternalStore(subscribeClock, () => Math.floor(Date.now() / step) * step);
}

function Elapsed({ since, title }: { since: string; title?: string }) {
  const now = useSyncExternalStore(subscribeClock, nowSecond);
  return (
    <span className="tabular-nums" title={title ?? `Working since ${new Date(since).toLocaleString()}`}>
      {duration(now - new Date(since).getTime())}
    </span>
  );
}

/** How long the agent has been working while it runs, otherwise when the task last saw activity. `title` replaces its tooltip. */
export function ActivityTime({ task, title }: { task: Task; title?: string }) {
  if (task.running && task.run_started_at) return <Elapsed since={task.run_started_at} title={title} />;
  return <Ago at={task.last_activity_at} title={title} />;
}

/** "5m ago", kept up to date (memoized cards don't redraw as the minutes pass). */
function Ago({ at, title }: { at: string; title?: string }) {
  useClock(60_000);
  return <span title={title ?? new Date(at).toLocaleString()}>{timeAgo(at)}</span>;
}

export function cost(usd: number) {
  if (!usd) return null;
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}
