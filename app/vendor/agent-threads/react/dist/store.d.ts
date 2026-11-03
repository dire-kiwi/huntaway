import { type ItemPage, type Snapshot, type ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { type ThreadView } from "./view.js";
/**
 * Where a thread's events come from: the app wires it to its own transport (a WebSocket, SSE,
 * Electron IPC...). Keep the same object for as long as it's the same connection: a new one starts
 * again from its snapshot.
 */
export interface ThreadSource {
    /** The state to start from: the backend's snapshot of the thread (or `initialState(thread)`). */
    snapshot: Snapshot;
    /** Calls `listener` with each of the thread's events, deltas included. Returns how to stop. */
    subscribe(listener: (event: ThreadEvent) => void): () => void;
    /**
     * Called when events were missed: a saved event came whose seq is more than one past the
     * state's. Resolve with the events after `seq` or a fresh snapshot (backends offer both), or
     * deliver the missing events through `subscribe` and return nothing. Events that come meanwhile
     * are held, and applied once the gap is filled. It's also called each time the store connects
     * (each mount, twice in StrictMode), for the events sent while it wasn't listening: since the
     * snapshot was taken, or since it last disconnected.
     * Without it, a gap is ignored and the event applied anyway.
     */
    resync?(seq: number): Promise<Snapshot | ThreadEvent[] | void> | void;
    /**
     * For a snapshot that's a window of the thread (the backend's snapshot taken with a limit):
     * resolves with the page of items before index `before` (the backend's itemsBefore, with as many
     * as the app likes to load at a time). Without it, a window's earlier items aren't loaded.
     */
    loadEarlier?(before: number): Promise<ItemPage>;
}
export interface LoadEarlierOptions {
    /** Load pages until this item (a subagent's call, say) and everything after it is in. */
    to?: string;
}
export interface ThreadState {
    /** The thread's state: applying the events so far to the source's snapshot. */
    snapshot: Snapshot;
    /** The assistant messages and reasoning that deltas are streaming into, until their final text comes. */
    streaming: ReadonlySet<string>;
    /** Waiting for missed events: a resync under way, or events held until the ones before them come (see ThreadSource.resync). */
    resyncing: boolean;
    /** The items arranged for drawing (see buildView). */
    view: ThreadView;
    /** Earlier items are being loaded (see ThreadStore.loadEarlier). */
    loadingEarlier: boolean;
    /** Why loading earlier items last failed, until it's tried again. */
    earlierError: string | null;
}
/**
 * A thread's state, kept up to date from its source once `connect`ed, for React (or anything) to
 * subscribe to. Each change makes a new state, keeping the parts it didn't change.
 */
export declare class ThreadStore {
    readonly source: ThreadSource;
    private state;
    private listeners;
    /** Saved events that came after a gap, by seq, until the events before them do. */
    private held;
    /** Counts resyncs, so one that's been overtaken (by a newer one, or the store disconnecting) is ignored. */
    private attempt;
    /**
     * The resync under way: "answer" while its promise is awaited, "events" while the source sends
     * the held events' missing ones itself, "none" when there's none (it's done, or it failed).
     */
    private asked;
    private connected;
    /** The page of earlier items being loaded, if one is: it resolves false if it was given up (see page). */
    private paging;
    /** The saved events applied while a page loads, to apply to its items too (see loadEarlier). */
    private recorded;
    /**
     * Counts what makes a page on its way stale: the snapshots a resync has put in place of the
     * state, and the items.removed applied (which move the window's start, by which a page is placed).
     */
    private snapshots;
    /**
     * Pages from a later state than the store's, waiting for it to get there: told true once it has,
     * false if the store disconnects first, or why not if the resync asked for their events didn't bring them.
     */
    private waiting;
    constructor(source: ThreadSource);
    getState: () => ThreadState;
    subscribe: (listener: () => void) => (() => void);
    /** Starts taking the source's events. Returns how to stop. */
    connect(): () => void;
    /** Whether the snapshot is a window with items before it to load (with the source's loadEarlier). */
    hasEarlier(): boolean;
    /**
     * Whether item `id` is loaded with everything after it: it's in the window, not one of the items
     * from before it the window has for context (a subagent's call, whose earlier items aren't in).
     */
    isLoaded(id: string): boolean;
    /**
     * Loads the page of items before the window's start (from the source's loadEarlier), and puts it
     * in front; with `to`, pages until that item is loaded with everything after it. Resolves once
     * it's done, or failed (`earlierError` says why). A load under way is joined, not repeated.
     */
    loadEarlier({ to }?: LoadEarlierOptions): Promise<void>;
    /**
     * Loads the page before the window's start and puts it in, once the state has the events the page
     * has (a page can be from a later state). A resync that brings a fresh snapshot, or an
     * items.removed (which moves the window's start), meanwhile makes the page stale (its items may be older than the snapshot's, and events the
     * snapshot has in weren't applied, so can't be applied to the page): it's left out, and the page
     * before the new snapshot's start is asked for instead. Resolves false if it gave the page up, as
     * the store disconnected before getting to the page's state.
     */
    private page;
    /** Notes that loading earlier items failed, and why. */
    private pageFailed;
    /** Takes one of the thread's events (as the source's subscription does). */
    receive(event: ThreadEvent): void;
    /** Events were missed: ask the source for them. */
    private gap;
    private caughtUp;
    private failed;
    /** `state` with the held events that follow on from it applied; with `force`, past any gap. */
    private drain;
    /** `state` with `event` applied: the snapshot, what's streaming, and the view. */
    private apply;
    private update;
    /**
     * Resolves true once the state has the events up to `seq`; false if the store disconnects first;
     * or why not, if the resync it asks for doesn't bring them. The events are on their way, or were
     * missed (a gap the store had no saved event after to notice): it asks the source for them
     * (taking over a resync under way, which may have been asked before they were saved). A source
     * without resync can only send them.
     */
    private reach;
    /** Tells the pages waiting for a state the store hasn't got to that it won't (see reach). */
    private unreached;
}
/**
 * Whether item `id` is in `snapshot` with everything after it: it's in its window, not one of the
 * items from before it the window has for context (a subagent's call, whose earlier items aren't in).
 */
export declare function isLoaded(snapshot: Snapshot, id: string): boolean;
