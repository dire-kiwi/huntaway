import clsx from "clsx";
import { Bell, BellRing, Star } from "lucide-react";
import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { api, hostSupports, type Task } from "../api";
import { fromLocalInput, isDue, nextDue, REMINDERS_API, reminderLabel, reminderPresets, toLocalInput } from "../reminders";
import { useStore } from "../store";
import { Button, ContextMenu, IconButton, Input, Modal, ModalFooter, Wide, type MenuItem } from "./ui";

/** Whether the task's host can star it and set reminders on it. */
export function useCanMark(task: Task | undefined) {
  return useStore((s) => !!task && hostSupports(s.hosts.find((h) => h.id === task.host_id), REMINDERS_API));
}

type Marks = Pick<Partial<Task>, "starred" | "remind_at" | "reminder">;

/**
 * The star and reminder saves in flight for a task, as of its `updated_at`, with what the server
 * has for the fields they change (`base`): the task as it was before any of them showed theirs.
 */
const inFlight = new Map<string, { updatedAt: string; base: Marks; saves: Marks[] }>();

/**
 * Saves a change to the task's star or reminder, showing it straight away. The saved task comes
 * in as an event: its response could arrive after the event of a later change (an agent's, say),
 * and would undo that.
 *
 * If the save fails, the fields it changed go back to what another save still in flight shows
 * for them, or else to what the server has. Unless the task has changed on the server since
 * (its `updated_at` moved on): then the board already has the server's task, which the failed
 * change never reached, and putting anything back would undo what changed there.
 */
export async function saveMarks(task: Task, patch: Marks) {
  const store = useStore.getState;
  const after: Marks = patch.remind_at === null ? { ...patch, reminder: null } : patch;
  const keys = Object.keys(after) as (keyof Marks)[];
  const latest = store().tasks[task.id] ?? task;
  let entry = inFlight.get(task.id);
  if (entry?.updatedAt !== latest.updated_at) inFlight.set(task.id, (entry = { updatedAt: latest.updated_at, base: {}, saves: [] }));
  for (const k of keys) if (!(k in entry.base)) Object.assign(entry.base, { [k]: latest[k] });
  entry.saves.push(after);
  store().upsertTask({ ...latest, ...after });
  const settle = () => {
    entry.saves.splice(entry.saves.indexOf(after), 1);
    if (!entry.saves.length && inFlight.get(task.id) === entry) inFlight.delete(task.id);
  };
  try {
    await api.updateTask(task.host_id, task.id, patch);
  } catch (e) {
    settle();
    const now = store().tasks[task.id];
    if (now && now.updated_at === entry.updatedAt) {
      // A save still in flight can show null (a cleared reminder), which stands.
      const shown = (k: keyof Marks) => {
        const pending = entry.saves.findLast((x) => k in x);
        return pending ? pending[k] : entry.base[k];
      };
      store().upsertTask({ ...now, ...Object.fromEntries(keys.map((k) => [k, shown(k)])) });
    }
    throw e;
  }
  settle();
  // The server has it now, should a save still in flight fail before its event comes in.
  Object.assign(entry.base, after);
}

