// Reading what a screen shows, and keeping it current: a read (`load`), live changes made to it while it's shown
// (`update`, from the board's events), and reading it again (`reload`). Changes that come while a read is under way
// are kept and made again to what it reads, so neither loses the other: a message that arrives while a thread's first
// page loads joins that page rather than replacing it. A read of another resource (the deps change) starts from
// nothing, so what's shown is never the previous one's.
import { useCallback, useEffect, useRef, useState } from "react";

export type Update<T> = (prev: T | undefined) => T;

export interface LoadState<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

/** The state of one resource's reads and changes, apart from React (see useLoad). */
export class Snapshot<T> {
  state: LoadState<T> = { loading: true };
  private gen = 0;
  /** The changes made since the read under way started, to make again to what it reads. */
  private pending: Update<T>[] = [];

  /** Starts a read; `fresh` for another resource, which drops what was read before. Returns the read's number. */
  begin(fresh: boolean): number {
    this.pending = [];
    this.state = fresh ? { loading: true } : { ...this.state, loading: true };
    return ++this.gen;
  }

  /** A read's result. Returns whether it was taken (a later read outdates it). */
  resolve(gen: number, data: T): boolean {
    if (gen !== this.gen) return false;
    const next = this.pending.reduce<T>((d, f) => f(d), data);
    this.pending = [];
    this.state = { data: next, loading: false };
    return true;
  }

  fail(gen: number, error: string): boolean {
    if (gen !== this.gen) return false;
    this.pending = [];
    this.state = { ...this.state, error, loading: false };
    return true;
  }

  /** A change to what's shown, also made to what the read under way returns. */
  update(change: T | Update<T>) {
    const f: Update<T> = typeof change === "function" ? (change as Update<T>) : () => change;
    if (this.state.loading) this.pending.push(f);
    // Before the first read is in, a change has nothing to go on: it waits for it.
    if (this.state.data !== undefined || !this.state.loading) this.state = { ...this.state, data: f(this.state.data) };
  }
}

/** A value read with `load`, again on `reload()`, from nothing when `deps` change; `setData` changes it as it's shown. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const snap = useRef<Snapshot<T>>(null);
  snap.current ??= new Snapshot<T>();
  const [, render] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const run = useCallback((fresh: boolean) => {
    const s = snap.current!;
    const g = s.begin(fresh);
    render((n) => n + 1);
    loadRef
      .current()
      .then((data) => s.resolve(g, data) && render((n) => n + 1))
      .catch((e) => s.fail(g, e instanceof Error ? e.message : String(e)) && render((n) => n + 1));
  }, []);
  const reload = useCallback(() => run(false), [run]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => run(true), deps);
  const setData = useCallback((change: T | Update<T>) => {
    snap.current!.update(change);
    render((n) => n + 1);
  }, []);
  return { ...snap.current.state, reload, setData };
}
