import clsx from "clsx";
import { ArrowUpDown, Check, ListFilter, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Status } from "../api";
import { EMPTY_QUERY, filterCount, isFiltering, SORTS, TASK_FLAGS, TASK_KINDS, toggled, type BoardQuery, type SortKey, type TaskKind } from "../boardQuery";
import { ContextMenu, StatusIcon } from "./ui";

const BUTTON = "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors narrow:h-8";
const BUTTON_STATE = (active: boolean) => (active ? "border-accent/50 bg-accent/10 text-fg" : "border-line text-muted hover:text-fg");

/** Whether a key press is meant for the page rather than a field being typed in, or a dialog or menu. */
const forPage = (e: KeyboardEvent) =>
  !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target as Element).closest?.("input, textarea, select, [contenteditable]") && !document.querySelector("[data-modal]");

/** The board's search field. "/" anywhere on the page goes to it; Escape clears it, then leaves it. */
export function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || !forPage(e)) return;
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="relative narrow:min-w-0 narrow:flex-1">
      <Search size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" />
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          if (value) onChange("");
          else e.currentTarget.blur();
        }}
        placeholder="Search tasks"
        aria-label="Search tasks"
        title="Search the board's tasks by key, title, description, branch or project (/)"
        className={clsx(
          "h-7 w-36 rounded-md border bg-panel pr-6 pl-7 text-[12.5px] text-fg placeholder:text-faint outline-none transition-[width] focus:w-56 focus:border-accent/60 lg:w-48 narrow:h-8 narrow:w-full narrow:focus:w-full",
          value ? "border-accent/50 lg:w-56" : "border-line",
        )}
      />
      {value && (
        <button
          title="Clear the search"
          onClick={() => onChange("")}
          className="absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-faint hover:text-fg"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export type FilterOption<T> = { id: T; label: string };

/** Closes the popover in `ref` on a press outside it, or Escape (which then goes no further, so an open task panel stays). */
function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ref, open, close]);
}

