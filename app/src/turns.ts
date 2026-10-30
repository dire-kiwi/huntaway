// A task's turns with checkpoints (API 70): what each of its agent's turns changed, and whether the
// task can be rewound to before it.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, hostSupports, type Task, type Turn, type TurnsResult } from "./api";
import { onCheckpoints, useHost } from "./store";

/** Whether a task's host keeps checkpoints of its turns. */
export const hasTurns = (host: Parameters<typeof hostSupports>[0], task: Task) => hostSupports(host, 70) && task.kind === "task" && task.use_worktree;

/** A task's turns, fetched again as they change. Null until loaded, and when `enabled` is false or its host is older. */
export function useTurns(task: Task, enabled = true) {
  const host = useHost(task.host_id);
  const on = enabled && hasTurns(host, task);
  const [data, setData] = useState<TurnsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const [h, id] = [task.host_id, task.id];
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const r = await api.turns(h, id);
      if (n === seq.current) {
        setData((prev) => (JSON.stringify(prev) === JSON.stringify(r) ? prev : r));
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    }
  }, [h, id]);
  useEffect(() => {
    if (on) void load();
  }, [on, load, task.running, task.worktree_state, task.session_id]);
  useEffect(() => (on ? onCheckpoints((host, task) => host === h && task === id && void load()) : undefined), [on, load, h, id]);
  return { data: on ? data : null, error: on ? error : null, reload: load };
}

/** A turn's label: its number, and what it was asked. */
export const turnLabel = (t: Turn) => (t.review_round ? `Fix round ${t.review_round}` : t.text.split("\n")[0] || "(no message)");

/** A turn's changes, short: `3 files +12 −4`. */
export function turnStat(t: Turn): string {
  const s = t.stats;
  if (!s) return t.before_n === null ? "no checkpoint before it" : "";
  if (!s.files) return "no changes";
  return `${s.files} file${s.files === 1 ? "" : "s"} +${s.additions} −${s.deletions}`;
}
