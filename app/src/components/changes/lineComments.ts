// Comments on a task's diff for its agent (HA-10): lines picked in the Changes tab, each with a note. They wait
// in the task's review, shown beside their lines and in the thread's composer, until a message takes them to the
// agent, all in one. They're kept in this browser, as composer drafts are, so another tab, task or a reload
// doesn't lose them, and so are the comments still being written.
import { useSyncExternalStore } from "react";
import type { FileDiff } from "./changes";

/** Which side of a diff a line number is on: the file before the change (`old`) or after it (`new`). */
export type Side = "old" | "new";

/** Where the lines were picked: the working tree's diffs, a commit's, a stash's or the branch's. */
export interface CommentSource {
  /** What it matches against: `unstaged`, `staged`, `commit:<sha>`, `stash:<sha>` or `branch`. */
  key: string;
  /** What the agent is told: "unstaged changes", "commit 1a2b3c4d", … */
  label: string;
}

/** A line of a diff, by hunk and line in it (as `FileDiff.hunks[hunk].lines[line]`). */
export interface LinePos {
  hunk: number;
  line: number;
}

/** The lines a comment is on, and what it shows of them. */
export interface CommentLines {
  where: string;
  source: string;
  path: string;
  /** Their numbers: in the new version of the file when any of them are in it, else in the old one. */
  side: Side;
  start: number;
  end: number;
  /** The last of them, which the comment is shown under: its side and its number there. */
  at: { side: Side; line: number };
  /** The lines as the diff has them (with their `+`, `-` or space, and `@@` between hunks). */
  lines: string[];
}

export interface LineComment extends CommentLines {
  id: string;
  note: string;
}

/** A comment being written (or, with `of`, one being changed). */
export interface CommentDraft extends CommentLines {
  id: string;
  of?: string;
  note: string;
}

export interface Review {
  comments: LineComment[];
  drafts: CommentDraft[];
}

const EMPTY: Review = { comments: [], drafts: [] };
const reviewKey = (hostId: string, taskId: string) => `ia.review.${hostId}:${taskId}`;

/** The reviews as last read or written on this page (and for when the browser's storage can't take them). */
const page = new Map<string, Review>();
const listeners = new Set<() => void>();

function load(key: string): Review {
  try {
    const r = JSON.parse(localStorage.getItem(key) ?? "null");
    if (r && Array.isArray(r.comments) && Array.isArray(r.drafts)) return { comments: r.comments, drafts: r.drafts };
  } catch {
    // Unreadable: none.
  }
  return EMPTY;
}

export function getReview(hostId: string, taskId: string): Review {
  const key = reviewKey(hostId, taskId);
  let r = page.get(key);
  if (!r) page.set(key, (r = load(key)));
  return r;
}

/** Whether the browser kept it: if not, it's only kept while the page is open. */
function update(hostId: string, taskId: string, f: (r: Review) => Review): boolean {
  const key = reviewKey(hostId, taskId);
  const next = f(getReview(hostId, taskId));
  page.set(key, next);
  let kept = true;
  try {
    if (!next.comments.length && !next.drafts.length) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(next));
  } catch {
    kept = false;
  }
  for (const l of listeners) l();
  return kept;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

// Another tab's changes, read again when next asked for.
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key !== null && !e.key.startsWith("ia.review.")) return;
    if (e.key === null) page.clear();
    else page.delete(e.key);
    for (const l of listeners) l();
  });

