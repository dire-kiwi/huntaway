// The Changes tab: a lazygit-style view of a task's repository. Panels down the left list the
// branch (Status), the changed files, the commits and the stashes; the main panel on the right shows
// what's selected in them. Files and folders are staged, discarded and committed from the files
// panel, and a file's lines from the main panel (Enter goes into it): space stages or unstages the
// line under the cursor, `v` selects a range of lines and `a` the whole hunk. `?` lists the keys,
// and the bar at the bottom shows (and does) the ones for where you are.
//
// Diffs are highlighted, unified or side by side (`|`), and lines in them can be commented on for the agent (`n`,
// or a line's comment button): the comments wait in a review at the bottom, and in the thread's composer, until
// they're sent (see lineComments.ts).
import clsx from "clsx";
import { ChevronDown, ChevronRight, Loader2, MessageSquare, X } from "lucide-react";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { api, hostSupports, runningAgentSteers, type DiffResult, type GitCommit, type GitCommitShown, type GitFile, type GitStash, type GitStatus, type Task, type Turn, type TurnDiff } from "../api";
import { conflicted, fileRows, hasStaged, hasUnstaged, linesPatch, linesStageable, parseDiff, untracked, type FileDiff, type FileRow } from "../changes";
import { clearReview, commentLines, dropDraft, editComment, lineRange, openDraft, removeComments, useReview, type CommentLines, type CommentSource, type Review } from "../lineComments";
import { useHost } from "../store";
import { hasTurns, turnLabel, turnStat, useTurns } from "../turns";
import { CommentsContext, DiffLines, diffRows, type CommentsApi, type DiffRow, type Layout, type PickHow } from "./DiffLines";
import { RewindDialog } from "./Rewind";
import { rewound, sendComments } from "./Thread";
import { Button, ContextMenu, copyText, Input, isSubmitShortcut, Kbd, Modal, SUBMIT_KEYS, Textarea, type MenuItem } from "./ui";

type Side = "status" | "files" | "commits" | "stash" | "turns";
const SIDES: Side[] = ["status", "files", "commits", "stash"];
const SIDE_TITLES: Record<Side, string> = { status: "Status", files: "Files", commits: "Commits", stash: "Stash", turns: "Turns" };
type Pane = "unstaged" | "staged";
/** How often the view checks for changes (an agent may be making them). */
const POLL_MS = 4000;
const TREE_KEY = "ia.changes.tree";
/** Unified or split diffs, kept in this browser. */
const LAYOUT_KEY = "ia.changes.layout";
/** The keys the view may take, kept for when a change is done. */
const KEYS = /^(.|Enter|Escape|Tab|Arrow\w+|Page\w+|Home|End)$/;
/** An option that's just shown (keys that move around), not done from the bar. */
const noop = () => {};

export function ChangesView({ task }: { task: Task }) {
  const host = useHost(task.host_id);
  // A host from before API 66 only has the branch's whole diff.
  if (!hostSupports(host, 66)) return <BranchOnly task={task} />;
  return <GitView key={task.id} task={task} />;
}

/** One of the view's options: a key and what it does, for the bar at the bottom and the help. */
interface Option {
  key: string;
  label: string;
  run: () => void;
}

interface MenuEntry {
  key: string;
  label: string;
  hint?: string;
  danger?: boolean;
  run: () => void;
}

type Dialog =
  | { kind: "help" }
  | { kind: "confirm"; title: string; body: ReactNode; yes: string; danger?: boolean; onYes: () => void }
  | { kind: "menu"; title: string; items: MenuEntry[] }
  | { kind: "message"; title: string; summary: string; body: string; yes: string; submit: (message: string) => Promise<unknown>; onDraft?: (message: string) => void }
  | { kind: "input"; title: string; placeholder: string; yes: string; submit: (text: string) => void };

/** A file's (or folder's) diffs, as fetched: unstaged and staged. */
interface FileDiffs {
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
const stageRows = (f: FileDiff | null): DiffRow[] => (f && linesStageable(f) ? diffRows(f) : []);
const isChange = (f: FileDiff, r: DiffRow | undefined) => !!r && r.line >= 0 && f.hunks[r.hunk].lines[r.line].kind !== " ";

/** The changed line nearest `i` (looking in direction `dir` first), or -1. */
function nearestChange(f: FileDiff, rows: DiffRow[], i: number, dir: 1 | -1 = 1): number {
  for (const d of [dir, -dir]) for (let j = Math.max(0, Math.min(i, rows.length - 1)); j >= 0 && j < rows.length; j += d) if (isChange(f, rows[j])) return j;
  return -1;
}

const short = (sha: string) => sha.slice(0, 8);
const ago = (secs: number) => {
  const s = Math.max(0, Date.now() / 1000 - secs);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : s < 86400 * 365 ? `${Math.floor(s / 86400)}d` : `${Math.floor(s / 86400 / 365)}y`;
};
const errText = (e: unknown) => (e as Error).message;

/** A file and the path it was renamed from: both, for unstaging or discarding it. */
const withOrig = (files: GitFile[]) => files.flatMap((f) => (f.orig_path ? [f.path, f.orig_path] : [f.path]));
/** A row's path for staging: the file's, or the folder's (without its `/`). */
const rowPath = (r: FileRow) => (r.file ? r.file.path : r.key.slice(0, -1));

function GitView({ task }: { task: Task }) {
  const [h, id] = [task.host_id, task.id];
  // The agent's turns, from their checkpoints (API 70): a fifth panel.
  const turns = useTurns(task);
  const sides: Side[] = hasTurns(useHost(h), task) ? [...SIDES, "turns"] : SIDES;
  const [rewinding, setRewinding] = useState<Turn | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("files");
  const [inMain, setInMain] = useState(false);
  const [tree, setTree] = useState(() => localStorage.getItem(TREE_KEY) !== "flat");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [fileKey, setFileKey] = useState<string | null>(null);
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const [stashSha, setStashSha] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const queued = useRef<[string, boolean][]>([]);
  const [flash, setFlash] = useState<{ text: string; error?: boolean } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; title: string; items: MenuItem[] } | null>(null);
  // Bumped by every check, and by every one but the polls (for what's big to fetch again).
  const [tick, setTick] = useState(0);
  const [askedTick, setAskedTick] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [narrow, setNarrow] = useState(false);

