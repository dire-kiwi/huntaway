// A file's diff in the Changes tab (HA-10): its hunks' lines, unified or side by side, highlighted for the file's
// language, with the comments for the agent on them shown under their lines (and the ones being written). Changes.tsx
// gives it the lines picked (a cursor and a range when staging, lines picked by their numbers elsewhere).
import clsx from "clsx";
import { MessageSquare, MessageSquarePlus } from "lucide-react";
import { createContext, Fragment, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import type { DiffLine, FileDiff } from "../changes";
import { runStyle, useHighlight, type Run } from "../highlight";
import { dropDraft, isUnder, lineRange, removeComments, saveDraft, setDraftNote, type CommentDraft, type CommentLines, type CommentSource, type LineComment, type Review } from "../lineComments";
import { Button } from "./ui";

export type Layout = "unified" | "split";

/** A row of a file's diff: one of its hunks' headers (line -1) or lines. */
export interface DiffRow {
  hunk: number;
  line: number;
}
export const diffRows = (f: FileDiff): DiffRow[] => f.hunks.flatMap((h, hunk) => [{ hunk, line: -1 }, ...h.lines.map((_, line) => ({ hunk, line }))]);

/** How a line is picked with the mouse: pressed (shift for a range), or dragged over. */
export type PickHow = "down" | "shift" | "enter";

/** The task's comments, for the diffs to show, and what they do with them. */
export interface CommentsApi {
  hostId: string;
  taskId: string;
  review: Review;
  /** The draft just opened, to be focused. */
  focus: { id: string } | null;
  /** Starts a comment on the lines (or goes to the one being written under the same line). */
  open: (lines: CommentLines | null) => void;
  edit: (commentId: string) => void;
  /** Back to the view's keys, a draft added or put aside. */
  done: () => void;
  /**
   * Lines picked in a patch, for `n` to comment on: whose they are, and what comments on them. The diff that
   * picked them last has them, and the others let theirs go.
   */
  pickOwner: object | null;
  pick: (owner: object, comment: (() => void) | null) => void;
}
export const CommentsContext = createContext<CommentsApi | null>(null);

const LINE_BG = { "+": "bg-emerald-500/[0.09]", "-": "bg-red-500/[0.09]", " ": "" };
const LINE_FG = { "+": "text-emerald-300", "-": "text-red-300", " ": "text-[#b4b4c4]" };
const MARK_FG = { "+": "text-emerald-400", "-": "text-red-400", " ": "text-faint" };

/** A row in the split layout: a hunk's header, or a line on either side (context is on both). */
type SplitRow = { head: number } | { left: number | null; right: number | null };

function splitRows(file: FileDiff, rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: number[] = [];
  let adds: number[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    dels = [];
    adds = [];
  };
  rows.forEach((r, i) => {
    if (r.line < 0) {
      flush();
      return void out.push({ head: i });
    }
    const kind = file.hunks[r.hunk].lines[r.line].kind;
    if (kind === " ") {
      flush();
      out.push({ left: i, right: i });
    } else if (kind === "-") {
      // Removals after additions start the next pair of runs.
      if (adds.length) flush();
      dels.push(i);
    } else adds.push(i);
  });
  flush();
  return out;
}

/** Highlighted only once it's been scrolled near (a commit's diff can have hundreds of files). */
function useSeen(ref: RefObject<HTMLElement | null>) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

export function DiffLines({
  file,
  layout,
  source,
  cursor = -1,
  chosen = null,
  pick = null,
  onLine,
  onComment,
  hunkActions,
  onHunk,
}: {
  file: FileDiff;
  layout: Layout;
  /** Where its lines are from, for comments on them: none without. */
  source?: CommentSource;
  cursor?: number;
  chosen?: ReadonlySet<number> | null;
  /** Which lines the mouse picks: changed ones, pressed anywhere (staging), or any, by its numbers. */
  pick?: "changed" | "numbers" | null;
  onLine?: (i: number, how: PickHow) => void;
  /** The comment button on a row. */
  onComment?: (i: number) => void;
  hunkActions?: ("stage" | "unstage" | "discard")[];
  onHunk?: (hunk: number, what: "stage" | "unstage" | "discard") => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  const runs = useHighlight(file, seen);
  const rows = useMemo(() => diffRows(file), [file]);
  const split = layout === "split";
  // The cursor kept in view.
  useLayoutEffect(() => {
    if (cursor >= 0) ref.current?.querySelector(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, split]);
  const pairs = useMemo(() => (split ? splitRows(file, rows) : null), [split, file, rows]);
  const width = String(Math.max(...file.hunks.map((h) => Math.max(h.oldStart + h.oldCount, h.newStart + h.newCount)))).length;
  // The same handlers every render, so lines that haven't changed don't render again.
  const cb = useRef({ onLine, onComment });
  cb.current = { onLine, onComment };
  const handlers = useMemo<Handlers>(() => ({ line: (i, how) => cb.current.onLine?.(i, how), comment: (i) => cb.current.onComment?.(i) }), []);
  // One comment button, moved to the line under the mouse (rather than one on every line of a big diff).
  const commentable = !!source && !!onComment;
  const button = useRef<HTMLButtonElement>(null);
  const hovered = useRef(-1);
  const onOver = (e: ReactMouseEvent) => {
    const b = button.current;
    if (!b || b.contains(e.target as Node)) return;
    const cell = (e.target as Element).closest<HTMLElement>("[data-line]");
    if (!cell) return void (b.style.display = "none");
    hovered.current = +cell.dataset.i!;
    // Over the +/- column, leaving the line numbers to pick lines by.
    b.style.top = `${cell.offsetTop}px`;
    b.style.left = `calc(${cell.offsetLeft}px + ${cell.dataset.line === "both" ? 2 * width + 3 : width + 1}ch)`;
    b.style.display = "flex";
  };

  // The comments (and drafts) under each row: under its line on their side.
  const api = useContext(CommentsContext);
  const under = useMemo(() => {
    const m = new Map<number, (LineComment | CommentDraft)[]>();
    if (!api || !source) return m;
    const editing = new Set(api.review.drafts.map((d) => d.of));
    const items = [...api.review.comments.filter((c) => !editing.has(c.id)), ...api.review.drafts].filter((c) => c.where === source.key && c.path === file.path);
    for (const c of items) {
      const i = rows.findIndex((r) => r.line >= 0 && isUnder(c, source.key, file.path, file.hunks[r.hunk].lines[r.line]));
      if (i >= 0) m.set(i, [...(m.get(i) ?? []), c]);
    }
    return m;
  }, [api, source, file, rows]);
  const boxes = (i: number | null) => (i !== null && under.get(i)?.map((c) => <CommentBox key={c.id} c={c} wide={!split} />)) || null;

  const line = (i: number): DiffLine | null => (rows[i] && rows[i].line >= 0 ? file.hunks[rows[i].hunk].lines[rows[i].line] : null);
  const cell = (i: number | null, nums: "both" | "old" | "new") => {
    const l = i === null ? null : line(i);
    return (
      <Cell
        key={`${nums}${i}`}
        i={i ?? -1}
        line={l}
        runs={l && i !== null ? runs?.[rows[i].hunk][rows[i].line] : undefined}
        nums={nums}
        width={width}
        on={i !== null && !!chosen?.has(i)}
        cur={i !== null && i === cursor}
        pick={pick}
        split={split}
        h={handlers}
      />
    );
  };
  const head = (i: number) => {
    const h = file.hunks[rows[i].hunk];
    return (
      <div key={`h${i}`} data-i={i} className="group flex items-center gap-2 bg-accent/[0.06] px-1.5 text-accent/90">
        <span className={clsx("whitespace-pre", split && "min-w-0 truncate")}>
          @@ -{h.oldStart},{h.oldCount} +{h.newStart},{h.newCount} @@<span className="text-faint">{h.heading}</span>
        </span>
        {hunkActions && onHunk && (
          <span className="sticky right-1.5 ml-auto flex shrink-0 gap-1 opacity-0 group-hover:opacity-100">
            {hunkActions.map((a) => (
              <button
                key={a}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onHunk(rows[i].hunk, a)}
                className={clsx("rounded border px-1.5 text-[10.5px] leading-4 capitalize", a === "discard" ? "border-red-500/30 text-red-300 hover:bg-red-500/15" : "border-line-strong text-muted hover:bg-white/10 hover:text-fg")}
              >
                {a} hunk
              </button>
            ))}
          </span>
        )}
      </div>
    );
  };

  return (
    <div
      ref={ref}
      data-diff={file.path}
      onMouseOver={commentable ? onOver : undefined}
      onMouseLeave={() => button.current && (button.current.style.display = "none")}
      className={clsx("relative", split ? "w-full" : "w-max min-w-full")}
    >
      {commentable && (
        <button
          ref={button}
          tabIndex={-1}
          title="Comment for the agent (n)"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={() => hovered.current >= 0 && handlers.comment(hovered.current)}
          style={{ display: "none" }}
          className="absolute z-[1] h-[18px] w-4 items-center justify-center rounded bg-accent-strong text-white hover:bg-accent"
        >
          <MessageSquarePlus size={12} />
        </button>
      )}
      {pairs
        ? pairs.map((p) =>
            "head" in p ? (
              head(p.head)
            ) : (
              <Fragment key={`${p.left}:${p.right}`}>
                <div className="flex">
                  {cell(p.left, "old")}
                  {cell(p.right, "new")}
                </div>
                {boxes(p.left)}
                {p.right !== p.left && boxes(p.right)}
              </Fragment>
            ),
          )
        : rows.map((r, i) =>
            r.line < 0 ? (
              head(i)
            ) : (
              <Fragment key={i}>
                {cell(i, "both")}
                {boxes(i)}
              </Fragment>
            ),
          )}
    </div>
  );
}

interface Handlers {
  line: (i: number, how: PickHow) => void;
  comment: (i: number) => void;
}

/** A line of the diff: the whole row (unified), or its side of one (split). */
const Cell = memo(function Cell({
  i,
  line: l,
  runs,
  nums,
  width,
  on,
  cur,
  pick,
  split,
  h,
}: {
  i: number;
  line: DiffLine | null;
  runs?: Run[];
  nums: "both" | "old" | "new";
  width: number;
  on: boolean;
  cur: boolean;
  pick: "changed" | "numbers" | null;
  split: boolean;
  h: Handlers;
}) {
  if (!l) return <div className={clsx("bg-white/[0.015]", split && "w-1/2 border-r border-line/50 last:border-r-0")} />;
  const changed = l.kind !== " ";
  const byLine = pick === "changed" && changed;
  const down = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    h.line(i, e.shiftKey ? "shift" : "down");
  };
  const num = (n: number | undefined, w: number) => (
    <span
      onMouseDown={pick === "numbers" ? down : undefined}
      className={clsx("shrink-0 pr-[1ch] text-right text-faint/70 select-none", pick === "numbers" && "cursor-pointer hover:text-muted")}
      style={{ width: `${w}ch` }}
    >
      {n ?? ""}
    </span>
  );
  return (
    <div
      data-i={i}
      data-line={nums}
      onMouseDown={byLine ? down : undefined}
      onMouseEnter={pick && (pick === "numbers" || changed) ? () => h.line(i, "enter") : undefined}
      className={clsx(
        "flex",
        split ? "w-1/2 min-w-0 border-r border-line/50 last:border-r-0" : "whitespace-pre",
        on ? "bg-accent/30 text-fg" : LINE_BG[l.kind],
        !runs && !on && LINE_FG[l.kind],
        byLine && "cursor-pointer",
        cur && "outline outline-1 -outline-offset-1 outline-accent/70",
      )}
    >
      {nums !== "new" && num(l.kind === "+" ? undefined : l.old, nums === "both" ? width + 2 : width + 1)}
      {nums !== "old" && num(l.kind === "-" ? undefined : l.new, width + 1)}
      <span className={clsx("w-[2ch] shrink-0 text-center select-none", MARK_FG[l.kind])}>{l.kind}</span>
      <span className={clsx("pr-3 [tab-size:4]", split && "min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere")} style={runs && !on ? runStyle(0) : undefined}>
        <Code text={l.text} runs={runs} />
        {l.noEol && <span className="ml-2 text-faint select-none">⏎̸ no newline at end</span>}
      </span>
    </div>
  );
});

/** A line's text, in its highlighted runs once they've come (those in the default style as plain text). */
const Code = memo(function Code({ text, runs }: { text: string; runs?: Run[] }) {
  if (!text) return <>{" "}</>;
  if (!runs) return <>{text}</>;
  let at = 0;
  const out: ReactNode[] = runs.map(([n, s], k) => {
    const t = text.slice(at, (at += n));
    return s === 0 ? (
      t
    ) : (
      <span key={k} style={runStyle(s)}>
        {t}
      </span>
    );
  });
  if (at < text.length) out.push(<span key="rest">{text.slice(at)}</span>);
  return <>{out}</>;
});

/** A comment under its lines (or a draft of one, being written), kept in view as the diff scrolls sideways. */
function CommentBox({ c, wide }: { c: LineComment | CommentDraft; wide: boolean }) {
  const api = useContext(CommentsContext)!;
  const draft = api.review.drafts.find((d) => d.id === c.id);
  return (
    <div data-comment={draft?.of ?? c.id} className={clsx("px-2 py-1 font-sans", wide && "sticky left-0 w-[100cqw]")}>
      {draft ? <Draft d={draft} api={api} /> : <Added c={c} api={api} />}
    </div>
  );
}

function Added({ c, api }: { c: LineComment; api: CommentsApi }) {
  return (
    <div className="max-w-2xl rounded-md border border-line-strong bg-panel-2 px-2.5 py-1.5">
      <div className="flex items-center gap-1.5 text-[11px] text-faint">
        <MessageSquare size={11} className="text-accent" />
        <span>Comment for the agent on {lineRange(c)}, not sent yet</span>
        <span className="ml-auto flex gap-2">
          <button tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => api.edit(c.id)} className="hover:text-fg">
            Edit
          </button>
          <button tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => removeComments(api.hostId, api.taskId, [c.id])} className="hover:text-red-300">
            Delete
          </button>
        </span>
      </div>
      <div className="mt-0.5 text-[12.5px] break-words whitespace-pre-wrap text-fg">{c.note}</div>
    </div>
  );
}