export function useReview(hostId: string, taskId: string): Review {
  return useSyncExternalStore(subscribe, () => getReview(hostId, taskId));
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const sameSpot = (a: CommentLines, b: CommentLines) => a.where === b.where && a.path === b.path && a.at.side === b.at.side && a.at.line === b.at.line;

/** Starts a comment on some lines, or gives the one already being written under the same line. Returns its id. */
export function openDraft(hostId: string, taskId: string, lines: CommentLines): string {
  const open = getReview(hostId, taskId).drafts.find((d) => !d.of && sameSpot(d, lines));
  if (open) {
    // The lines picked now, keeping what's been written.
    if (open.lines.join("\n") !== lines.lines.join("\n") || open.start !== lines.start || open.side !== lines.side)
      update(hostId, taskId, (r) => ({ ...r, drafts: r.drafts.map((d) => (d.id === open.id ? { ...d, ...lines } : d)) }));
    return open.id;
  }
  const id = newId();
  update(hostId, taskId, (r) => ({ ...r, drafts: [...r.drafts, { ...lines, id, note: "" }] }));
  return id;
}

/** Changes a comment that's been added: a draft of it, shown in its place. */
export function editComment(hostId: string, taskId: string, commentId: string): string | null {
  const r = getReview(hostId, taskId);
  const open = r.drafts.find((d) => d.of === commentId);
  if (open) return open.id;
  const c = r.comments.find((x) => x.id === commentId);
  if (!c) return null;
  const id = newId();
  update(hostId, taskId, (r) => ({ ...r, drafts: [...r.drafts, { ...c, id, of: c.id }] }));
  return id;
}

export const setDraftNote = (hostId: string, taskId: string, id: string, note: string) =>
  update(hostId, taskId, (r) => ({ ...r, drafts: r.drafts.map((d) => (d.id === id ? { ...d, note } : d)) }));

export const dropDraft = (hostId: string, taskId: string, id: string) => update(hostId, taskId, (r) => ({ ...r, drafts: r.drafts.filter((d) => d.id !== id) }));

/** Adds a draft to the review (or puts the comment it changes back, changed). False if it has no note. */
export function saveDraft(hostId: string, taskId: string, id: string): boolean {
  const d = getReview(hostId, taskId).drafts.find((x) => x.id === id);
  if (!d || !d.note.trim()) return false;
  const { of, ...rest } = d;
  const c: LineComment = { ...rest, id: of ?? d.id, note: d.note.trim() };
  update(hostId, taskId, (r) => ({
    drafts: r.drafts.filter((x) => x.id !== id),
    comments: of && r.comments.some((x) => x.id === of) ? r.comments.map((x) => (x.id === of ? c : x)) : [...r.comments, c],
  }));
  return true;
}

/** Takes comments off the review (sent, or deleted), and any drafts changing them. */
export const removeComments = (hostId: string, taskId: string, ids: string[]) =>
  ids.length > 0 &&
  update(hostId, taskId, (r) => ({ comments: r.comments.filter((c) => !ids.includes(c.id)), drafts: r.drafts.filter((d) => !d.of || !ids.includes(d.of)) }));

/** Throws the whole review away: its comments and drafts. */
export const clearReview = (hostId: string, taskId: string) => update(hostId, taskId, () => EMPTY);

/** The lines picked in a file's diff (in order), as a comment shows them, or null if there are none. */
export function commentLines(file: FileDiff, source: CommentSource, picked: LinePos[]): CommentLines | null {
  const lines: string[] = [];
  const nums: Record<Side, number[]> = { old: [], new: [] };
  let last: { side: Side; line: number } | null = null;
  let hunk = -1;
  for (const p of picked) {
    const h = file.hunks[p.hunk];
    const l = h?.lines[p.line];
    if (!l) continue;
    // Lines from the next hunk on: its header, as the lines in between aren't there.
    if (hunk >= 0 && p.hunk !== hunk) lines.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@${h.heading}`);
    hunk = p.hunk;
    lines.push(l.kind + l.text);
    if (l.noEol) lines.push("\\ No newline at end of file");
    if (l.old !== undefined && l.kind !== "+") nums.old.push(l.old);
    if (l.new !== undefined && l.kind !== "-") nums.new.push(l.new);
    last = l.kind === "-" ? { side: "old", line: l.old! } : { side: "new", line: l.new! };
  }
  if (!last) return null;
  const side: Side = nums.new.length ? "new" : "old";
  return { where: source.key, source: source.label, path: file.path, side, start: Math.min(...nums[side]), end: Math.max(...nums[side]), at: last, lines };
}

/** "line 3", "lines 3–5", or for lines that were removed, "removed lines 3–5" (numbered as they were). */
export function lineRange(c: Pick<CommentLines, "side" | "start" | "end">): string {
  const n = c.start === c.end ? `line ${c.start}` : `lines ${c.start}–${c.end}`;
  return c.side === "old" ? `removed ${n}` : n;
}

/** Whether a comment goes under a line of a diff: the last line it's on. */
export const isUnder = (c: CommentLines, where: string, path: string, line: { kind: string; old?: number; new?: number }) =>
  c.where === where && c.path === path && (c.at.side === "old" ? line.kind === "-" && line.old === c.at.line : line.kind !== "-" && line.new === c.at.line);

/** The comments as one message for the agent: each one's file, lines, the lines as the diff has them, and its note. */
export function reviewMessage(comments: LineComment[]): string {
  if (!comments.length) return "";
  const parts = comments.map((c) => {
    // A fence longer than any run of backticks in the lines.
    const ticks = "`".repeat(Math.max(3, ...c.lines.map((l) => (l.match(/`+/g) ?? []).reduce((a, m) => Math.max(a, m.length + 1), 0))));
    return `**${c.path}**, ${lineRange(c)} (${c.source}):\n${ticks}diff\n${c.lines.join("\n")}\n${ticks}\n${c.note.trim()}`;
  });
  return `${comments.length === 1 ? "A comment" : `${comments.length} comments`} on the diff:\n\n${parts.join("\n\n")}`;
}

/** A message with the comments after what was typed. */
export const withComments = (text: string, comments: LineComment[]) => [text.trim(), reviewMessage(comments)].filter(Boolean).join("\n\n");
