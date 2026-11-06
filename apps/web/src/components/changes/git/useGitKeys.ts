import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { hasUnstaged } from "../diffs";
import type { GitActions } from "./useGitActions";
import type { GitSelection } from "./useGitSelection";
import type { Staging } from "./useStaging";
import { noop, rowPath, SIDE_TITLES, type Dialog, type Option, type Side } from "./model";

/** The keys the view may take, kept for when a change is done. */
const KEYS = /^(.|Enter|Escape|Tab|Arrow\w+|Page\w+|Home|End)$/;

export interface GitKeysOptions {
  /** The panels, in their keys' order. */
  sides: Side[];
  sel: GitSelection;
  staging: Staging;
  actions: GitActions;
  refresh: () => unknown;
  toggleLayout: () => void;
  layoutOption: Option;
  commentKey: () => void;
  focusSide: (s: Side) => void;
  enterMain: () => void;
  setDialog: (d: Dialog) => void;
  /** A dialog or menu is open (keys are its own), and the rewind dialog. */
  dialog: boolean;
  menu: boolean;
  rewinding: boolean;
  busyRef: RefObject<boolean>;
  /** Keys pressed while a change is made (or a file's diff comes), taken once it's done. */
  queued: RefObject<[string, boolean][]>;
}

/**
 * The Changes tab's keys: what they do where you are (`onKey`, for the view's keydown), and `options`, the ones for
 * the bar at the bottom and the help. `mainScroll` is the main panel's scrolling box, which keys scroll.
 */
export function useGitKeys(o: GitKeysOptions) {
  const { sides, refresh, toggleLayout, layoutOption, commentKey, focusSide, enterMain, setDialog, dialog, menu, rewinding, busyRef, queued } = o;
  const { side, inMain, setInMain, fileRow, collapsed, setCollapsed, files, rows, tree, setTreeMode, commit, stash, turn, moveIn } = o.sel;
  const { active: staging, settling, activePane, anchor, setAnchor, hunkMode, setHunkMode, hasPane, moveCursor, toggleRange, jumpHunk, switchPane } = o.staging;
  const { busy, anyUnstaged, toggleRow, toggleAll, discardRow, startCommit, amend, reword, resetMenu, stashPush, stashMenu, stashDo, rewindTo, copy, linesAction, discardLines } = o.actions;

  // Moving in a list, or in the main panel.
  const mainScroll = useRef<HTMLDivElement>(null);
  const page = 12;

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

  const onKey = (e: ReactKeyboardEvent) => {
    if (dialog || menu || rewinding) return;
    if ((e.target as Element).closest("input, textarea, select, [contenteditable], [data-modal]")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // While a change is made, keys wait for it (the next space stages the next line, not one from the old diff), in a
    // file's diff, for the diff, and after a key, for what it did to be rendered.
    const queue = busyRef.current || taking.current || settling || queued.current.length > 0;
    if (queue ? KEYS.test(e.key) && (queued.current.push([e.key, e.shiftKey]), true) : take(e.key, e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  // A key is taken with what the one before it did: until that's rendered (`taking`), the next keys wait, as this
  // render's `onKey` and `handleKey` would take them with the state from before it (on a slow machine, an Escape back
  // to the files, then a `j` that moved the cursor in the diff that was left).
  const [taken, setTaken] = useState(0);
  const taking = useRef(false);
  useLayoutEffect(() => void (taking.current = false), [taken]);
  const take = (key: string, shift: boolean) => {
    if (!handleKey(key, shift)) return false;
    taking.current = true;
    setTaken((n) => n + 1);
    return true;
  };
  // Waiting keys, one a render.
  useEffect(() => {
    if (busy || settling || taking.current || !queued.current.length) return;
    // What was typed after a key that opened a dialog wasn't meant as keys.
    if (dialog || menu) return void (queued.current = []);
    const [key, shift] = queued.current.shift()!;
    // One that isn't a key here (now) is dropped, and the next is taken in the next render.
    if (!take(key, shift)) setTaken((n) => n + 1);
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

  return { options, onKey, mainScroll };
}
