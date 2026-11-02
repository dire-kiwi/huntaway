import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { api, type GitStatus, type Task } from "../../../api";
import { errText } from "./model";

/** How often the view checks for changes (an agent may be making them). */
const POLL_MS = 4000;

/**
 * The repository's status, checked when the agent starts or stops, every few seconds while the page is shown (but
 * not while a change is being made, `busy`), and when the window comes back. `tick` is bumped by every check, and
 * `askedTick` by every one but the polls (for what's big to fetch again).
 */
export function useGitStatus(task: Task, busy: RefObject<boolean>) {
  const [h, id] = [task.host_id, task.id];
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [askedTick, setAskedTick] = useState(0);

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
    const poll = setInterval(() => document.visibilityState === "visible" && !busy.current && refresh(true), POLL_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, busy]);
  return { status, loadErr, tick, askedTick, refresh };
}
