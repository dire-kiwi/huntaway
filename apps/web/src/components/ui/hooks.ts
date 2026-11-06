import { useCallback, useEffect, useRef, useState } from "react";

/** An error's message, for showing. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Runs an action that calls the API (a button's), keeping whether it's running and what it failed with: show `error`
 * where the action is, and disable its button while `busy`. `run` does nothing while it's already running (a
 * double-click), and resolves to whether the action succeeded.
 */
export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  // Gone once the action navigates away or closes what showed it.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async (fn: () => Promise<unknown> | unknown) => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      if (mounted.current) setError(errorText(e));
      return false;
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

/**
 * A field's draft of `value`: it follows `value` until it's edited (and again once the edit is put back), so a refresh
 * from the server doesn't overwrite what's being typed. With `hold` (while the field is focused, say) it doesn't follow
 * even unedited. `dirty` is whether the draft differs from the value it was edited from.
 */
export function useDraft<T>(value: T, hold = false) {
  const [draft, setDraft] = useState(value);
  const [base, setBase] = useState(value);
  if (!Object.is(value, base) && !hold) {
    setBase(value);
    if (Object.is(draft, base)) setDraft(value);
  }
  return { draft, setDraft, dirty: !Object.is(draft, base) };
}