/** The time, re-read every 30 seconds while any of `tasks` has a reminder, and as the next one comes round. */
export function useReminderClock(tasks: Task[]) {
  const [now, setNow] = useState(Date.now);
  const any = tasks.some((t) => t.remind_at);
  useEffect(() => {
    if (!any) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [any]);
  const next = nextDue(tasks, now);
  useEffect(() => {
    if (next === null || next > 30_000) return;
    const id = setTimeout(() => setNow(Date.now()), next + 50);
    return () => clearTimeout(id);
  }, [next]);
  return now;
}

/**
 * Menu items that set the task's reminder to one of the quick choices, pick a time, or clear
 * it. `onError` gets a failed save's message.
 */
export function reminderItems(task: Task, onPick: () => void, onError: (msg: string) => void, divider = false): MenuItem[] {
  const save = (patch: Parameters<typeof saveMarks>[1]) => saveMarks(task, patch).catch((e) => onError((e as Error).message));
  return [
    ...reminderPresets(new Date()).map((p, i) => ({ label: `Remind me ${p.label[0].toLowerCase()}${p.label.slice(1)}`, divider: divider && i === 0, onSelect: () => save({ remind_at: p.at.toISOString() }) })),
    { label: "Remind me at…", onSelect: onPick },
    ...(task.remind_at ? [{ label: "Clear reminder", onSelect: () => save({ remind_at: null }) }] : []),
  ];
}

/** The star item for a task's menu. */
export const starItem = (task: Task, onError: (msg: string) => void, divider = false): MenuItem => ({
  label: task.starred ? "Unstar" : "Star",
  divider,
  onSelect: () => saveMarks(task, { starred: !task.starred }).catch((e) => onError((e as Error).message)),
});

/** Sets the task's reminder to a time picked, with a note on what it's for. */
export function ReminderModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const [at, setAt] = useState(() => toLocalInput(task.remind_at ? new Date(task.remind_at) : reminderPresets(new Date())[2].at));
  const [note, setNote] = useState(task.reminder ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const when = fromLocalInput(at);
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!when || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await saveMarks(task, { remind_at: when, reminder: note.trim() || null });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Remind me about “${task.title}”`} onClose={onClose} onSubmit={save} width="max-w-sm">
      <form onSubmit={save} className="space-y-3">
        <Input autoFocus type="datetime-local" aria-label="Remind me at" value={at} onChange={(e) => setAt(e.target.value)} />
        <Input value={note} placeholder="What for (optional)" aria-label="What for" maxLength={500} onChange={(e) => setNote(e.target.value)} />
        <ModalFooter className="space-y-3">
          {err && <div className="text-xs text-danger">{err}</div>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !when}>
              Set reminder
            </Button>
          </div>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** A task's star, which stars or unstars it. */
export function StarButton({ task, onError }: { task: Task; onError: (msg: string) => void }) {
  return (
    <IconButton
      className={clsx("h-7 w-7", task.starred && "text-warning hover:text-warning")}
      title={task.starred ? "Unstar" : "Star (lists it in the sidebar)"}
      aria-pressed={!!task.starred}
      onClick={() => saveMarks(task, { starred: !task.starred }).catch((e) => onError((e as Error).message))}
    >
      <Star size={14} fill={task.starred ? "currentColor" : "none"} />
    </IconButton>
  );
}

/** A task's bell: when its reminder is, and a menu to set or clear it. */
export function ReminderButton({ task, onError }: { task: Task; onError: (msg: string) => void }) {
  const now = useReminderClock([task]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const due = isDue(task, now);
  const open = (e: MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4 });
  };
  return (
    <>
      {task.remind_at ? (
        <Button
          size="sm"
          className={clsx(due && "border-st-attention/40 text-warning")}
          title={`Reminder: ${new Date(task.remind_at).toLocaleString()}${task.reminder ? ` · ${task.reminder}` : ""}`}
          onClick={open}
        >
          {due ? <BellRing size={12} /> : <Bell size={12} />} {reminderLabel(task.remind_at, now)}
        </Button>
      ) : (
        <IconButton className="h-7 w-7" title="Remind me about this later" onClick={open}>
          <Bell size={14} />
        </IconButton>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={task.reminder ?? (task.remind_at ? `Reminder: ${new Date(task.remind_at).toLocaleString()}` : undefined)}
          items={reminderItems(task, () => setPicking(true), onError)}
          onClose={() => setMenu(null)}
        />
      )}
      {picking && <ReminderModal task={task} onClose={() => setPicking(false)} />}
    </>
  );
}

/** A card's or row's star and reminder, if it has them. `compact`, on a card: the reminder's icon, and its time once the card has room. */
export function TaskMarks({ task, compact }: { task: Task; compact?: boolean }) {
  const now = useReminderClock(task.remind_at ? [task] : []);
  return (
    <>
      {task.starred && (
        <span className="flex shrink-0 text-warning" title="Starred">
          <Star size={11} fill="currentColor" aria-label="Starred" />
        </span>
      )}
      {task.remind_at && (
        <span
          className={clsx("flex shrink-0 items-center gap-1 whitespace-nowrap", isDue(task, now) ? "text-warning" : "text-muted")}
          title={`Reminder: ${reminderLabel(task.remind_at, now)}, ${new Date(task.remind_at).toLocaleString()}${task.reminder ? ` · ${task.reminder}` : ""}`}
        >
          {isDue(task, now) ? <BellRing size={11} /> : <Bell size={11} />} {compact ? <Wide>{reminderLabel(task.remind_at, now)}</Wide> : reminderLabel(task.remind_at, now)}
        </span>
      )}
    </>
  );
}
