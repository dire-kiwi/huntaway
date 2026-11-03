import type { Snapshot, Thread, ThreadEvent, ThreadRequest } from "./generated.js";
/** A thread's state before any of its events. */
export declare function initialState(thread: Thread): Snapshot;
/**
 * The state after `event`. Events for another thread, and saved events the state already has
 * (seq at or below state.seq, e.g. replayed after a reconnect), change nothing.
 */
export declare function applyEvent(state: Snapshot, event: ThreadEvent): Snapshot;
/** The requests that are open: those not resolved yet. */
export declare function openRequests(state: Pick<Snapshot, "requests">): ThreadRequest[];
/** The state after each of `events` in turn. */
export declare function applyEvents(state: Snapshot, events: Iterable<ThreadEvent>): Snapshot;
/**
 * Whether `event` shows that saved events before it were missed: it's saved, and its seq is more
 * than one past the state's. A client that sees one should catch up from state.seq, or take a
 * fresh snapshot, rather than apply it.
 */
export declare function isGap(state: Snapshot, event: ThreadEvent): boolean;