  // Staging: which of the file's diffs, the cursor and the other end of a range (rows of that diff), whole hunks.
  const [pane, setPane] = useState<Pane>("unstaged");
  const [cursor, setCursor] = useState(0);
  const [anchor, setAnchor] = useState<number | null>(null);
  // A range started with `v` follows the cursor; one made with shift (or the mouse) ends at the next plain move.
  const [sticky, setSticky] = useState(false);
  const [hunkMode, setHunkMode] = useState(false);
  const dragging = useRef(false);
  const [layout, setLayout] = useState<Layout>(() => (localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified"));

  // Comments for the agent: the task's review, the draft to focus, and the lines picked in a patch (see PatchView).
  const review = useReview(h, id);
  const [focusDraft, setFocusDraft] = useState<{ id: string } | null>(null);
  const picked = useRef<{ owner: object; comment: () => void } | null>(null);
  const [pickOwner, setPickOwner] = useState<object | null>(null);
  const pickLines = useCallback((owner: object, comment: (() => void) | null) => {
    if (comment) picked.current = { owner, comment };
    else if (picked.current?.owner === owner) picked.current = null;
    else return;
    setPickOwner(comment ? owner : null);
  }, []);
  const comments = useMemo<CommentsApi>(
    () => ({
      hostId: h,
      taskId: id,
      review,
      focus: focusDraft,
      open: (lines) => {
        if (!lines) return;
        // What was typed after the key that opened it is the note's, not keys for the view.
        queued.current = [];
        setFocusDraft({ id: openDraft(h, id, lines) });
      },
      edit: (c) => {
        const d = editComment(h, id, c);
        if (d) setFocusDraft({ id: d });
      },
      done: () => {
        setFocusDraft(null);
        root.current?.focus({ preventScroll: true });
      },
      pickOwner,
      pick: pickLines,
    }),
    [h, id, review, focusDraft, pickOwner, pickLines],
  );

  useEffect(() => root.current?.focus({ preventScroll: true }), []);
  // Back to the view when a dialog closes (one opened from another, as a menu's can be, has nowhere to go back to).
  const dialogOpen = !!dialog || !!menu || !!rewinding;
  const wasOpen = useRef(false);
  // Before the next key comes in, rather than once painted.
  useLayoutEffect(() => {
    if (wasOpen.current && !dialogOpen) root.current?.focus({ preventScroll: true });
    wasOpen.current = dialogOpen;
  }, [dialogOpen]);
  // The commit message being written, kept when its dialog is closed without committing.
  const draft = useRef("");
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 720));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!flash || flash.error) return;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  // The status, kept as it was when nothing changed, so what depends on it isn't fetched again.
  const seq = useRef(0);
  const refresh = useCallback(
    async (poll = false) => {
      const n = ++seq.current;
      let st: GitStatus | null = null;
      try {
        st = await api.gitStatus(h, id);
        if (n !== seq.current) return null;
        setStatus((prev) => (JSON.stringify(prev) === JSON.stringify(st) ? prev : st));
        setLoadErr(null);
      } catch (e) {
        if (n === seq.current) setLoadErr(errText(e));
      }
      setTick((t) => t + 1);
      if (!poll) setAskedTick((t) => t + 1);
      return st;
    },
    [h, id],
  );
  useEffect(() => void refresh(), [refresh, task.running, task.worktree_state]);
  useEffect(() => {
    const poll = setInterval(() => document.visibilityState === "visible" && !busyRef.current && refresh(true), POLL_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  /**
   * Runs a change, one at a time, then shows what's changed (or why it failed): the status and the selected
   * file's diffs, before the keys pressed meanwhile are taken (see `queued`), as lazygit takes them in turn.
   */
  const act = async (label: string, f: () => Promise<unknown>, done?: string) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(label);
    setFlash(null);
    let ok = true;
    try {
      await f();
      if (done) setFlash({ text: done });
    } catch (e) {
      ok = false;
      setFlash({ text: errText(e), error: true });
    } finally {
      const st = await refresh();
      const row = target && st?.files && fileRows(st.files, tree, collapsed).find((r) => r.key === target.key);
      if (row) await loadFileDiffs(h, id, row).then(keepDiffs, () => {});
      busyRef.current = false;
      setBusy(null);
    }
    return ok;
  };

  const files = useMemo(() => status?.files ?? [], [status]);
  const commits = useMemo(() => status?.commits ?? [], [status]);
  const stashes = useMemo(() => status?.stashes ?? [], [status]);
  const rows = useMemo(() => fileRows(files, tree, collapsed), [files, tree, collapsed]);

  // What's selected in each list, by key; one that's gone gives way to the row now where it was.
  const lastIdx = useRef({ files: 0, commits: 0, stash: 0, turns: 0 });
  const pick = <T,>(list: T[], which: "files" | "commits" | "stash" | "turns", at: (t: T) => boolean) => {
    let i = list.findIndex(at);
    if (i < 0) i = Math.min(lastIdx.current[which], list.length - 1);
    lastIdx.current[which] = Math.max(0, i);
    return i;
  };
  const fileIdx = pick(rows, "files", (r) => r.key === fileKey);
  const fileRow = rows[fileIdx] as FileRow | undefined;
  const commitIdx = pick(commits, "commits", (c) => c.sha === commitSha);
  const commit = commits[commitIdx] as GitCommit | undefined;
  const stashIdx = pick(stashes, "stash", (s) => s.sha === stashSha);
  const stash = stashes[stashIdx] as GitStash | undefined;
  // Newest first.
  const turnList = useMemo(() => [...(turns.data?.turns ?? [])].reverse(), [turns.data]);
  const [turnN, setTurnN] = useState<number | null>(null);
  const turnIdx = pick(turnList, "turns", (t) => t.n === turnN);
  const turn = turnList[turnIdx] as Turn | undefined;

  // The selected file's (or folder's) diffs, fetched again on every check, as its content can change
  // while its state doesn't.
  const [fileDiffs, setFileDiffs] = useState<FileDiffs | null>(null);
  const target = side === "files" ? fileRow : undefined;
  const targetSig = target && `${target.key}\n${target.files.map((f) => `${f.x}${f.y}${f.path}`).join("\n")}`;
  const keepDiffs = (d: FileDiffs) => setFileDiffs((p) => (p && JSON.stringify(p) === JSON.stringify(d) ? p : d));
  useEffect(() => {
    if (!target) return;
    let stale = false;
    const key = target.key;
    loadFileDiffs(h, id, target)
      .then((d) => !stale && keepDiffs(d))
      .catch((e) => !stale && setFileDiffs({ ...NO_DIFFS, key, error: errText(e) }));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSig, tick, h, id]);
  const diffs = fileDiffs && target && fileDiffs.key === target.key ? fileDiffs : null;
  const unstagedFiles = useMemo(() => parseDiff(diffs?.unstaged ?? ""), [diffs?.unstaged]);
  const stagedFiles = useMemo(() => parseDiff(diffs?.staged ?? ""), [diffs?.staged]);
  const unstagedPreview = useMemo(() => parseDiff(diffs?.unstagedPreview ?? ""), [diffs?.unstagedPreview]);
  const stagedPreview = useMemo(() => parseDiff(diffs?.stagedPreview ?? ""), [diffs?.stagedPreview]);
  // A single file's diffs can be staged by line.
  const single = !!target?.file;
  const paneFile = (p: Pane) => (single ? ((p === "unstaged" ? unstagedFiles : stagedFiles)[0] ?? null) : null);
  const hasPane = (p: Pane) => {
    const f = paneFile(p);
    return !!f && linesStageable(f);
  };
  // The pane in use: the other when this one has nothing left.
  const activePane: Pane = hasPane(pane) || !hasPane(pane === "unstaged" ? "staged" : "unstaged") ? pane : pane === "unstaged" ? "staged" : "unstaged";
  const file = paneFile(activePane);
  const drows = useMemo(() => stageRows(file), [file]);
  const cur = file ? nearestChange(file, drows, cursor) : -1;
  const staging = inMain && side === "files" && single && cur >= 0;
  // Gone into a file whose diff hasn't come yet.
  const settling = inMain && side === "files" && single && !diffs;

  // A new file (or a changed list) starts at its first change, in its unstaged diff if it has one.
  useEffect(() => {
    setPane("unstaged");
    setCursor(0);
    setAnchor(null);
    setHunkMode(false);
  }, [target?.key]);
  // Out of the main panel once there's nothing left in it to stage.
  useEffect(() => {
    if (inMain && side === "files" && diffs && !hasPane("unstaged") && !hasPane("staged")) setInMain(false);
  });

  // The rows chosen in the diff: the hunk under the cursor, the range, or the line.
  const chosenRows = useMemo(() => {
    const set = new Set<number>();
    if (!file || cur < 0) return set;
    if (hunkMode) drows.forEach((r, i) => r.hunk === drows[cur].hunk && isChange(file, r) && set.add(i));
    else if (anchor !== null) for (let i = Math.min(anchor, cur); i <= Math.max(anchor, cur); i++) isChange(file, drows[i]) && set.add(i);
    else set.add(cur);
    return set;
  }, [file, drows, cur, anchor, hunkMode]);

  // The branch's changes against its base (the Status panel's), a commit's or a stash's.
  const [branch, setBranch] = useState<DiffResult | null>(null);
  useEffect(() => {
    if (side !== "status") return;
    let stale = false;
    api
      .diff(h, id)
      // The same diff (most checks): the same object, so what's picked in it stays.
      .then((d) => !stale && setBranch((p) => (JSON.stringify(p) === JSON.stringify(d) ? p : d)))
      .catch((e) => !stale && setBranch({ available: false, reason: errText(e) }));
    return () => {
      stale = true;
    };
  }, [side, status, askedTick, h, id]);
  // A turn's changes.
  const [turnShown, setTurnShown] = useState<{ key: string; diff?: TurnDiff; error?: string } | null>(null);
  const turnKey = side === "turns" && turn?.diff && turn.before_n !== null ? `${turn.before_n}:${turn.n}` : null;
  useEffect(() => {
    if (!turnKey) return;
    let stale = false;
    const [from, to] = turnKey.split(":").map(Number);
    api
      .turnDiff(h, id, from, to)
      .then((diff) => !stale && setTurnShown({ key: turnKey, diff }))
      .catch((e) => !stale && setTurnShown({ key: turnKey, error: errText(e) }));
    return () => {
      stale = true;
    };
  }, [turnKey, h, id]);
  const [shown, setShown] = useState<{ sha: string; commit?: GitCommitShown; patch?: string; error?: string } | null>(null);
  const showSha = side === "commits" ? commit?.sha : side === "stash" ? stash?.sha : undefined;
  const shownFiles = useMemo(() => parseDiff(shown?.patch ?? ""), [shown]);
  const stashIndex = side === "stash" ? stash?.index : undefined;
  const shownSource = useMemo<CommentSource | undefined>(
    () => (!shown ? undefined : stashIndex !== undefined ? { key: `stash:${shown.sha}`, label: `stash@{${stashIndex}}` } : { key: `commit:${shown.sha}`, label: `commit ${short(shown.sha)}` }),
    [shown, stashIndex],
  );
  useEffect(() => {
    if (!showSha) return;
    let stale = false;
    const load: Promise<{ patch: string; message?: string }> = side === "stash" ? api.gitShowStash(h, id, showSha) : api.gitShow(h, id, showSha);
    load
      .then((r) => !stale && setShown({ sha: showSha, commit: "message" in r ? (r as GitCommitShown) : undefined, patch: r.patch }))
      .catch((e) => !stale && setShown({ sha: showSha, error: errText(e) }));
    return () => {
      stale = true;
    };
  }, [showSha, side, h, id]);

  // Actions.
  const anyUnstaged = files.some(hasUnstaged);
  const anyStaged = files.some(hasStaged);
  const toggleRow = (r: FileRow | undefined) => {
    if (!r) return;
    if (r.files.some(hasUnstaged)) void act("Staging", () => api.gitStage(h, id, [rowPath(r)]));
    else void act("Unstaging", () => api.gitUnstage(h, id, r.file ? withOrig(r.files) : [rowPath(r)]));
  };
  const toggleAll = () => {
    if (!files.length) return setFlash({ text: "No changes" });
    if (anyUnstaged) void act("Staging everything", () => api.gitStage(h, id, []));
    else void act("Unstaging everything", () => api.gitUnstage(h, id, []));
  };
  const discardRow = (r: FileRow | undefined) => {
    if (!r) return;
    const name = r.file ? r.file.path : `${r.key} (${r.files.length} file${r.files.length === 1 ? "" : "s"})`;
    const items: MenuEntry[] = [
      {
        key: "x",
        label: "Discard all changes",
        hint: r.files.some((f) => untracked(f) || f.x === "A") ? "New files are deleted" : "Staged and unstaged, back to the last commit",
        danger: true,
        run: () => void act("Discarding", () => api.gitDiscard(h, id, withOrig(r.files), true), `Discarded ${name}`),
      },
    ];
    if (r.files.some((f) => hasStaged(f) && hasUnstaged(f)))
      items.push({
        key: "u",
        label: "Discard unstaged changes",
        hint: "Keeps what's staged",
        danger: true,
        run: () => void act("Discarding", () => api.gitDiscard(h, id, r.files.filter(hasUnstaged).map((f) => f.path), false), `Discarded unstaged changes in ${name}`),
      });
    setDialog({ kind: "menu", title: `Discard ${name}`, items });
  };
  const commitDialog = (title: string, yes: string, initial: string, submit: (message: string) => Promise<unknown>, onDraft?: (message: string) => void) => {
    const [summary, ...rest] = initial.split("\n");
    setDialog({ kind: "message", title, yes, summary, body: rest.join("\n").replace(/^\n+/, ""), submit, onDraft });
  };
  const startCommit = () => {
    const open = () =>
      commitDialog(
        "Commit",
        "Commit",
        draft.current,
        async (message) => {
          const r = await api.gitCommit(h, id, { message });
          draft.current = "";
          setFlash({ text: `Committed ${short(r.head)}` });
          void refresh();
        },
        (message) => {
          draft.current = message;
        },
      );
    if (anyStaged) return open();
    if (!files.length) return setFlash({ text: "Nothing to commit" });
    setDialog({
      kind: "confirm",
      title: "Nothing is staged",
      body: "Stage all the changes and commit them?",
      yes: "Stage all",
      onYes: () => void act("Staging everything", () => api.gitStage(h, id, [])).then((ok) => ok && open()),
    });
  };
  const head = commits[0];
  // A project folder that's only part of its repository: what acts on the whole repository is left to a terminal.
  const wholeRepo = (what: string) => {
    if (status?.folder) setFlash({ text: `${what} would act on the whole repository, not just ${status.folder}: do it in a terminal`, error: true });
    return !!status?.folder;
  };
  const amend = () => {
    if (wholeRepo("Amending")) return;
    if (!head) return setFlash({ text: "There's no commit to amend", error: true });
    if (status?.merge_base && !head.on_branch) return setFlash({ text: "The last commit isn't on this branch", error: true });
    setDialog({
      kind: "confirm",
      title: "Amend the last commit",
      body: (
        <>
          Add what's staged to <span className="font-mono text-fg">{short(head.sha)}</span> {head.subject}?{head.unpushed ? "" : " It has been pushed already."}
        </>
      ),
      yes: "Amend",
      onYes: () => void act("Amending", () => api.gitCommit(h, id, { message: "", amend: true }), `Amended ${short(head.sha)}`),
    });
  };
  const reword = (c: GitCommit | undefined) => {
    if (!c || wholeRepo("Rewording")) return;
    if (c.sha !== status?.head) return setFlash({ text: "Only the latest commit can be reworded here", error: true });
    void api
      .gitShow(h, id, c.sha)
      .then((r) =>
        commitDialog("Reword the last commit", "Reword", r.message, async (message) => {
          await api.gitCommit(h, id, { message, reword: true });
          setFlash({ text: "Reworded" });
          void refresh();
        }),
      )
      .catch((e) => setFlash({ text: errText(e), error: true }));
  };
  const resetMenu = (c: GitCommit | undefined) => {
    if (!c || wholeRepo("Resetting")) return;
    const to = `${short(c.sha)} ${c.subject}`;
    const reset = (mode: "soft" | "mixed" | "hard") => () => void act("Resetting", () => api.gitReset(h, id, c.sha, mode), `Reset to ${short(c.sha)}`);
    setDialog({
      kind: "menu",
      title: `Reset the branch to ${to}`,
      items: [
        { key: "s", label: "Soft reset", hint: "The later commits' changes stay, staged", run: reset("soft") },
        { key: "m", label: "Mixed reset", hint: "The later commits' changes stay, unstaged", run: reset("mixed") },
        {
          key: "h",
          label: "Hard reset",
          hint: "The later commits and every uncommitted change are thrown away",
          danger: true,
          run: () =>
            setDialog({
              kind: "confirm",
              title: "Hard reset",
              body: `Throw away every commit after ${to}, and all uncommitted changes?`,
              yes: "Hard reset",
              danger: true,
              onYes: reset("hard"),
            }),
        },
      ],
    });
  };
  const stashPush = (mode: "all" | "staged" | "unstaged") => {
    if (wholeRepo("Stashing")) return;
    if (!files.length) return setFlash({ text: "Nothing to stash" });
    setDialog({
      kind: "input",
      title: mode === "all" ? "Stash all changes" : mode === "staged" ? "Stash staged changes" : "Stash unstaged changes",
      placeholder: "Message (optional)",
      yes: "Stash",
      submit: (message) => void act("Stashing", () => api.gitStash(h, id, { action: "push", mode, message }), "Stashed"),
    });
  };
  const stashMenu = () =>
    !wholeRepo("Stashing") &&
    setDialog({
      kind: "menu",
      title: "Stash",
      items: [
        { key: "a", label: "Stash all changes", hint: "Untracked files too", run: () => stashPush("all") },
        { key: "s", label: "Stash staged changes", run: () => stashPush("staged") },
        { key: "u", label: "Stash unstaged changes", hint: "What's staged stays", run: () => stashPush("unstaged") },
      ],
    });
  const stashDo = (action: "apply" | "pop" | "drop", s: GitStash | undefined) => {
    if (!s) return;
    const [doing, done] = { apply: ["Applying", "Applied"], pop: ["Popping", "Popped"], drop: ["Dropping", "Dropped"] }[action];
    const run = () => void act(doing, () => api.gitStash(h, id, { action, index: s.index, sha: s.sha }), `${done} stash@{${s.index}}`);
    if (action === "apply") return run();
    setDialog({
      kind: "confirm",
      title: action === "pop" ? "Pop the stash" : "Drop the stash",
      body: `${action === "pop" ? "Apply and then drop" : "Throw away"} stash@{${s.index}}: ${s.subject}?`,
      yes: action === "pop" ? "Pop" : "Drop",
      danger: action === "drop",
      onYes: run,
    });
  };
  const rewindTo = (t: Turn | undefined) => {
    if (!t) return;
    if (!t.rewind.ok) return setFlash({ text: `Can't rewind to before turn ${t.turn}: ${t.rewind.reason}`, error: true });
    setRewinding(t);
  };
  const copy = (text: string | undefined) => {
    if (!text) return;
    copyText(text);
    setFlash({ text: `Copied ${text}` });
  };

  // Lines: staged from the unstaged diff, unstaged from the staged one, discarded from the unstaged one.
  const applyLines = (what: "stage" | "unstage" | "discard") => {
    if (!file || !chosenRows.size) return;
    const keys = new Set([...chosenRows].map((i) => `${drows[i].hunk}:${drows[i].line}`));
    const patch = linesPatch(file, (hunk, line) => keys.has(`${hunk}:${line}`), what !== "stage");
    if (!patch) return;
    const n = [...chosenRows].length;
    const run = () => {
      setAnchor(null);
      void act(what === "stage" ? "Staging" : what === "unstage" ? "Unstaging" : "Discarding", () => api.gitApply(h, id, patch, { cached: what !== "discard", reverse: what !== "stage" }));
    };
    if (what !== "discard") return run();
    setDialog({ kind: "confirm", title: "Discard lines", body: `Throw away ${hunkMode ? "this hunk" : n === 1 ? "this line's change" : `these ${n} lines' changes`}?`, yes: "Discard", danger: true, onYes: run });
  };
  const linesAction = () => applyLines(activePane === "unstaged" ? "stage" : "unstage");
  const discardLines = () => {
    if (activePane === "staged") return setFlash({ text: "Unstage the lines first to discard them", error: true });
    applyLines("discard");
  };

  const focusSide = (s: Side) => {
    setSide(s);
    setInMain(false);
    root.current?.focus({ preventScroll: true });
  };
  const enterMain = () => {
    if (side === "files") {
      if (!fileRow) return;
      if (!fileRow.file) return setCollapsed((c) => toggled(c, fileRow.key));
      // Still loading, it goes in, and comes out again if there's nothing to stage.
      if (diffs && !hasPane("unstaged") && !hasPane("staged")) return setFlash({ text: diffs.tooLarge ? "The diff is too big to stage by line" : diffs.notUtf8 ? NOT_UTF8 : "No lines to stage in this file" });
    }
    setInMain(true);
  };
  const toggled = (set: ReadonlySet<string>, k: string) => {
    const next = new Set(set);
    if (!next.delete(k)) next.add(k);
    return next;
  };
  const setTreeMode = (t: boolean) => {
    setTree(t);
    localStorage.setItem(TREE_KEY, t ? "tree" : "flat");
  };
  const toggleLayout = () => {
    const next = layout === "split" ? "unified" : "split";
    setLayout(next);
    localStorage.setItem(LAYOUT_KEY, next);
  };
  const layoutOption: Option = { key: "|", label: layout === "split" ? "Unified" : "Split", run: toggleLayout };

  // A comment on lines of a file's diff being staged: the range (or hunk) picked, or the cursor's line, or with
  // `at` (a line's comment button), that line unless it's in what's picked.
  const isUntracked = !!target?.file && untracked(target.file);
  const stagingSources = useMemo<Record<Pane, CommentSource>>(() => ({ unstaged: isUntracked ? { key: "unstaged", label: "an untracked file" } : UNSTAGED, staged: STAGED }), [isUntracked]);
  const stagingSource = (p: Pane) => stagingSources[p];
  const commentStaging = (p: Pane = activePane, at?: number) => {
    const f = paneFile(p);
    if (!f) return;
    const rs = stageRows(f);
    let [from, to] = [cur, cur];
    if (hunkMode && cur >= 0) {
      from = rs.findIndex((r) => r.hunk === rs[cur].hunk);
      to = rs.findLastIndex((r) => r.hunk === rs[cur].hunk);
    } else if (anchor !== null && cur >= 0) [from, to] = [Math.min(anchor, cur), Math.max(anchor, cur)];
    if (at !== undefined && !(inMain && p === activePane && cur >= 0 && at >= from && at <= to)) [from, to] = [at, at];
    if (from < 0) return;
    comments.open(commentLines(f, stagingSource(p), rs.slice(from, to + 1).filter((r) => r.line >= 0)));
    setAnchor(null);
    setHunkMode(false);
  };
  const commentKey = () => {
    if (staging) return commentStaging();
    if (picked.current) return picked.current.comment();
    setFlash({ text: inMain ? "Pick lines by their numbers first (drag or shift-click for more), or use a line's comment button" : "Go into a diff (Enter) to pick lines to comment on" });
  };
  // A comment in the review: to its diff, and scrolled to.
  const [jump, setJump] = useState<string | null>(null);
  const jumpTo = (c: CommentLines, anchorId: string) => {
    if (c.where === "unstaged" || c.where === "staged") {
      setCollapsed((cs) => new Set([...cs].filter((k) => !c.path.startsWith(k))));
      setSide("files");
      setFileKey(c.path);
    } else if (c.where === "branch") setSide("status");
    else if (c.where.startsWith("commit:")) {
      setSide("commits");
      setCommitSha(c.where.slice("commit:".length));
    } else if (c.where.startsWith("stash:")) {
      setSide("stash");
      setStashSha(c.where.slice("stash:".length));
    } else if (c.where.startsWith("turn:")) {
      setSide("turns");
      setTurnN(Number(c.where.split(":")[2]));
    }
    setInMain(false);
    setJump(anchorId);
  };
  useEffect(() => {
    if (!jump) return;
    const el = root.current?.querySelector(`[data-comment="${CSS.escape(jump)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    setJump(null);
  });
  // Off the jump once the diffs it's in have come and it isn't there (outdated, or folded away).
  useEffect(() => {
    if (!jump) return;
    const t = setTimeout(() => setJump(null), 3000);
    return () => clearTimeout(t);
  }, [jump]);
  const discardReview = () =>
    setDialog({
      kind: "confirm",
      title: "Discard the comments",
      body: `Throw away ${review.comments.length + review.drafts.length === 1 ? "the comment for the agent, which hasn't" : "all the comments for the agent that haven't"} been sent?`,
      yes: "Discard",
      danger: true,
      onYes: () => clearReview(h, id),
    });

  // Moving in a list, or in the main panel.
  const mainScroll = useRef<HTMLDivElement>(null);
  const page = 12;
  const moveIn = (s: Side, by: number | "first" | "last") => {
    const n = s === "files" ? rows.length : s === "commits" ? commits.length : s === "stash" ? stashes.length : s === "turns" ? turnList.length : 0;
    if (!n) return;
    const at = s === "files" ? fileIdx : s === "commits" ? commitIdx : s === "stash" ? stashIdx : turnIdx;
    const i = by === "first" ? 0 : by === "last" ? n - 1 : Math.max(0, Math.min(n - 1, at + by));
    if (s === "files") setFileKey(rows[i].key);
    else if (s === "commits") setCommitSha(commits[i].sha);
    else if (s === "stash") setStashSha(stashes[i].sha);
    else if (s === "turns") setTurnN(turnList[i].n);
  };
  const moveCursor = (by: number | "first" | "last", extend = false) => {
    if (!file || cur < 0) return;
    if (extend && anchor === null && !hunkMode) {
      setAnchor(cur);
      setSticky(false);
    } else if (!extend && anchor !== null && !sticky) setAnchor(null);
    let next = cur;
    if (by === "first" || by === "last") next = nearestChange(file, drows, by === "first" ? 0 : drows.length - 1, by === "first" ? 1 : -1);
    else if (hunkMode) {
      // From hunk to hunk.
      const h0 = drows[cur].hunk + Math.sign(by);
      const first = drows.findIndex((r) => r.hunk === h0 && isChange(file, r));
      if (first >= 0) next = first;
    } else {
      const dir = by > 0 ? 1 : -1;
      for (let left = Math.abs(by), j = cur + dir; left > 0 && j >= 0 && j < drows.length; j += dir) {
        if (isChange(file, drows[j])) {
          next = j;
          left--;
        }
      }
    }
    setCursor(next);
  };
  const toggleRange = () => {
    setAnchor(anchor === null ? cur : null);
    setSticky(true);
    setHunkMode(false);
  };
  const jumpHunk = (dir: 1 | -1) => {
    if (!file || cur < 0) return;
    const h0 = drows[cur].hunk + dir;
    const first = drows.findIndex((r) => r.hunk === h0 && isChange(file, r));
    if (first >= 0) {
      setCursor(first);
      setAnchor(null);
    }
  };
  const scrollMain = (by: number | "first" | "last" | "page" | "-page") => {
    const el = mainScroll.current;
    if (!el) return;
    if (by === "first") el.scrollTop = 0;
    else if (by === "last") el.scrollTop = el.scrollHeight;
    else el.scrollTop += by === "page" ? el.clientHeight * 0.9 : by === "-page" ? -el.clientHeight * 0.9 : by * 18;
  };
  const jumpFile = (dir: 1 | -1) => {
    const el = mainScroll.current;
    if (!el) return;
    const heads = [...el.querySelectorAll<HTMLElement>("[data-file-head]")];
    const top = el.getBoundingClientRect().top;
    const offsets = heads.map((x) => x.getBoundingClientRect().top - top);
    const to = dir > 0 ? offsets.find((o) => o > 4) : offsets.filter((o) => o < -4).at(-1);
    if (to !== undefined) el.scrollTop += to;
  };

  // The options where you are: in the bar at the bottom (the first few) and in the help (all).
  const options = (): { title: string; items: Option[] }[] => {
    const nav: Option[] = [
      { key: `1-${sides.length}`, label: "Panel", run: noop },
      { key: "R", label: "Refresh", run: () => void refresh() },
      { key: "?", label: "Keybindings", run: () => setDialog({ kind: "help" }) },
    ];
    if (staging)
      return [
        {
          title: activePane === "unstaged" ? "Unstaged changes" : "Staged changes",
          items: [
            { key: "space", label: activePane === "unstaged" ? "Stage" : "Unstage", run: linesAction },
            ...(activePane === "unstaged" ? [{ key: "d", label: "Discard", run: discardLines }] : []),
            { key: "v", label: anchor === null ? "Select range" : "End range", run: toggleRange },
            { key: "a", label: hunkMode ? "Select lines" : "Select hunk", run: () => setHunkMode(!hunkMode) },
            ...(hasPane(activePane === "unstaged" ? "staged" : "unstaged") ? [{ key: "tab", label: activePane === "unstaged" ? "Staged" : "Unstaged", run: () => switchPane() }] : []),
            { key: "n", label: "Comment", run: commentKey },
            { key: "c", label: "Commit", run: startCommit },
            layoutOption,
            { key: "esc", label: "Back", run: () => setInMain(false) },
            { key: "←/→", label: "Hunk", run: noop },
          ],
        },
        { title: "Anywhere", items: nav },
      ];
    if (inMain)
      return [
        {
          title: "Main",
          items: [
            { key: "n", label: "Comment", run: commentKey },
            layoutOption,
            { key: "j/k", label: "Scroll", run: noop },
            { key: "[/]", label: "File", run: noop },
            { key: "esc", label: "Back", run: () => setInMain(false) },
          ],
        },
        { title: "Anywhere", items: nav },
      ];
    const own: Record<Side, Option[]> = {
      status: [{ key: "enter", label: "Scroll the changes", run: enterMain }],
      files: [
        { key: "space", label: fileRow && !fileRow.files.some(hasUnstaged) ? "Unstage" : "Stage", run: () => toggleRow(fileRow) },
        { key: "enter", label: fileRow && !fileRow.file ? (collapsed.has(fileRow.key) ? "Expand" : "Collapse") : "Stage lines", run: enterMain },
        { key: "c", label: "Commit", run: startCommit },
        { key: "a", label: anyUnstaged || !files.length ? "Stage all" : "Unstage all", run: toggleAll },
        { key: "d", label: "Discard", run: () => discardRow(fileRow) },
        { key: "A", label: "Amend", run: amend },
        { key: "s", label: "Stash", run: () => stashPush("all") },
        { key: "S", label: "Stash options", run: stashMenu },
        { key: "`", label: tree ? "Flat list" : "Tree", run: () => setTreeMode(!tree) },
        { key: "-/=", label: "Collapse/expand all", run: noop },
        { key: "y", label: "Copy path", run: () => copy(fileRow && rowPath(fileRow)) },
      ],
      commits: [
        { key: "enter", label: "Scroll the patch", run: enterMain },
        { key: "g", label: "Reset to here", run: () => resetMenu(commit) },
        { key: "r", label: "Reword", run: () => reword(commit) },
        { key: "y", label: "Copy hash", run: () => copy(commit?.sha) },
      ],
      stash: [
        { key: "space", label: "Apply", run: () => stashDo("apply", stash) },
        { key: "g", label: "Pop", run: () => stashDo("pop", stash) },
        { key: "d", label: "Drop", run: () => stashDo("drop", stash) },
        { key: "enter", label: "Scroll the patch", run: enterMain },
      ],
      turns: [
        { key: "enter", label: "Scroll the changes", run: enterMain },
        { key: "g", label: "Rewind to before it", run: () => rewindTo(turn) },
        { key: "y", label: "Copy the message", run: () => copy(turn?.text) },
      ],
    };
    own[side].push(layoutOption);
    return [
      { title: SIDE_TITLES[side], items: own[side] },
      { title: "Anywhere", items: [{ key: "↑/↓", label: "Move", run: noop }, { key: "←/→", label: "Panel", run: noop }, ...nav] },
    ];
  };
  const switchPane = () => {
    const other = activePane === "unstaged" ? "staged" : "unstaged";
    if (!hasPane(other)) return;
    setPane(other);
    setCursor(0);
    setAnchor(null);
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (dialog || menu || rewinding) return;
    if ((e.target as Element).closest("input, textarea, select, [contenteditable], [data-modal]")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // While a change is made, keys wait for it (the next space stages the next line, not one from the old diff), and
    // in a file's diff, for the diff.
    const queue = busyRef.current || settling || queued.current.length > 0;
    if (queue ? KEYS.test(e.key) && (queued.current.push([e.key, e.shiftKey]), true) : handleKey(e.key, e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  // One waiting key a render, each with what the one before it did.
  const [, setTaken] = useState(0);
  useEffect(() => {
    if (busy || settling || !queued.current.length) return;
    // What was typed after a key that opened a dialog wasn't meant as keys.
    if (dialog || menu) return void (queued.current = []);
    const [key, shift] = queued.current.shift()!;
    handleKey(key, shift);
    setTaken((n) => n + 1);
  });
  const handleKey = (key: string, shift: boolean): boolean => {
    if (/^[1-9]$/.test(key) && +key <= sides.length) {
      focusSide(sides[+key - 1]);
      return true;
    }
    if (key === "?") return (setDialog({ kind: "help" }), true);
    if (key === "R") return (void refresh(), true);
    if (key === "|") return (toggleLayout(), true);
    if (key === "n") return (commentKey(), true);
    if (staging) {
      const k: Record<string, () => void> = {
        ArrowUp: () => moveCursor(-1, shift),
        k: () => moveCursor(-1),
        K: () => moveCursor(-1, true),
        ArrowDown: () => moveCursor(1, shift),
        j: () => moveCursor(1),
        J: () => moveCursor(1, true),
        PageUp: () => moveCursor(-page, shift),
        ",": () => moveCursor(-page),
        PageDown: () => moveCursor(page, shift),
        ".": () => moveCursor(page),
        Home: () => moveCursor("first", shift),
        "<": () => moveCursor("first"),
        End: () => moveCursor("last", shift),
        ">": () => moveCursor("last"),
        ArrowLeft: () => jumpHunk(-1),
        h: () => jumpHunk(-1),
        ArrowRight: () => jumpHunk(1),
        l: () => jumpHunk(1),
        " ": linesAction,
        d: discardLines,
        v: toggleRange,
        a: () => {
          setHunkMode(!hunkMode);
          setAnchor(null);
        },
        Tab: switchPane,
        c: startCommit,
        A: amend,
        Escape: () => (anchor !== null ? setAnchor(null) : hunkMode ? setHunkMode(false) : setInMain(false)),
      };
      return k[key] ? (k[key](), true) : false;
    }
    if (inMain) {
      const k: Record<string, () => void> = {
        ArrowUp: () => scrollMain(-3),
        k: () => scrollMain(-3),
        ArrowDown: () => scrollMain(3),
        j: () => scrollMain(3),
        PageUp: () => scrollMain("-page"),
        ",": () => scrollMain("-page"),
        PageDown: () => scrollMain("page"),
        ".": () => scrollMain("page"),
        " ": () => scrollMain("page"),
        Home: () => scrollMain("first"),
        "<": () => scrollMain("first"),
        End: () => scrollMain("last"),
        ">": () => scrollMain("last"),
        "[": () => jumpFile(-1),
        "]": () => jumpFile(1),
        ArrowLeft: () => jumpFile(-1),
        ArrowRight: () => jumpFile(1),
        Escape: () => setInMain(false),
      };
      return k[key] ? (k[key](), true) : false;
    }
    const at = sides.indexOf(side);
    const k: Record<string, () => void> = {
      ArrowLeft: () => focusSide(sides[(at + sides.length - 1) % sides.length]),
      h: () => focusSide(sides[(at + sides.length - 1) % sides.length]),
      ArrowRight: () => focusSide(sides[(at + 1) % sides.length]),
      l: () => focusSide(sides[(at + 1) % sides.length]),
      ArrowUp: () => moveIn(side, -1),
      k: () => moveIn(side, -1),
      ArrowDown: () => moveIn(side, 1),
      j: () => moveIn(side, 1),
      PageUp: () => moveIn(side, -page),
      ",": () => moveIn(side, -page),
      PageDown: () => moveIn(side, page),
      ".": () => moveIn(side, page),
      Home: () => moveIn(side, "first"),
      "<": () => moveIn(side, "first"),
      End: () => moveIn(side, "last"),
      ">": () => moveIn(side, "last"),
      Enter: enterMain,
    };
    if (side === "files")
      Object.assign(k, {
        " ": () => toggleRow(fileRow),
        a: toggleAll,
        d: () => discardRow(fileRow),
        c: startCommit,
        A: amend,
        s: () => stashPush("all"),
        S: stashMenu,
        "`": () => setTreeMode(!tree),
        "-": () => setCollapsed(new Set(rows.filter((r) => !r.file && r.depth === 0).map((r) => r.key))),
        "=": () => setCollapsed(new Set()),
        y: () => copy(fileRow && rowPath(fileRow)),
      });
    if (side === "commits") Object.assign(k, { g: () => resetMenu(commit), r: () => reword(commit), y: () => copy(commit?.sha) });
    if (side === "stash") Object.assign(k, { " ": () => stashDo("apply", stash), g: () => stashDo("pop", stash), d: () => stashDo("drop", stash) });
    if (side === "turns") Object.assign(k, { g: () => rewindTo(turn), y: () => copy(turn?.text) });
    return k[key] ? (k[key](), true) : false;
  };

  // Clicks in a diff: a line puts the cursor on it (shift or a drag selects from where it was).
  const pickLine = (p: Pane, i: number, how: "down" | "shift" | "enter") => {
    if (how === "enter" && !dragging.current) return;
    root.current?.focus({ preventScroll: true });
    if (p !== activePane) {
      setPane(p);
      setAnchor(null);
      setCursor(i);
    } else if (how === "shift") {
      if (anchor === null && cur >= 0) setAnchor(cur);
      setCursor(i);
    } else if (how === "enter") setCursor(i);
    else {
      setAnchor(i);
      setCursor(i);
      dragging.current = true;
    }
    setHunkMode(false);
    setSticky(false);
    setInMain(true);
    setSide("files");
  };
  useEffect(() => {
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      // A click rather than a drag leaves no range.
      setAnchor((a) => (a === cursorRef.current ? null : a));
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);
  const cursorRef = useRef(cur);
  cursorRef.current = cur;
  const hunkAction = (p: Pane, hunk: number, what: "stage" | "unstage" | "discard") => {
    const f = paneFile(p);
    if (!f) return;
    const patch = linesPatch(f, (hh) => hh === hunk, what !== "stage");
    if (!patch) return;
    const run = () => void act(what === "stage" ? "Staging" : what === "unstage" ? "Unstaging" : "Discarding", () => api.gitApply(h, id, patch, { cached: what !== "discard", reverse: what !== "stage" }));
    if (what === "discard") setDialog({ kind: "confirm", title: "Discard the hunk", body: "Throw away this hunk's changes?", yes: "Discard", danger: true, onYes: run });
    else run();
  };

  const shell = (children: ReactNode) => (
    <div
      ref={root}
      tabIndex={0}
      onKeyDown={onKey}
      onFocus={() => setFocused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setFocused(false)}
      // Keys go to the view after a click anywhere in it (buttons in it don't take the focus).
      onMouseDownCapture={(e) => !(e.target as Element).closest("input, textarea, [data-modal], [role^=menu]") && root.current?.focus({ preventScroll: true })}
      className="flex h-full min-h-0 flex-col bg-bg font-mono text-[12px] leading-[18px] outline-none"
    >
      <CommentsContext.Provider value={comments}>{children}</CommentsContext.Provider>
    </div>
  );
  if (!status)
    return shell(
      <div className="flex h-full items-center justify-center font-sans text-[13px] text-faint">
        {loadErr ? <span className="text-red-400">Couldn't read the repository: {loadErr}</span> : <Loader2 size={16} className="animate-spin" />}
      </div>,
    );
  if (!status.available) return shell(<div className="p-5 font-sans text-[13px] text-muted">Changes unavailable: {status.reason}</div>);

  const opts = options();
  const repoName = status.dir?.split("/").filter(Boolean).at(-1) ?? "";
  const branchCommits = commits.filter((c) => c.on_branch).length;
  const sidePanel = (s: Side, n: number, body: ReactNode, extra?: { grow?: string; right?: ReactNode }) => (
    <Panel
      title={`[${n}] ${SIDE_TITLES[s]}`}
      active={side === s && !inMain}
      focused={focused}
      className={extra?.grow}
      right={extra?.right}
      onMouseDown={() => {
        if (side !== s || inMain) focusSide(s);
      }}
    >
      {body}
    </Panel>
  );
  const grow = (s: Side, on: string, off: string) => (side === s ? on : off);

  return shell(
    <>
      {(task.running || status.state || loadErr || status.folder) && (
        <div className="shrink-0 border-b border-line px-3 py-1 text-[11.5px]">
          {status.folder && (
            <div className="text-amber-300">
              The project's folder is only <span className="font-mono">{status.folder}</span> in the repository at <span className="font-mono">{status.dir}</span>: this shows
              its files and the commits that touch them. Committing what's staged elsewhere, amending, stashing and resetting are left to a terminal.
            </div>
          )}
          {loadErr && <div className="text-red-400">Couldn't refresh: {loadErr}</div>}
          {status.state && <div className="text-amber-300">The repository is {status.state}: finish or abort that in the terminal.</div>}
          {task.running && <div className="text-faint">The agent is working in this folder: changes made here may clash with its own.</div>}
        </div>
      )}
      <div className={clsx("flex min-h-0 flex-1 gap-2 px-2 pt-3 pb-1", narrow && "flex-col")}>
        <div className={clsx("flex min-h-0 flex-col gap-3", narrow ? "h-[46%] shrink-0" : "w-[34%] max-w-[440px] min-w-[230px] shrink-0")}>
          {sidePanel(
            "status",
            1,
            <div className="px-1.5" title={status.dir}>
              <div className="truncate">
                <span className="text-emerald-400">{repoName}</span>
                <span className="text-faint"> → </span>
                <span className="text-fg">{status.branch ?? (status.head ? `(detached ${short(status.head)})` : "(no commits)")}</span>
              </div>
              <div className="truncate text-faint">
                {status.base ? `${branchCommits} commit${branchCommits === 1 ? "" : "s"} since ${status.base}` : "No base branch"}
                {status.upstream ? ` · ↑${status.ahead}↓${status.behind} ${status.upstream}` : " · no upstream"}
              </div>
            </div>,
            { grow: "shrink-0" },
          )}
          {sidePanel(
            "files",
            2,
            <FilesList
              rows={rows}
              selected={fileIdx}
              active={side === "files"}
              collapsed={collapsed}
              onSelect={(r) => {
                setFileKey(r.key);
                if (side !== "files" || inMain) focusSide("files");
              }}
              onOpen={(r) => {
                setFileKey(r.key);
                if (!r.file) setCollapsed((c) => toggled(c, r.key));
                else setInMain(true);
              }}
              onToggle={toggleRow}
              onMenu={(r, x, y) => {
                setFileKey(r.key);
                setMenu({
                  x,
                  y,
                  title: rowPath(r),
                  items: [
                    { label: r.files.some(hasUnstaged) ? "Stage" : "Unstage", onSelect: () => toggleRow(r) },
                    { label: "Discard…", onSelect: () => discardRow(r) },
                    { label: "Copy path", divider: true, onSelect: () => copy(rowPath(r)) },
                  ],
                });
              }}
              empty={status.truncated ? "" : "No changes"}
            />,
            { grow: grow("files", "flex-[3]", "flex-[2]"), right: status.truncated ? <span className="text-amber-300">first {files.length}</span> : files.length ? <span>{files.length}</span> : null },
          )}
          {sidePanel(
            "commits",
            3,
            <List
              items={commits}
              selected={commitIdx}
              active={side === "commits"}
              empty="No commits"
              onSelect={(c) => {
                setCommitSha(c.sha);
                if (side !== "commits" || inMain) focusSide("commits");
              }}
              onOpen={() => setInMain(true)}
              onMenu={(c, x, y) => {
                setCommitSha(c.sha);
                setMenu({
                  x,
                  y,
                  title: `${short(c.sha)} ${c.subject}`,
                  items: [
                    { label: "Reset to here…", onSelect: () => resetMenu(c) },
                    ...(c.sha === status.head ? [{ label: "Reword…", onSelect: () => reword(c) }] : []),
                    { label: "Copy hash", divider: true, onSelect: () => copy(c.sha) },
                  ],
                });
              }}
              render={(c, i) => (
                <div className={clsx("flex gap-2 px-1.5", status.merge_base && !c.on_branch && i > 0 && commits[i - 1].on_branch && "border-t border-line")} title={`${c.subject}\n${c.author}, ${new Date(c.time * 1000).toLocaleString()}`}>
                  <span className={clsx("shrink-0", c.unpushed ? "text-red-400" : status.merge_base && !c.on_branch ? "text-emerald-500" : "text-amber-300")}>{short(c.sha)}</span>
                  <span className={clsx("min-w-0 flex-1 truncate", status.merge_base && !c.on_branch ? "text-faint" : "text-fg")}>{c.subject}</span>
                  <span className="shrink-0 text-faint">{ago(c.time)}</span>
                </div>
              )}
            />,
            { grow: grow("commits", "flex-[3]", "flex-[1.4]") },
          )}
          {sidePanel(
            "stash",
            4,
            <List
              items={stashes}
              selected={stashIdx}
              active={side === "stash"}
              empty="No stashes"
              onSelect={(s) => {
                setStashSha(s.sha);
                if (side !== "stash" || inMain) focusSide("stash");
              }}
              onOpen={() => setInMain(true)}
              onMenu={(s, x, y) => {
                setStashSha(s.sha);
                setMenu({
                  x,
                  y,
                  title: `stash@{${s.index}}`,
                  items: [
                    { label: "Apply", onSelect: () => stashDo("apply", s) },
                    { label: "Pop…", onSelect: () => stashDo("pop", s) },
                    { label: "Drop…", onSelect: () => stashDo("drop", s) },
                  ],
                });
              }}
              render={(s) => (
                <div className="flex gap-2 px-1.5" title={s.subject}>
                  <span className="shrink-0 text-faint">{s.index}</span>
                  <span className="min-w-0 flex-1 truncate">{s.subject}</span>
                  <span className="shrink-0 text-faint">{ago(s.time)}</span>
                </div>
              )}
            />,
            { grow: grow("stash", "flex-[1.6] min-h-[60px]", "flex-[0.6] min-h-[44px]") },
          )}
          {sides.includes("turns") &&
            sidePanel(
              "turns",
              5,
              <List
                items={turnList}
                selected={turnIdx}
                active={side === "turns"}
                empty={turns.error ? `Couldn't load: ${turns.error}` : turns.data && !turns.data.available ? `No checkpoints: ${turns.data.reason}` : "No turns yet"}
                onSelect={(t) => {
                  setTurnN(t.n);
                  if (side !== "turns" || inMain) focusSide("turns");
                }}
                onOpen={() => setInMain(true)}
                onMenu={(t, x, y) => {
                  setTurnN(t.n);
                  setMenu({
                    x,
                    y,
                    title: `Turn ${t.turn}`,
                    items: [
                      { label: "Rewind to before it…", onSelect: () => rewindTo(t) },
                      { label: "Copy the message", divider: true, onSelect: () => copy(t.text) },
                    ],
                  });
                }}
                render={(t, i) => (
                  <div className={clsx("flex gap-2 px-1.5", t.stale && "opacity-50")} title={`Turn ${t.turn}: ${t.text}\n${turnStat(t)}${t.stale ? "\nRewound: a rewind went back to before it" : ""}`}>
                    <span className={clsx("shrink-0", t.review_round ? "text-st-review" : "text-amber-300")}>#{t.turn}</span>
                    <span className={clsx("min-w-0 flex-1 truncate", t.auto ? "text-muted" : "text-fg", t.stale && "line-through")}>
                      {i === 0 && !t.stale && <span className="text-accent">latest · </span>}
                      {turnLabel(t)}
                    </span>
                    {t.stats && t.stats.files > 0 && (
                      <span className="shrink-0">
                        <span className="text-emerald-400">+{t.stats.additions}</span> <span className="text-red-400">−{t.stats.deletions}</span>
                      </span>
                    )}
                    <span className="shrink-0 text-faint">{ago(Date.parse(t.at) / 1000)}</span>
                  </div>
                )}
              />,
              { grow: grow("turns", "flex-[3] min-h-[60px]", "flex-[1.2] min-h-[44px]"), right: turnList.length ? <span>{turnList.length}</span> : null },
            )}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          {side === "files" && single ? (
            <>
              {diffs?.error && <Note error>{diffs.error}</Note>}
              {diffs?.tooLarge && <Note>The diff is too big to show: stage or discard the whole file from the files panel.</Note>}
              {diffs?.notUtf8 && <Note>{NOT_UTF8}: stage or discard it whole from the files panel.</Note>}
              {(["unstaged", "staged"] as Pane[])
                .filter((p) => (p === "unstaged" ? hasUnstaged : hasStaged)(target!.file!))
                .map((p, k) => {
                  const f = paneFile(p);
                  const on = p === activePane;
                  return (
                    <Panel
                      key={p}
                      title={p === "unstaged" ? (target?.file && untracked(target.file) ? "Untracked file" : "Unstaged changes") : "Staged changes"}
                      active={inMain && on}
                      focused={focused}
                      className="flex-1"
                      right={
                        <>
                          {inMain && on && (hunkMode || anchor !== null) && <span className="mr-2 text-accent">{hunkMode ? "hunk" : "range"}</span>}
                          {k === 0 && <LayoutToggle layout={layout} onToggle={toggleLayout} />}
                        </>
                      }
                    >
                      {!f ? (
                        // Shown as it is, never as lines to stage.
                        (p === "unstaged" ? unstagedPreview : stagedPreview).length > 0 && <PatchView files={p === "unstaged" ? unstagedPreview : stagedPreview} empty="" layout={layout} />
                      ) : linesStageable(f) ? (
                        <DiffLines
                          file={f}
                          layout={layout}
                          source={stagingSource(p)}
                          cursor={inMain && on ? cur : -1}
                          chosen={inMain && on ? chosenRows : null}
                          pick="changed"
                          onLine={(i, how) => pickLine(p, i, how)}
                          onComment={(i) => commentStaging(p, i)}
                          hunkActions={p === "unstaged" ? ["stage", "discard"] : ["unstage"]}
                          onHunk={(hunk, what) => hunkAction(p, hunk, what)}
                        />
                      ) : (
                        <RawDiff file={f} />
                      )}
                    </Panel>
                  );
                })}
              {!hasUnstaged(target!.file!) && !hasStaged(target!.file!) && <EmptyMain text="No changes to show" />}
            </>
          ) : (
            <Panel
              title={mainTitle(side, status, fileRow, commit, stash, turn, turnIdx === 0)}
              active={inMain}
              focused={focused}
              className="flex-1"
              scrollRef={mainScroll}
              right={<LayoutToggle layout={layout} onToggle={toggleLayout} />}
            >
              {side === "turns" ? (
                turn ? (
                  <TurnView turn={turn} shown={turnShown?.key === turnKey ? turnShown : null} layout={layout} />
                ) : (
                  <EmptyMain text={turns.data?.available === false ? "" : "No turns with checkpoints yet: one is taken as each of the agent's turns ends"} />
                )
              ) : side === "files" ? (
                fileRow ? (
                  diffs && (
                    <>
                      {diffs.error && <Note error>{diffs.error}</Note>}
                      {diffs.tooLarge && <Note>Some of the diffs are too big to show.</Note>}
                      {unstagedFiles.length > 0 && <PatchView files={unstagedFiles} head={<Section>Unstaged</Section>} empty="" layout={layout} source={UNSTAGED} />}
                      {unstagedPreview.length > 0 && <PatchView files={unstagedPreview} head={!unstagedFiles.length && <Section>Unstaged</Section>} empty="" layout={layout} />}
                      {stagedFiles.length > 0 && <PatchView files={stagedFiles} head={<Section>Staged</Section>} empty="" layout={layout} source={STAGED} />}
                      {stagedPreview.length > 0 && <PatchView files={stagedPreview} head={!stagedFiles.length && <Section>Staged</Section>} empty="" layout={layout} />}
                    </>
                  )
                ) : (
                  <EmptyMain text={files.length ? "" : "No changes in the working tree"} />
                )
              ) : side === "status" ? (
                <BranchView diff={branch} layout={layout} />
              ) : (side === "commits" ? commit : stash) ? (
                shown && shown.sha === showSha ? (
                  shown.error ? (
                    <Note error>{shown.error}</Note>
                  ) : (
                    <PatchView
                      files={shownFiles}
                      head={shown.commit && <CommitHead c={shown.commit} />}
                      empty="No changes"
                      layout={layout}
                      source={shownSource}
                    />
                  )
                ) : null
              ) : (
                <EmptyMain text={side === "commits" ? "No commits" : "No stashes"} />
              )}
            </Panel>
          )}
        </div>
      </div>
      <ReviewBar task={task} review={review} onJump={jumpTo} onDiscard={discardReview} onError={(text) => setFlash({ text, error: true })} />
      <OptionsBar options={opts[0].items} busy={busy} flash={flash} onDismiss={() => setFlash(null)} />
      {menu && <ContextMenu x={menu.x} y={menu.y} title={menu.title} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog && <DialogView dialog={dialog} options={opts} onClose={() => setDialog(null)} />}
      {rewinding && (
        <RewindDialog
          task={task}
          turn={rewinding}
          head={turns.data?.head}
          onClose={() => setRewinding(null)}
          onDone={(r, convo) => {
            rewound(task, r, convo);
            setFlash({ text: `Rewound to before turn ${rewinding.turn}: ${r.written} restored, ${r.removed} removed` });
            void refresh();
            void turns.reload();
          }}
        />
      )}
    </>,
  );
}

function mainTitle(side: Side, status: GitStatus, row: FileRow | undefined, commit: GitCommit | undefined, stash: GitStash | undefined, turn: Turn | undefined, latest: boolean) {
  if (side === "status") return status.base ? `Branch changes vs ${status.base}` : "Changes";
  if (side === "turns") return turn ? `${latest && !turn.stale ? "Latest turn" : `Turn ${turn.turn}`} · ${turnStat(turn)}` : "Turns";
  if (side === "files") return row ? `Changes in ${row.key}` : "Files";
  if (side === "commits") return commit ? `Commit ${short(commit.sha)}` : "Commit";
  return stash ? `stash@{${stash.index}}` : "Stash";
}

const NO_DIFFS: FileDiffs = { key: "", unstaged: "", staged: "", tooLarge: false, unstagedPreview: "", stagedPreview: "", notUtf8: false };
const NOT_UTF8 = "This file isn't UTF-8 text, so its lines can't be staged one by one";

async function loadFileDiffs(h: string, id: string, r: FileRow): Promise<FileDiffs> {
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

/** A box with its title in its top border, as lazygit draws its panels. */
function Panel({
  title,
  active,
  focused,
  className,
  right,
  children,
  scrollRef,
  onMouseDown,
}: {
  title: string;
  active: boolean;
  focused: boolean;
  className?: string;
  right?: ReactNode;
  children: ReactNode;
  scrollRef?: Ref<HTMLDivElement>;
  onMouseDown?: () => void;
}) {
  return (
    <section
      onMouseDown={onMouseDown}
      className={clsx("relative flex min-h-[38px] min-w-0 flex-col rounded border", active ? (focused ? "border-emerald-400/80" : "border-emerald-400/45") : "border-line-strong", className)}
    >
      <div className="pointer-events-none absolute -top-[9px] right-2 left-2 flex items-center justify-between gap-2 text-[11px] leading-4">
        <span className={clsx("truncate bg-bg px-1", active ? "font-semibold text-emerald-300" : "text-muted")}>{title}</span>
        {right && <span className="pointer-events-auto shrink-0 bg-bg px-1 text-faint">{right}</span>}
      </div>
      {/* A size container: comments under lines are as wide as it, however wide the lines are. */}
      <div ref={scrollRef} className="@container min-h-0 flex-1 overflow-auto pt-1.5 pb-0.5">
        {children}
      </div>
    </section>
  );
}

/** Keeps the selected row in view. */
function useScrollTo(selected: number) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.querySelector(`[data-i="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return ref;
}

function List<T>({
  items,
  selected,
  active,
  empty,
  render,
  onSelect,
  onOpen,
  onMenu,
}: {
  items: T[];
  selected: number;
  active: boolean;
  empty: string;
  render: (t: T, i: number) => ReactNode;
  onSelect: (t: T) => void;
  onOpen: (t: T) => void;
  onMenu: (t: T, x: number, y: number) => void;
}) {
  const ref = useScrollTo(selected);
  if (!items.length) return <div className="px-1.5 text-faint">{empty}</div>;
  return (
    <div ref={ref}>
      {items.map((t, i) => (
        <div
          key={i}
          data-i={i}
          onMouseDown={(e) => e.button === 0 && onSelect(t)}
          onDoubleClick={() => onOpen(t)}
          onContextMenu={(e) => {
            e.preventDefault();
            onMenu(t, e.clientX, e.clientY);
          }}
          className={clsx("cursor-default whitespace-nowrap", i === selected && (active ? "bg-accent/25" : "bg-white/[0.06]"))}
        >
          {render(t, i)}
        </div>
      ))}
    </div>
  );
}

function FilesList({
  rows,
  selected,
  active,
  collapsed,
  empty,
  onSelect,
  onOpen,
  onToggle,
  onMenu,
}: {
  rows: FileRow[];
  selected: number;
  active: boolean;
  collapsed: ReadonlySet<string>;
  empty: string;
  onSelect: (r: FileRow) => void;
  onOpen: (r: FileRow) => void;
  onToggle: (r: FileRow) => void;
  onMenu: (r: FileRow, x: number, y: number) => void;
}) {
  const ref = useScrollTo(selected);
  if (!rows.length) return <div className="px-1.5 text-faint">{empty}</div>;
  return (
    <div ref={ref}>
      {rows.map((r, i) => {
        const staged = r.files.filter(hasStaged).length;
        const unstaged = r.files.filter(hasUnstaged).length;
        const tone = r.files.some(conflicted) ? "text-amber-400" : !unstaged ? "text-emerald-400" : staged ? "text-amber-200" : "text-red-300";
        return (
          <div
            key={r.key}
            data-i={i}
            onMouseDown={(e) => e.button === 0 && onSelect(r)}
            onDoubleClick={() => onOpen(r)}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu(r, e.clientX, e.clientY);
            }}
            title={r.file?.orig_path ? `${r.file.orig_path} → ${r.file.path}` : r.key}
            className={clsx("flex cursor-default items-center whitespace-pre pr-1.5", i === selected && (active ? "bg-accent/25" : "bg-white/[0.06]"))}
            style={{ paddingLeft: 6 + r.depth * 14 }}
          >
            {r.file ? (
              <button
                tabIndex={-1}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onToggle(r)}
                title={unstaged ? "Stage" : "Unstage"}
                className="mr-1.5 shrink-0 rounded hover:bg-white/10"
              >
                <span className={untracked(r.file) || conflicted(r.file) ? "text-red-400" : "text-emerald-400"}>{r.file.x}</span>
                <span className="text-red-400">{r.file.y}</span>
              </button>
            ) : (
              <span className="mr-1.5 w-[2ch] shrink-0 text-center text-faint">{collapsed.has(r.key) ? "▶" : "▼"}</span>
            )}
            <span className={clsx("truncate", tone)}>
              {r.name}
              {!r.file && "/"}
            </span>
            {r.file?.orig_path && <span className="ml-1 truncate text-faint">← {r.file.orig_path}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** A diff with no lines to stage (a conflict's, a binary file's), as it is. */
function RawDiff({ file }: { file: FileDiff }) {
  const lines = file.combined ? file.raw : file.header.slice(1);
  return (
    <div className="w-max min-w-full px-1.5 whitespace-pre">
      {file.binary && <div className="text-muted">Binary file: stage or discard it whole from the files panel.</div>}
      {file.combined && <div className="mb-1 text-amber-300">A conflict: resolve it in the file, then stage it from the files panel.</div>}
      {lines.map((l, i) => (
        <div key={i} className={clsx(/^(\+\+|\+ | \+)/.test(l) ? "text-emerald-300" : /^(--|- | -)/.test(l) ? "text-red-300" : /^@@/.test(l) ? "text-accent" : "text-[#b4b4c4]")}>
          {l || " "}
        </div>
      ))}
    </div>
  );
}

/** The working tree's diffs, for comments on their lines. */
const UNSTAGED: CommentSource = { key: "unstaged", label: "unstaged changes" };
const STAGED: CommentSource = { key: "staged", label: "staged changes" };

/**
 * Several files' diffs (a commit's, the branch's), each under a header that folds it away. With a `source`, lines
 * are picked by their numbers (drag or shift-click for more) and commented on for the agent.
 */
function PatchView({ files, head, empty, layout, source }: { files: FileDiff[]; head?: ReactNode; empty: string; layout: Layout; source?: CommentSource }) {
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const big = (f: FileDiff) => f.adds + f.dels > 1500;
  const isFolded = (f: FileDiff, i: number) => folded[`${i}:${f.path}`] ?? big(f);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  // The lines picked: in which file, and from which row to which (rows as DiffLines counts them).
  const [sel, setSel] = useState<{ file: number; anchor: number; cursor: number } | null>(null);
  const dragging = useRef(false);
  const comments = useContext(CommentsContext);
  const me = useRef({}).current;
  // Comments need the view's (not there for a host from before it).
  if (!comments) source = undefined;
  // Files that change (a refresh) or a new patch: nothing picked.
  useEffect(() => setSel(null), [files]);
  const commentOn = (k: number, from: number, to: number) => {
    const f = files[k];
    if (!f || !source || !comments) return;
    const rows = diffRows(f).slice(Math.min(from, to), Math.max(from, to) + 1);
    comments.open(commentLines(f, source, rows.filter((r) => r.line >= 0)));
    setSel(null);
  };
  // `n` comments on what's picked here, until another diff picks lines.
  const { pick, pickOwner } = comments ?? {};
  useEffect(() => {
    if (!pick) return;
    pick(me, sel ? () => commentOn(sel.file, sel.anchor, sel.cursor) : null);
  });
  useEffect(() => () => pick?.(me, null), [pick, me]);
  useEffect(() => {
    if (pickOwner && pickOwner !== me) setSel(null);
  }, [pickOwner, me]);
  useEffect(() => {
    const up = () => void (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);
  const onLine = (k: number, i: number, how: PickHow) => {
    if (how === "enter") {
      if (dragging.current) setSel((s) => (s && s.file === k ? { ...s, cursor: i } : s));
      return;
    }
    if (how === "shift") return setSel((s) => (s && s.file === k ? { ...s, cursor: i } : { file: k, anchor: i, cursor: i }));
    dragging.current = true;
    setSel({ file: k, anchor: i, cursor: i });
  };
  const chosen = useMemo(() => {
    if (!sel) return null;
    const set = new Set<number>();
    for (let i = Math.min(sel.anchor, sel.cursor); i <= Math.max(sel.anchor, sel.cursor); i++) set.add(i);
    return set;
  }, [sel]);
  return (
    <div className="min-w-full">
      {head}
      {!files.length && <div className="px-1.5 text-faint">{empty}</div>}
      {files.length > 1 && (
        <div className="mb-2 px-1.5">
          <div className="text-faint">
            {files.length} files changed, <span className="text-emerald-400">+{files.reduce((a, f) => a + f.adds, 0)}</span>{" "}
            <span className="text-red-400">−{files.reduce((a, f) => a + f.dels, 0)}</span>
          </div>
          {files.map((f, i) => (
            <div key={i} className="flex cursor-pointer gap-2 hover:bg-white/5" onClick={() => refs.current[i]?.scrollIntoView({ block: "start" })}>
              <span className="min-w-0 flex-1 truncate text-muted">{fileLabel(f)}</span>
              <span className="shrink-0 text-emerald-400">+{f.adds}</span>
              <span className="w-[6ch] shrink-0 text-red-400">−{f.dels}</span>
            </div>
          ))}
        </div>
      )}
      {files.map((f, i) => {
        const k = `${i}:${f.path}`;
        const fold = isFolded(f, i);
        return (
          <div key={k} ref={(el) => void (refs.current[i] = el)} data-file={f.path}>
            <div
              data-file-head
              onClick={() => setFolded((s) => ({ ...s, [k]: !fold }))}
              className="sticky top-[-6px] z-10 flex cursor-pointer gap-2 border-y border-line bg-panel-2 px-1.5"
            >
              <span className="text-faint">{fold ? "▶" : "▼"}</span>
              <span className="min-w-0 flex-1 truncate text-fg">{fileLabel(f)}</span>
              <span className="shrink-0 text-emerald-400">+{f.adds}</span>
              <span className="shrink-0 text-red-400">−{f.dels}</span>
            </div>
            {!fold && (
              <div className={clsx("py-0.5", layout === "split" ? "w-full" : "w-max min-w-full")}>
                {f.binary ? (
                  <div className="px-1.5 text-muted">Binary file</div>
                ) : f.combined || !f.hunks.length ? (
                  <RawDiff file={f} />
                ) : (
                  <DiffLines
                    file={f}
                    layout={layout}
                    source={source}
                    chosen={sel?.file === i ? chosen : null}
                    pick={source ? "numbers" : null}
                    onLine={(row, how) => onLine(i, row, how)}
                    onComment={(row) => (sel?.file === i && chosen?.has(row) ? commentOn(i, sel.anchor, sel.cursor) : commentOn(i, row, row))}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const fileLabel = (f: FileDiff) =>
  f.oldPath && f.newPath && f.oldPath !== f.newPath ? `${f.oldPath} → ${f.newPath}` : f.oldPath === null ? `${f.path} (new)` : f.newPath === null ? `${f.path} (deleted)` : f.path;

function CommitHead({ c }: { c: GitCommitShown }) {
  return (
    <div className="mb-2 px-1.5">
      <div className="text-amber-300">commit {c.sha}</div>
      <div className="text-muted">
        {c.author} &lt;{c.email}&gt; · {new Date(c.time * 1000).toLocaleString()}
      </div>
      <div className="mt-1 font-sans text-[13px] whitespace-pre-wrap text-fg">{c.message}</div>
    </div>
  );
}

/** A patch shown as the Changes tab shows one, for elsewhere (the review tab's rounds of fixes). */
export function PatchBox({ patch, empty }: { patch: string; empty: string }) {
  const files = useMemo(() => parseDiff(patch), [patch]);
  return (
    <div className="max-h-[480px] overflow-auto rounded-md border border-line bg-bg py-1.5 font-mono text-[12px] leading-[18px]">
      <PatchView files={files} empty={empty} layout="unified" />
    </div>
  );
}

/** What one of the agent's turns changed: from the checkpoint before it to its own, without what git brought in. */
function TurnView({ turn, shown, layout }: { turn: Turn; shown: { diff?: TurnDiff; error?: string } | null; layout: Layout }) {
  const files = useMemo(() => parseDiff(shown?.diff?.patch ?? ""), [shown]);
  const label = turnLabel(turn);
  const source = useMemo<CommentSource>(
    () => ({ key: `turn:${turn.before_n}:${turn.n}`, label: `what the agent changed in turn ${turn.turn}, "${label.length > 60 ? `${label.slice(0, 60)}…` : label}"` }),
    [turn.before_n, turn.n, turn.turn, label],
  );
  const excluded = shown?.diff?.excluded ?? turn.stats?.excluded ?? [];
  const head = (
    <div className="mb-2 px-1.5">
      <div className="line-clamp-6 font-sans text-[13px] whitespace-pre-wrap text-fg">{turn.text || "(no message)"}</div>
      <div className="text-faint">
        {turn.review_round ? `Review fixes, round ${turn.review_round} · ` : ""}
        {turn.status === "stopped" ? "Stopped" : turn.status === "failed" ? "Failed" : "Ended"} {new Date(turn.at).toLocaleString()}
      </div>
      {turn.stale && <div className="text-amber-300">A rewind went back to before this turn.</div>}
      {excluded.length > 0 && (
        <div className="text-faint" title={excluded.join("\n")}>
          Left out: {excluded.length} file{excluded.length === 1 ? "" : "s"} git brought in (a merge, pull or rebase) that the turn didn't change itself:{" "}
          {excluded.slice(0, 5).join(", ")}
          {excluded.length > 5 && "…"}
        </div>
      )}
      {shown?.diff?.too_large && <div className="text-amber-300">The diff is too big to show.</div>}
    </div>
  );
  if (!turn.diff)
    return (
      <>
        {head}
        <Note>
          {turn.before_n === null
            ? "There's no checkpoint from before this turn (it started before checkpoints were taken), so what it changed can't be shown."
            : "This turn's checkpoints are gone from the repository."}
        </Note>
      </>
    );
  if (!shown) return head;
  if (shown.error)
    return (
      <>
        {head}
        <Note error>{shown.error}</Note>
      </>
    );
  return <PatchView files={files} head={head} empty="No changes in this turn" layout={layout} source={source} />;
}

/** The branch's changes against its base: its commits, and everything changed (uncommitted work too). */
export function BranchView({ diff, layout }: { diff: DiffResult | null; layout: Layout }) {
  const files = useMemo(() => parseDiff(diff?.patch ?? ""), [diff]);
  const base = diff?.base;
  const source = useMemo<CommentSource>(() => ({ key: "branch", label: base ? `the branch's changes against ${base}, uncommitted ones too` : "the branch's changes" }), [base]);
  if (!diff) return null;
  if (!diff.available) return <Note error>Diff unavailable: {diff.reason}</Note>;
  return (
    <PatchView
      files={files}
      layout={layout}
      source={source}
      empty="No changes yet."
      head={
        <div className="mb-2 px-1.5">
          {diff.merge_base && (
            <div className="text-faint">
              From {diff.merge_base.slice(0, 8)} on {diff.base}
              {diff.branch ? `: the commits on ${diff.branch} (the task has no worktree)` : ", with uncommitted changes"}
            </div>
          )}
          {diff.commits?.trim() && <div className="mt-1 whitespace-pre-wrap text-muted">{diff.commits.trim()}</div>}
          {diff.patch?.includes("\n… [truncated") && <div className="mt-1 text-amber-300">The diff is too big to show all of it.</div>}
        </div>
      }
    />
  );
}

function Section({ children }: { children: ReactNode }) {
  return <div className="mb-1 px-1.5 font-semibold text-muted">{children}</div>;
}

function Note({ children, error }: { children: ReactNode; error?: boolean }) {
  return <div className={clsx("px-1.5 text-[12px]", error ? "text-red-400" : "text-muted")}>{children}</div>;
}

function EmptyMain({ text }: { text: string }) {
  return text ? <div className="flex h-full items-center justify-center font-sans text-[13px] text-faint">{text}</div> : null;
}

/** Unified or side-by-side diffs (`|`). */
export function LayoutToggle({ layout, onToggle }: { layout: Layout; onToggle: () => void }) {
  return (
    <span className="flex gap-0.5" title="Unified or split diffs (|)">
      {(["unified", "split"] as Layout[]).map((l) => (
        <button
          key={l}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => l !== layout && onToggle()}
          className={clsx("rounded px-1", l === layout ? "bg-white/10 text-fg" : "text-faint hover:text-muted")}
        >
          {l}
        </button>
      ))}
    </span>
  );
}

/**
 * The comments for the agent that haven't been sent: how many, a list of them (each one goes to its lines), and a
 * button that sends them all as one message, as the thread's composer would (queued or steered while the agent works).
 */
function ReviewBar({
  task,
  review,
  onJump,
  onDiscard,
  onError,
}: {
  task: Task;
  review: Review;
  onJump: (c: CommentLines, anchorId: string) => void;
  onDiscard: () => void;
  onError: (text: string) => void;
}) {
  const host = useHost(task.host_id);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const { comments, drafts } = review;
  if (!comments.length && !drafts.length) return null;
  // Hosts before API 10 refuse messages while the agent is running.
  const blocked = task.running && !hostSupports(host, 10);
  const queue = task.running && (!runningAgentSteers(host, task) || !!task.queued_message);
  const send = async () => {
    setSending(true);
    const end = await sendComments(task, comments);
    setSending(false);
    if ("error" in end) onError(`Couldn't send the comments: ${end.error}`);
    else setOpen(false);
  };
  const unfinished = drafts.filter((d) => !d.of);
  return (
    <div className="shrink-0 border-t border-line font-sans text-[12px]" data-review>
      {open && (
        <div className="max-h-48 overflow-y-auto border-b border-line py-1">
          {[...comments.map((c) => ({ c, anchor: c.id, draft: drafts.some((d) => d.of === c.id) })), ...unfinished.map((d) => ({ c: d, anchor: d.id, draft: true }))].map(
            ({ c, anchor, draft }) => (
              <div key={anchor} className="group flex items-baseline gap-2 px-3 py-0.5 hover:bg-white/[0.04]">
                <button tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => onJump(c, anchor)} className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
                  <span className="shrink-0 font-mono text-[11.5px] text-muted">
                    {c.path}, {lineRange(c)}
                  </span>
                  <span className="shrink-0 text-[11px] text-faint">{c.source}</span>
                  <span className={clsx("min-w-0 truncate", draft ? "text-amber-300" : "text-fg")}>{draft ? (c.note.trim() ? `${c.note} (being written)` : "(being written)") : c.note}</span>
                </button>
                <button
                  tabIndex={-1}
                  title="Delete the comment"
                  onMouseDown={(e) => e.preventDefault()}
                  // One being written may be where it can't be seen any more (its lines changed): it goes from here.
                  onClick={() => (anchor === c.id && drafts.some((d) => d.id === c.id) ? dropDraft(task.host_id, task.id, c.id) : removeComments(task.host_id, task.id, [c.id]))}
                  className="shrink-0 self-center rounded text-faint opacity-0 group-hover:opacity-100 hover:text-red-300"
                >
                  <X size={12} />
                </button>
              </div>
            ),
          )}
        </div>
      )}
      <div className="flex h-8 items-center gap-2 px-2">
        <button tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-muted hover:text-fg">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <MessageSquare size={12} className="text-accent" />
          {comments.length ? `${comments.length} comment${comments.length === 1 ? "" : "s"} for the agent` : "No comments added yet"}
          {unfinished.length > 0 && <span className="text-amber-300">· {unfinished.length} being written</span>}
        </button>
        <span className="truncate text-[11px] text-faint">also in the thread's composer, to send with a message</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button size="sm" onMouseDown={(e) => e.preventDefault()} onClick={onDiscard}>
            Discard
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!comments.length || sending || blocked}
            title={blocked ? "This host takes messages once the agent has finished" : queue ? "Queued: the agent gets them when it finishes" : "Sends them to the agent as one message"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void send()}
          >
            {sending && <Loader2 size={12} className="animate-spin" />}
            {queue ? "Queue for the agent" : "Send to the agent"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The bar at the bottom: what can be done where you are (each one clickable), and what's going on. */
function OptionsBar({ options, busy, flash, onDismiss }: { options: Option[]; busy: string | null; flash: { text: string; error?: boolean } | null; onDismiss: () => void }) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-line px-2 text-[11.5px]">
      <div className="flex min-w-0 flex-1 items-center gap-x-3 overflow-hidden whitespace-nowrap">
        {options
          .filter((o) => o.run !== noop)
          .map((o) => (
            <button key={o.key + o.label} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={o.run} className="shrink-0 text-muted hover:text-fg">
              <span className="text-accent">{o.label}</span>: {o.key}
            </button>
          ))}
        <span className="shrink-0 text-faint">Keybindings: ?</span>
      </div>
      {busy ? (
        <span className="flex shrink-0 items-center gap-1.5 text-muted">
          <Loader2 size={11} className="animate-spin" /> {busy}…
        </span>
      ) : flash ? (
        <button
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onDismiss}
          title="Dismiss"
          className={clsx("max-w-[55%] shrink-0 truncate text-left", flash.error ? "text-red-400" : "text-emerald-400")}
        >
          {flash.text}
        </button>
      ) : null}
    </div>
  );
}

function DialogView({ dialog, options, onClose }: { dialog: Dialog; options: { title: string; items: Option[] }[]; onClose: () => void }) {
  if (dialog.kind === "help") return <HelpDialog options={options} onClose={onClose} />;
  if (dialog.kind === "menu") return <MenuDialog title={dialog.title} items={dialog.items} onClose={onClose} />;
  if (dialog.kind === "confirm")
    return (
      <Modal
        title={dialog.title}
        onClose={onClose}
        onSubmit={() => {
          onClose();
          dialog.onYes();
        }}
      >
        <div className="text-[13px] text-muted">{dialog.body}</div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            autoFocus
            variant={dialog.danger ? "danger" : "primary"}
            onClick={() => {
              onClose();
              dialog.onYes();
            }}
          >
            {dialog.yes}
          </Button>
        </div>
      </Modal>
    );
  if (dialog.kind === "input") return <InputDialog dialog={dialog} onClose={onClose} />;
  return <MessageDialog dialog={dialog} onClose={onClose} />;
}

function InputDialog({ dialog, onClose }: { dialog: Extract<Dialog, { kind: "input" }>; onClose: () => void }) {
  const [text, setText] = useState("");
  const submit = () => {
    onClose();
    dialog.submit(text.trim());
  };
  return (
    <Modal title={dialog.title} onClose={onClose} onSubmit={submit}>
      <Input autoFocus value={text} placeholder={dialog.placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit}>
          {dialog.yes}
        </Button>
      </div>
    </Modal>
  );
}

/** A commit message: a summary line (Enter commits) and a description. */
function MessageDialog({ dialog, onClose }: { dialog: Extract<Dialog, { kind: "message" }>; onClose: () => void }) {
  const [summary, setSummary] = useState(dialog.summary);
  const [body, setBody] = useState(dialog.body);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const message = body.trim() ? `${summary.trim()}\n\n${body.trim()}` : summary.trim();
  const { onDraft } = dialog;
  useEffect(() => {
    onDraft?.(message);
  }, [onDraft, message]);
  const submit = async () => {
    if (!summary.trim() || saving) return;
    setSaving(true);
    setErr(null);
    try {
      await dialog.submit(message);
      onClose();
    } catch (e) {
      setErr(errText(e));
      setSaving(false);
    }
  };
  return (
    <Modal title={dialog.title} onClose={onClose} onSubmit={() => void submit()} width="max-w-xl">
      <div className="space-y-2" data-draft={summary || body ? "" : undefined}>
        <Input
          autoFocus
          value={summary}
          placeholder="Summary"
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !isSubmitShortcut(e) && void submit()}
          className="font-mono"
        />
        <Textarea value={body} placeholder="Description (optional)" rows={6} onChange={(e) => setBody(e.target.value)} className="font-mono text-[12.5px]" />
      </div>
      {err && <div className="mt-2 max-h-40 overflow-auto font-mono text-[11.5px] whitespace-pre-wrap text-red-400">{err}</div>}
      <div className="mt-4 flex items-center justify-end gap-2">
        <span className="mr-auto text-[11.5px] text-faint">
          Enter in the summary or {SUBMIT_KEYS} to {dialog.yes.toLowerCase()}
        </span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!summary.trim() || saving} onClick={() => void submit()}>
          {saving && <Loader2 size={12} className="animate-spin" />} {dialog.yes}
        </Button>
      </div>
    </Modal>
  );
}

/** lazygit's menus: an item's key picks it, or move to it and press Enter. */
function MenuDialog({ title, items, onClose }: { title: string; items: MenuEntry[]; onClose: () => void }) {
  const [at, setAt] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const choose = (m: MenuEntry) => {
    onClose();
    m.run();
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        className="outline-none"
        onKeyDown={(e) => {
          const m = items.find((x) => x.key === e.key);
          if (m) choose(m);
          else if (e.key === "ArrowDown" || e.key === "j") setAt((at + 1) % items.length);
          else if (e.key === "ArrowUp" || e.key === "k") setAt((at + items.length - 1) % items.length);
          else if (e.key === "Enter" || e.key === " ") choose(items[at]);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {items.map((m, i) => (
          <button
            key={m.key}
            tabIndex={-1}
            onMouseEnter={() => setAt(i)}
            onClick={() => choose(m)}
            className={clsx("flex w-full items-baseline gap-3 rounded-md px-2.5 py-1.5 text-left", i === at && "bg-white/[0.07]")}
          >
            <Kbd>{m.key}</Kbd>
            <span className={clsx("text-[13px]", m.danger ? "text-red-300" : "text-fg")}>{m.label}</span>
            {m.hint && <span className="ml-auto text-[11.5px] text-faint">{m.hint}</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function HelpDialog({ options, onClose }: { options: { title: string; items: Option[] }[]; onClose: () => void }) {
  return (
    <Modal title="Keybindings" onClose={onClose} width="max-w-2xl">
      <div className="max-h-[65vh] space-y-4 overflow-y-auto">
        {[...options, ...HELP].map((g) => (
          <div key={g.title}>
            <div className="mb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">{g.title}</div>
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[12.5px]">
              {g.items.map((o) => (
                <div key={o.key + o.label} className="contents">
                  <span className="font-mono text-accent">{o.key}</span>
                  <span className="text-muted">{o.label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** The rest, for the help: what's not where you are now. */
const HELP: { title: string; items: Option[] }[] = [
  {
    title: "Staging lines (Enter on a file)",
    items: [
      ["↑/↓ j/k", "Move between changed lines"],
      ["shift+↑/↓ J/K", "Select a range"],
      ["←/→ h/l", "Previous / next hunk"],
      ["space", "Stage (or, in the staged changes, unstage) the lines"],
      ["v", "Start or end a range"],
      ["a", "Select whole hunks"],
      ["d", "Discard the lines"],
      ["tab", "Switch between unstaged and staged changes"],
      ["click, shift+click, drag", "Put the cursor on a line, select a range"],
      ["esc", "Back to the files"],
    ].map(([key, label]) => ({ key, label, run: noop })),
  },
  {
    title: "Comments for the agent",
    items: [
      ["n", "Comment on the line under the cursor, or the lines picked (in a commit's or the branch's diff, pick lines by their numbers)"],
      ["hover a line", "Its comment button"],
      ["Enter / Shift+Enter", "In a comment: add it / a new line"],
      ["|", "Unified or split diffs"],
    ].map(([key, label]) => ({ key, label, run: noop })),
  },
  {
    title: "Lists",
    items: [
      ["↑/↓ j/k", "Move"],
      [", .  PgUp/PgDn", "A page up or down"],
      ["< >  Home/End", "First, last"],
      ["←/→ h/l, 1-4", "Panels"],
      ["right-click", "A menu for the file, commit or stash"],
    ].map(([key, label]) => ({ key, label, run: noop })),
  },
];

/** The branch's whole diff alone, from a host from before the Changes tab could stage (API 66). */
function BranchOnly({ task }: { task: Task }) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  useEffect(() => {
    api
      .diff(task.host_id, task.id)
      .then(setDiff)
      .catch((e) => setDiff({ available: false, reason: errText(e) }));
  }, [task.host_id, task.id, task.running, task.worktree_state]);
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg font-mono text-[12px] leading-[18px]">
      <div className="shrink-0 border-b border-line px-3 py-1 text-[11.5px] text-faint">Update this host to stage, commit and browse commits here.</div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <BranchView diff={diff} layout="unified" />
      </div>
    </div>
  );
}
