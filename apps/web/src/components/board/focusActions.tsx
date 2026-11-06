import { Zap } from "lucide-react";
import { api, hostSupports, type Task } from "../../api";
import { isNow, NOW_API } from "../../focus";
import { useStore } from "../../store";
import type { MenuItem } from "../ui";

/** The tasks of `tasks` that moving to Now (or Later) would change, on hosts that keep which tasks are in Now. */
export function movable(tasks: Task[], now: boolean) {
  const hosts = useStore.getState().hosts;
  return tasks.filter((t) => t.kind === "task" && isNow(t) !== now && hostSupports(hosts.find((h) => h.id === t.host_id), NOW_API));
}

/**
 * Moves the tasks to Now or Later, showing it at once. The saved task comes back as an event; one that fails to
 * save goes back to how it was (unless it has changed since), and the first error is thrown once all have tried.
 */
export async function moveToFocus(tasks: Task[], now: boolean) {
  const store = useStore.getState;
  const errors: Error[] = [];
  await Promise.all(
    movable(tasks, now).map(async (t) => {
      const shown = { ...t, now_at: now ? new Date().toISOString() : null };
      store().upsertTask(shown);
      try {
        await api.updateTask(t.host_id, t.id, { now });
      } catch (e) {
        errors.push(e as Error);
        const current = store().tasks[t.id];
        if (current?.updated_at === t.updated_at) store().upsertTask(t);
      }
    }),
  );
  if (errors.length) throw errors[0];
}

/** Whether the task's host keeps which tasks are in Now. */
export const canFocus = (t: Task) => t.kind === "task" && hostSupports(useStore.getState().hosts.find((h) => h.id === t.host_id), NOW_API);

/**
 * The menu items that move a task to Now or Later: all the picked tasks if it's one of several, else just it.
 * Nothing for a task whose host doesn't keep them.
 */
export function focusItems(task: Task, picked: Task[], onError: (msg: string) => void, divider = false): MenuItem[] {
  if (!canFocus(task)) return [];
  const among = picked.length > 1 && picked.some((t) => t.id === task.id);
  const targets = among ? picked : [task];
  const move = (now: boolean) => moveToFocus(targets, now).catch((e) => onError((e as Error).message));
  const suffix = among ? ` (${targets.length} picked)` : "";
  return [
    {
      label: (
        <span className="flex items-center gap-2">
          <Zap size={13} /> Move to Now{suffix}
        </span>
      ),
      divider,
      checked: !among && isNow(task),
      onSelect: () => move(true),
    },
    { label: `Move to Later${suffix}`, checked: !among && !isNow(task), onSelect: () => move(false) },
  ];
}