function Draft({ d, api }: { d: CommentDraft; api: CommentsApi }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { hostId: h, taskId: t } = api;
  // Before the next key comes in, rather than once painted.
  useLayoutEffect(() => {
    if (api.focus?.id === d.id) ref.current?.focus();
  }, [api.focus, d.id]);
  const save = () => saveDraft(h, t, d.id) && api.done();
  const cancel = () => {
    dropDraft(h, t, d.id);
    api.done();
  };
  return (
    <div className="max-w-2xl rounded-md border border-accent/45 bg-panel-2 p-2" data-draft={d.note.trim() ? "" : undefined}>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-faint">
        <MessageSquarePlus size={11} className="text-accent" />
        {d.of ? "Change the comment on" : "Comment for the agent on"} {lineRange(d)}
      </div>
      <textarea
        ref={ref}
        value={d.note}
        rows={3}
        placeholder="What should the agent know or change here?"
        onChange={(e) => setDraftNote(h, t, d.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            // An empty one goes; one with a note stays, for later.
            if (!d.note.trim() && !d.of) cancel();
            else api.done();
          }
        }}
        className="block w-full resize-y rounded border border-line-strong bg-bg px-2 py-1.5 text-[12.5px] leading-[18px] text-fg outline-none placeholder:text-faint focus:border-accent/60"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <span className="mr-auto text-[11px] text-faint">Enter to {d.of ? "save" : "add"} · Shift+Enter for a new line · Esc to leave it</span>
        <Button size="sm" onMouseDown={(e) => e.preventDefault()} onClick={cancel}>
          {d.of ? "Cancel" : "Discard"}
        </Button>
        <Button size="sm" variant="primary" disabled={!d.note.trim()} onMouseDown={(e) => e.preventDefault()} onClick={save}>
          {d.of ? "Save" : "Add comment"}
        </Button>
      </div>
    </div>
  );
}
