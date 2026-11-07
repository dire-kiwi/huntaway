import { Fence, X, Zap } from "lucide-react";
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { clipped, polygonHitsRect, reach, type Point, type Rect } from "../../lasso";
import { useSelection } from "../../selection";
import { Button, IconButton } from "../ui";

/** How far a press has to move to be a lasso, in px; less is a click on the card under it. */
const CLICK_REACH = 6;
/** A new point in the path once the pointer has moved this far from the last. */
const STEP = 3;

/** What of `el` shows, inside whatever of its ancestors up to `root` clips it (a column's list scrolls). */
function visibleRect(el: HTMLElement, root: HTMLElement): Rect | null {
  let rect: Rect | null = el.getBoundingClientRect();
  for (let p = el.parentElement; p && rect; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") rect = clipped(rect, p.getBoundingClientRect());
    if (p === root) break;
  }
  return rect;
}

/** The ids of the tasks under `root` (the cards, rows and tiles with a `data-task`) that a lasso drawn as `path` takes in. */
function taskIdsIn(root: HTMLElement, path: Point[]) {
  const ids: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("[data-task]")) {
    const rect = visibleRect(el, root);
    if (rect && polygonHitsRect(path, rect) && el.dataset.task) ids.push(el.dataset.task);
  }
  return ids;
}

/**
 * Ctrl + right-drag on the board draws a lasso that picks the tasks it goes round or over (shown by
 * `useSelectable`, kept in `useSelection`); with Shift too, they're added to those already picked. A
 * Ctrl + right-click without a drag picks or lets go of the task under it. The browser's menu doesn't
 * open for any of them. Returns the path being drawn, for `LassoPath`.
 */
export function useLasso(root: HTMLElement | null): Point[] | null {
  const [path, setPath] = useState<Point[] | null>(null);
  useEffect(() => {
    if (!root) return;
    let drawing: { points: Point[]; base: ReadonlySet<string>; add: boolean; target: Element | null } | null = null;
    let frame = 0;
    const pick = () => {
      frame = 0;
      if (!drawing) return;
      const ids = taskIdsIn(root, drawing.points);
      useSelection.getState().set(drawing.add ? [...drawing.base, ...ids] : ids);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      drawing = null;
      document.body.classList.remove("select-none");
      setPath(null);
    };
    const down = (e: PointerEvent) => {
      if (
        e.button !== 2 ||
        !e.ctrlKey ||
        e.pointerType === "touch" ||
        (e.target as Element).closest("input, textarea, select, [contenteditable], [data-modal]")
      )
        return;
      e.preventDefault();
      drawing = { points: [{ x: e.clientX, y: e.clientY }], base: useSelection.getState().ids, add: e.shiftKey, target: e.target as Element };
      document.body.classList.add("select-none");
      setPath(drawing.points);
    };
    const move = (e: PointerEvent) => {
      if (!drawing) return;
      // Let go outside the window, where nothing told us.
      if (!(e.buttons & 2)) return stop();
      const last = drawing.points[drawing.points.length - 1];
      if (Math.hypot(e.clientX - last.x, e.clientY - last.y) < STEP) return;
      drawing.points = [...drawing.points, { x: e.clientX, y: e.clientY }];
      setPath(drawing.points);
      frame ||= requestAnimationFrame(pick);
    };
    const up = (e: PointerEvent) => {
      if (!drawing || e.button !== 2) return;
      const { points, base, target } = drawing;
      if (reach(points) < CLICK_REACH) {
        // A click: picks the task under it, or lets it go.
        const id = target?.closest<HTMLElement>("[data-task]")?.dataset.task;
        const next = new Set(base);
        if (id && !next.delete(id)) next.add(id);
        useSelection.getState().set(next);
      } else {
        pick();
      }
      stop();
    };
    // The menu opens as the button goes down or comes up, according to the system.
    const menu = (e: MouseEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
    };
    root.addEventListener("pointerdown", down, true);
    root.addEventListener("contextmenu", menu, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", stop);
    return () => {
      root.removeEventListener("pointerdown", down, true);
      root.removeEventListener("contextmenu", menu, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", stop);
      stop();
    };
  }, [root]);
  return path;
}

/** The lasso being drawn, over the whole window. */
export function LassoPath({ path }: { path: Point[] | null }) {
  if (!path || path.length < 2) return null;
  const points = path.map((p) => `${p.x},${p.y}`).join(" ");
  return (
    <svg data-lasso className="pointer-events-none fixed inset-0 z-[60] h-full w-full text-accent" aria-hidden>
      <polygon points={points} fill="currentColor" fillOpacity={0.08} stroke="currentColor" strokeWidth={1.5} strokeDasharray="5 4" strokeLinejoin="round" />
    </svg>
  );
}

/** Clears the selection when Escape is pressed with nothing else to close, and when the board goes. */
export function useClearSelection(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[data-modal]") && !(e.target as Element).closest?.("input, textarea, select, [contenteditable]"))
        useSelection.getState().clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
  useEffect(() => () => useSelection.getState().clear(), []);
}

/** Over the board's foot while tasks are picked: what to do with them. */
export function SelectionBar({
  count,
  onNow,
  onLater,
  onClear,
  onPen,
}: {
  count: number;
  onNow: () => void;
  onLater: () => void;
  onClear: () => void;
  /** Opens the menu that puts them in a pen (HA-285), where they can be. */
  onPen?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  if (!count) return null;
  return (
    <div
      data-selection-bar
      role="toolbar"
      aria-label="Picked tasks"
      className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-line-strong bg-panel px-3 py-2 text-[12.5px] shadow-2xl shadow-black/50 narrow:bottom-4"
    >
      <span className="text-fg">
        {count} task{count === 1 ? "" : "s"} picked
      </span>
      <Button size="sm" variant="primary" onClick={onNow} title="Move the picked tasks to Now">
        <Zap size={13} /> Now
      </Button>
      <Button size="sm" onClick={onLater} title="Move the picked tasks to Later">
        Later
      </Button>
      {onPen && (
        <Button size="sm" onClick={onPen} title="Put the picked tasks in a pen, or take them out">
          <Fence size={13} /> Pen
        </Button>
      )}
      <IconButton className="h-7 w-7" title="Let go of the picked tasks (Esc)" onClick={onClear}>
        <X size={14} />
      </IconButton>
    </div>
  );
}