/** The Filter button and its menu, which stays open while filters are picked. */
export function FilterMenu({
  query,
  onChange,
  statuses,
  kinds,
  projects,
  align = "right",
}: {
  query: BoardQuery;
  onChange: (q: BoardQuery) => void;
  statuses: FilterOption<Status>[];
  kinds: TaskKind[];
  /** Offered with two or more. */
  projects: FilterOption<string>[];
  /** Which edge of the button the menu lines up with. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(() => setOpen(false)).current;
  useDismiss(ref, open, close);
  const count = filterCount(query);
  const item = (key: string, checked: boolean, label: ReactNode, onSelect: () => void) => (
    <button
      key={key}
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] text-fg outline-none hover:bg-white/5 focus:bg-white/5"
    >
      <span className={clsx("flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border", checked ? "border-accent bg-accent/80 text-bg" : "border-line-strong")}>
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      {label}
    </button>
  );
  const heading = (text: string) => <div className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase first:pt-1">{text}</div>;
  return (
    <div ref={ref} className="relative">
      <button
        title="Filter the board's tasks"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={clsx(BUTTON, BUTTON_STATE(count > 0 || open))}
      >
        <ListFilter size={13} /> Filter
        {count > 0 && <span className="rounded bg-accent/25 px-1 text-[11px] text-fg">{count}</span>}
      </button>
      {open && (
        <div
          data-modal
          role="menu"
          className={clsx(align === "right" ? "right-0" : "left-0", "absolute top-full z-50 mt-1 max-h-[70vh] w-60 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-2xl shadow-black/50")}
        >
          {heading("Status")}
          {statuses.map((s) =>
            item(
              `s:${s.id}`,
              query.statuses.includes(s.id),
              <>
                <StatusIcon status={s.id} size={13} /> {s.label}
              </>,
              () => onChange({ ...query, statuses: toggled(query.statuses, s.id) }),
            ),
          )}
          {kinds.length > 1 && (
            <>
              {heading("Type")}
              {TASK_KINDS.filter((k) => kinds.includes(k.id)).map((k) =>
                item(`k:${k.id}`, query.kinds.includes(k.id), k.label, () => onChange({ ...query, kinds: toggled(query.kinds, k.id) })),
              )}
            </>
          )}
          {projects.length > 1 && (
            <>
              {heading("Project")}
              {projects.map((p) => item(`p:${p.id}`, query.projects.includes(p.id), p.label, () => onChange({ ...query, projects: toggled(query.projects, p.id) })))}
            </>
          )}
          {heading("Only")}
          {TASK_FLAGS.map((f) => item(`f:${f.id}`, query.flags.includes(f.id), f.label, () => onChange({ ...query, flags: toggled(query.flags, f.id) })))}
          {count > 0 && (
            <>
              <div role="separator" className="mx-1 my-1 h-px bg-line" />
              <button
                onClick={() => onChange({ ...EMPTY_QUERY, search: query.search })}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] text-muted outline-none hover:bg-white/5 hover:text-fg focus:bg-white/5"
              >
                <X size={13} /> Clear filters
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The Sort button: it names the sort when it isn't the board's own (manual) order. */
export function SortMenu({ sort, onChange }: { sort: SortKey; onChange: (s: SortKey) => void }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  // A press on the button closes the open menu (as one anywhere outside it does), so the click mustn't open it again.
  const wasOpen = useRef(false);
  const label = SORTS.find((s) => s.id === sort)?.label;
  return (
    <>
      <button
        title={sort === "manual" ? "Sort the board's tasks" : `Sorted by ${label?.toLowerCase()}: dragging a task moves it to another column, not within one`}
        onMouseDown={() => (wasOpen.current = !!at)}
        onClick={(e) => {
          if (wasOpen.current) return;
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ x: r.left, y: r.bottom + 4 });
        }}
        className={clsx(BUTTON, BUTTON_STATE(sort !== "manual"))}
      >
        <ArrowUpDown size={13} /> {sort === "manual" ? "Sort" : label}
      </button>
      {at && (
        <ContextMenu
          x={at.x}
          y={at.y}
          title="Sort by"
          items={SORTS.map((s) => ({ label: s.label, checked: s.id === sort, divider: s.id === "activity", onSelect: () => onChange(s.id) }))}
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}

/**
 * Below the header while anything is filtered: how many tasks show, and each filter, to take off one by one.
 * With `tools` (the search, filter and sort controls, on a board too narrow for them in its header), always, with them first.
 */
export function FilterBar({
  query,
  onChange,
  shown,
  total,
  statuses,
  projects,
  tools,
}: {
  query: BoardQuery;
  onChange: (q: BoardQuery) => void;
  tools?: ReactNode;
  shown: number;
  total: number;
  statuses: FilterOption<Status>[];
  projects: FilterOption<string>[];
}) {
  const chip = (key: string, label: ReactNode, remove: () => void) => (
    <span key={key} className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-panel pr-0.5 pl-2 text-[12px] text-fg">
      {label}
      <button title="Remove this filter" onClick={remove} className="flex h-5 w-5 items-center justify-center rounded text-faint hover:text-fg">
        <X size={11} />
      </button>
    </span>
  );
  const named = <T,>(options: FilterOption<T>[], id: T) => options.find((o) => o.id === id)?.label ?? String(id);
  const search = query.search.trim();
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-panel/60 px-5 py-1.5 text-[12px] text-muted narrow:px-3">
      {tools}
      {isFiltering(query) && (
        <>
          <span className={clsx("mr-1", tools && "ml-2")}>
            {shown} of {total} task{total === 1 ? "" : "s"}
          </span>
          {search && !tools && chip("search", <>“{search}”</>, () => onChange({ ...query, search: "" }))}
          {query.statuses.map((s) =>
            chip(
              `s:${s}`,
              <>
                <StatusIcon status={s} size={12} /> {named(statuses, s)}
              </>,
              () => onChange({ ...query, statuses: toggled(query.statuses, s) }),
            ),
          )}
          {query.kinds.map((k) => chip(`k:${k}`, named(TASK_KINDS, k), () => onChange({ ...query, kinds: toggled(query.kinds, k) })))}
          {query.projects.map((p) => chip(`p:${p}`, named(projects, p), () => onChange({ ...query, projects: toggled(query.projects, p) })))}
          {query.flags.map((f) => chip(`f:${f}`, named(TASK_FLAGS, f), () => onChange({ ...query, flags: toggled(query.flags, f) })))}
          <button className="ml-1 text-muted hover:text-fg hover:underline" onClick={() => onChange(EMPTY_QUERY)}>
            Clear all
          </button>
        </>
      )}
    </div>
  );
}
