import { useEffect, useMemo, useRef, useState } from "react";
import { linesStageable, type FileRow } from "../diffs";
import type { FileDiffsView } from "./useFileDiffs";
import type { GitSelection } from "./useGitSelection";
import { isChange, nearestChange, stageRows, type Pane } from "./model";

export type Staging = ReturnType<typeof useStaging>;

/**
 * Staging a file's lines: which of its diffs (`pane`), the cursor and the other end of a range (rows of that diff), or
 * whole hunks. `target` is the selected row of the files panel, if that's the panel you're in, and `focus` gives the
 * view the keys back after a click in a diff.
 */
export function useStaging(target: FileRow | undefined, d: FileDiffsView, sel: GitSelection, focus: () => void) {
  const { inMain, side, setInMain, setSide } = sel;
  const [pane, setPane] = useState<Pane>("unstaged");
  const [cursor, setCursor] = useState(0);
  const [anchor, setAnchor] = useState<number | null>(null);
  // A range started with `v` follows the cursor; one made with shift (or the mouse) ends at the next plain move.
  const [sticky, setSticky] = useState(false);
  const [hunkMode, setHunkMode] = useState(false);
  const dragging = useRef(false);

  // A single file's diffs can be staged by line.
  const single = !!target?.file;
  const paneFile = (p: Pane) => (single ? ((p === "unstaged" ? d.unstagedFiles : d.stagedFiles)[0] ?? null) : null);
  const hasPane = (p: Pane) => {
    const f = paneFile(p);
    return !!f && linesStageable(f);
  };
  // The pane in use: the other when this one has nothing left.
  const activePane: Pane = hasPane(pane) || !hasPane(pane === "unstaged" ? "staged" : "unstaged") ? pane : pane === "unstaged" ? "staged" : "unstaged";
  const file = paneFile(activePane);
  const drows = useMemo(() => stageRows(file), [file]);
  const cur = file ? nearestChange(file, drows, cursor) : -1;
  // Staging lines: in a file's diff, on one of its changes.
  const active = inMain && side === "files" && single && cur >= 0;
  // Gone into a file whose diff hasn't come yet.
  const settling = inMain && side === "files" && single && !d.diffs;

  // A new file (or a changed list) starts at its first change, in its unstaged diff if it has one.
  useEffect(() => {
    setPane("unstaged");
    setCursor(0);
    setAnchor(null);
    setHunkMode(false);
  }, [target?.key]);
  // Out of the main panel once there's nothing left in it to stage.
  useEffect(() => {
    if (inMain && side === "files" && d.diffs && !hasPane("unstaged") && !hasPane("staged")) setInMain(false);
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
  const switchPane = () => {
    const other = activePane === "unstaged" ? "staged" : "unstaged";
    if (!hasPane(other)) return;
    setPane(other);
    setCursor(0);
    setAnchor(null);
  };

  // Clicks in a diff: a line puts the cursor on it (shift or a drag selects from where it was).
  const pickLine = (p: Pane, i: number, how: "down" | "shift" | "enter") => {
    if (how === "enter" && !dragging.current) return;
    focus();
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

  return {
    single,
    paneFile,
    hasPane,
    activePane,
    file,
    drows,
    cur,
    anchor,
    setAnchor,
    hunkMode,
    setHunkMode,
    active,
    settling,
    chosenRows,
    moveCursor,
    toggleRange,
    jumpHunk,
    switchPane,
    pickLine,
  };
}
