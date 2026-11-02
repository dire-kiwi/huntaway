// What the Changes tab's parts share: its panels, options and dialogs, a file's diffs as fetched, and helpers.
import type { ReactNode } from "react";
import { api, type GitCommit, type GitFile, type GitStash, type GitStatus, type Turn } from "../../../api";
import { hasStaged, hasUnstaged, linesStageable, untracked, type FileDiff, type FileRow } from "../changes";
import type { CommentSource } from "../lineComments";
import { diffRows, type DiffRow } from "../DiffLines";
import { turnStat } from "../../task/turns";

export type Side = "status" | "files" | "commits" | "stash" | "turns";
export const SIDES: Side[] = ["status", "files", "commits", "stash"];
export const SIDE_TITLES: Record<Side, string> = { status: "Status", files: "Files", commits: "Commits", stash: "Stash", turns: "Turns" };
export type Pane = "unstaged" | "staged";
/** An option that's just shown (keys that move around), not done from the bar. */
export const noop = () => {};

/** One of the view's options: a key and what it does, for the bar at the bottom and the help. */
export interface Option {
  key: string;
  label: string;
  run: () => void;
}

export interface MenuEntry {
  key: string;
  label: string;
  hint?: string;
  danger?: boolean;
  run: () => void;
}

export type Dialog =
  | { kind: "help" }
  | { kind: "confirm"; title: string; body: ReactNode; yes: string; danger?: boolean; onYes: () => void }
  | { kind: "menu"; title: string; items: MenuEntry[] }
  | { kind: "message"; title: string; summary: string; body: string; yes: string; submit: (message: string) => Promise<unknown>; onDraft?: (message: string) => void }
  | { kind: "input"; title: string; placeholder: string; yes: string; submit: (text: string) => void };

/** A file's (or folder's) diffs, as fetched: unstaged and staged. */
export interface FileDiffs {
  key: string;
  unstaged: string;
  staged: string;
  tooLarge: boolean;
  /** Diffs that aren't UTF-8 (files in other encodings): shown, but never patched by line (see git_view::diff). */
  unstagedPreview: string;
  stagedPreview: string;
  notUtf8: boolean;
  error?: string;
}

/** The rows of a file's diff to stage lines from (none for one that can't be). */
export const stageRows = (f: FileDiff | null): DiffRow[] => (f && linesStageable(f) ? diffRows(f) : []);
export const isChange = (f: FileDiff, r: DiffRow | undefined) => !!r && r.line >= 0 && f.hunks[r.hunk].lines[r.line].kind !== " ";

/** The changed line nearest `i` (looking in direction `dir` first), or -1. */
export function nearestChange(f: FileDiff, rows: DiffRow[], i: number, dir: 1 | -1 = 1): number {
  for (const d of [dir, -dir]) for (let j = Math.max(0, Math.min(i, rows.length - 1)); j >= 0 && j < rows.length; j += d) if (isChange(f, rows[j])) return j;
  return -1;
}

export const short = (sha: string) => sha.slice(0, 8);
export const ago = (secs: number) => {
  const s = Math.max(0, Date.now() / 1000 - secs);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : s < 86400 * 365 ? `${Math.floor(s / 86400)}d` : `${Math.floor(s / 86400 / 365)}y`;
};
export const errText = (e: unknown) => (e as Error).message;

/** A file and the path it was renamed from: both, for unstaging or discarding it. */
export const withOrig = (files: GitFile[]) => files.flatMap((f) => (f.orig_path ? [f.path, f.orig_path] : [f.path]));
/** A row's path for staging: the file's, or the folder's (without its `/`). */
export const rowPath = (r: FileRow) => (r.file ? r.file.path : r.key.slice(0, -1));


export const toggled = (set: ReadonlySet<string>, k: string) => {
  const next = new Set(set);
  if (!next.delete(k)) next.add(k);
  return next;
};

export function mainTitle(side: Side, status: GitStatus, row: FileRow | undefined, commit: GitCommit | undefined, stash: GitStash | undefined, turn: Turn | undefined, latest: boolean) {
  if (side === "status") return status.base ? `Branch changes vs ${status.base}` : "Changes";
  if (side === "turns") return turn ? `${latest && !turn.stale ? "Latest turn" : `Turn ${turn.turn}`} · ${turnStat(turn)}` : "Turns";
  if (side === "files") return row ? `Changes in ${row.key}` : "Files";
  if (side === "commits") return commit ? `Commit ${short(commit.sha)}` : "Commit";
  return stash ? `stash@{${stash.index}}` : "Stash";
}

export const NO_DIFFS: FileDiffs = { key: "", unstaged: "", staged: "", tooLarge: false, unstagedPreview: "", stagedPreview: "", notUtf8: false };
export const NOT_UTF8 = "This file isn't UTF-8 text, so its lines can't be staged one by one";

export async function loadFileDiffs(h: string, id: string, r: FileRow): Promise<FileDiffs> {
  const one = async (path: string, q: { staged?: boolean; untracked?: boolean }) => {
    const d = await api.gitDiff(h, id, path, q);
    return { patch: d.patch, tooLarge: !!d.too_large, preview: d.preview ?? "", notUtf8: !!d.not_utf8 };
  };
  const none = { patch: "", tooLarge: false, preview: "", notUtf8: false };
  const path = rowPath(r);
  const [u, s] = await Promise.all([
    r.files.some((f) => hasUnstaged(f) && !untracked(f)) ? one(path, {}) : none,
    r.files.some(hasStaged) ? one(path, { staged: true }) : none,
  ]);
  // Untracked files, as if added (a folder's first few).
  const added = await Promise.all(r.files.filter(untracked).slice(0, 20).map((f) => one(f.path, { untracked: true })));
  return {
    key: r.key,
    unstaged: [u, ...added].map((d) => d.patch).join(""),
    staged: s.patch,
    tooLarge: [u, s, ...added].some((d) => d.tooLarge),
    unstagedPreview: [u, ...added].map((d) => d.preview).join(""),
    stagedPreview: s.preview,
    notUtf8: [u, s, ...added].some((d) => d.notUtf8),
  };
}

/** The working tree's diffs, for comments on their lines. */
export const UNSTAGED: CommentSource = { key: "unstaged", label: "unstaged changes" };
export const STAGED: CommentSource = { key: "staged", label: "staged changes" };
