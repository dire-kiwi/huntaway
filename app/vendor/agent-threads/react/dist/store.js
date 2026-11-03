// A thread's state on the client: the snapshot it started from with the events since applied by
// applyEvent, what's being streamed, and the view the components draw from. It catches up when
// events go missing, by asking the source for a resync.
import { applyEvent, withPage } from "@dire-kiwi/agent-threads-protocol";
import { buildView } from "./view.js";
const NO_IDS = new Set();
/**
 * A thread's state, kept up to date from its source once `connect`ed, for React (or anything) to
 * subscribe to. Each change makes a new state, keeping the parts it didn't change.
 */
export class ThreadStore {
    source;
    state;
    listeners = new Set();
    /** Saved events that came after a gap, by seq, until the events before them do. */
    held = new Map();
    /** Counts resyncs, so one that's been overtaken (by a newer one, or the store disconnecting) is ignored. */
    attempt = 0;
    /**
     * The resync under way: "answer" while its promise is awaited, "events" while the source sends
     * the held events' missing ones itself, "none" when there's none (it's done, or it failed).
     */
    asked = "none";
    connected = false;
    /** The page of earlier items being loaded, if one is: it resolves false if it was given up (see page). */
    paging = null;
    /** The saved events applied while a page loads, to apply to its items too (see loadEarlier). */
    recorded = null;
    /**
     * Counts what makes a page on its way stale: the snapshots a resync has put in place of the
     * state, and the items.removed applied (which move the window's start, by which a page is placed).
     */
    snapshots = 0;
    /**
     * Pages from a later state than the store's, waiting for it to get there: told true once it has,
     * false if the store disconnects first, or why not if the resync asked for their events didn't bring them.
     */
    waiting = [];
    constructor(source) {
        this.source = source;
        const snapshot = source.snapshot;
        this.state = {
            snapshot,
            streaming: NO_IDS,
            resyncing: false,
            view: buildView(snapshot.items, snapshot.requests),
            loadingEarlier: false,
            earlierError: null,
        };
    }
    getState = () => this.state;
    subscribe = (listener) => {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    };
    /** Starts taking the source's events. Returns how to stop. */
    connect() {
        this.connected = true;
        const off = this.source.subscribe((event) => this.receive(event));
        // Events may have been sent while it wasn't listening: after the snapshot was taken and before
        // this subscription, or while it was disconnected (React hid the thread, or ran the effect
        // again), when a resync under way was dropped too. Ask from where the state is now (after any
        // the subscription replayed).
        if (this.connected && this.source.resync)
            this.gap();
        return () => {
            this.connected = false;
            this.attempt++;
            this.asked = "none";
            this.unreached(false);
            off();
        };
    }
    /** Whether the snapshot is a window with items before it to load (with the source's loadEarlier). */
    hasEarlier() {
        return !!this.state.snapshot.start && !!this.source.loadEarlier;
    }
    /**
     * Whether item `id` is loaded with everything after it: it's in the window, not one of the items
     * from before it the window has for context (a subagent's call, whose earlier items aren't in).
     */
    isLoaded(id) {
        return isLoaded(this.state.snapshot, id);
    }
    /**
     * Loads the page of items before the window's start (from the source's loadEarlier), and puts it
     * in front; with `to`, pages until that item is loaded with everything after it. Resolves once
     * it's done, or failed (`earlierError` says why). A load under way is joined, not repeated.
     */
    async loadEarlier({ to } = {}) {
        const next = () => {
            if (this.paging)
                return this.paging;
            // It's the load under way before the source is asked, so one that fails straight away (the
            // source throws) is done with by the time it returns, and the next is asked for afresh.
            let done;
            const paging = (this.paging = new Promise((r) => (done = r)));
            let more = true;
            void this.page()
                .then((m) => void (more = m))
                .catch((e) => {
                // It threw after the page came (putting it in, or a listener): it failed, so isn't stuck
                // loading. Unless what threw had started the next load, which is under way.
                if (this.paging !== paging && this.paging)
                    return void console.error("agent-threads: loading earlier items failed", e);
                try {
                    this.pageFailed(e);
                }
                catch (e) {
                    console.error("agent-threads: a listener failed", e);
                }
            })
                .finally(() => {
                if (this.paging === paging)
                    this.paging = null;
                done(more);
            });
            return paging;
        };
        if (to === undefined) {
            if (this.hasEarlier())
                await next();
            return;
        }
        while (this.hasEarlier() && !this.isLoaded(to)) {
            // Given up (the store disconnected while its page waited) or failed: asking again would get
            // the same, so it stops.
            if (!(await next()) || this.state.earlierError)
                return;
        }
    }
    /**
     * Loads the page before the window's start and puts it in, once the state has the events the page
     * has (a page can be from a later state). A resync that brings a fresh snapshot, or an
     * items.removed (which moves the window's start), meanwhile makes the page stale (its items may be older than the snapshot's, and events the
     * snapshot has in weren't applied, so can't be applied to the page): it's left out, and the page
     * before the new snapshot's start is asked for instead. Resolves false if it gave the page up, as
     * the store disconnected before getting to the page's state.
     */
    async page() {
        while (this.hasEarlier()) {
            const before = this.state.snapshot.start;
            const epoch = this.snapshots;
            this.recorded = [];
            this.update({ ...this.state, loadingEarlier: true, earlierError: null });
            let page;
            try {
                page = await this.source.loadEarlier(before);
            }
            catch (e) {
                this.pageFailed(e);
                return true;
            }
            // A page from a later state than the store's waits for the store to get there: an
            // items.removed it already has (taken after a rewind whose event hasn't come yet) would
            // otherwise move the window's start again once it comes, past the page's items.
            if (page.seq > this.state.snapshot.seq) {
                const reached = await this.reach(page.seq);
                if (reached !== true) {
                    if (reached) {
                        this.pageFailed(reached);
                        return true;
                    }
                    this.recorded = null;
                    this.paging = null;
                    if (this.state.loadingEarlier)
                        this.update({ ...this.state, loadingEarlier: false });
                    return false;
                }
            }
            const recorded = this.recorded;
            this.recorded = null;
            if (epoch !== this.snapshots)
                continue;
            this.paging = null;
            const s = this.state.snapshot;
            // The page is from when the backend got the request, so it has every event applied before
            // then; events applied since that it doesn't have apply to its items too. Those that would
            // add an item or request it doesn't have are for the window (they're in it already).
            let theirs = { thread: s.thread, items: page.items, requests: page.requests, seq: page.seq };
            for (const e of recorded) {
                if (e.seq <= theirs.seq)
                    continue;
                if (e.type === "item.added" && !theirs.items.some((i) => i.id === e.item.id))
                    continue;
                if (e.type === "request.opened" && !theirs.requests.some((r) => r.id === e.request.id))
                    continue;
                theirs = applyEvent(theirs, e);
            }
            const snapshot = withPage(s, { ...page, items: theirs.items, requests: theirs.requests });
            // A page that doesn't end at the window's start (or is another thread's) is left out. It's a
            // failure, not done, so loading back to an item doesn't ask for the same page forever.
            if (snapshot === s) {
                this.pageFailed(new Error(`the page of items before ${before} doesn't fit the thread's window`));
                return true;
            }
            this.update({
                ...this.state,
                snapshot,
                view: buildView(snapshot.items, snapshot.requests, this.state.view),
                loadingEarlier: false,
            });
            return true;
        }
        this.paging = null;
        if (this.state.loadingEarlier)
            this.update({ ...this.state, loadingEarlier: false });
        return true;
    }
    /** Notes that loading earlier items failed, and why. */
    pageFailed(e) {
        this.recorded = null;
        // Done before it says so, so what that sets off can load the next.
        this.paging = null;
        console.error("agent-threads: loading earlier items failed", e);
        this.update({ ...this.state, loadingEarlier: false, earlierError: e instanceof Error ? e.message : String(e) });
    }
    /** Takes one of the thread's events (as the source's subscription does). */
    receive(event) {
        const s = this.state.snapshot;
        if (event.thread_id !== s.thread.id)
            return;
        if (event.type === "delta") {
            // One from after a saved event that hasn't come: that's missed too. Deltas aren't saved, so
            // a resync can't give them back, and its snapshot may have them in already: they're dropped
            // until it's done, and the item's final text puts it right.
            // One from before the state's seq is stale (the snapshot has it in), and the reducer ignores it.
            if (this.state.resyncing || event.seq < s.seq)
                return;
            if (event.seq > s.seq && this.source.resync)
                return this.gap();
            return this.update(this.apply(this.state, event));
        }
        if (event.seq <= s.seq)
            return;
        if (event.seq > s.seq + 1) {
            if (!this.source.resync)
                return this.update(this.apply(this.state, event));
            this.held.set(event.seq, event);
            if (this.asked === "none")
                this.gap();
            return;
        }
        this.update(this.drain(this.apply(this.state, event)));
        // It filled only part of the gap, and the last resync failed: try again.
        if (this.held.size && this.asked === "none" && this.connected)
            this.gap();
    }
    /** Events were missed: ask the source for them. */
    gap() {
        const n = ++this.attempt;
        const from = this.state.snapshot.seq;
        this.asked = "events";
        if (!this.state.resyncing)
            this.update({ ...this.state, resyncing: true });
        let result;
        try {
            result = this.source.resync?.(from);
        }
        catch (e) {
            return this.failed(n, e);
        }
        if (n !== this.attempt)
            return;
        if (!result) {
            // Nothing back: the source sends the missing events itself, and draining the held ones ends
            // it. With none held, there's nothing to wait for.
            if (!this.held.size)
                this.update(this.drain(this.state));
            return;
        }
        this.asked = "answer";
        result.then((r) => n === this.attempt && this.caughtUp(r ?? undefined), (e) => this.failed(n, e));
    }
    caughtUp(r) {
        this.asked = "none";
        const before = this.state.snapshot.seq;
        let next = this.state;
        if (Array.isArray(r)) {
            for (const event of r)
                if (event.type !== "delta" && event.thread_id === next.snapshot.thread.id && event.seq > before)
                    this.held.set(event.seq, event);
        }
        else if (r && r.thread.id === next.snapshot.thread.id && r.seq >= next.snapshot.seq) {
            // A page on its way is from before it: it's asked for again (see page).
            this.snapshots++;
            next = { ...next, snapshot: r, streaming: NO_IDS, view: buildView(r.items, r.requests, next.view) };
        }
        next = this.drain(next);
        if (next.resyncing && next.snapshot.seq === before) {
            // It didn't bring anything new: rather than wait for ever, go on from the next event held.
            console.warn(`agent-threads: resync from seq ${before} brought nothing new; applying the events after the gap anyway`);
            next = this.drain(next, true);
        }
        this.update(next);
        if (next.resyncing && this.connected)
            this.gap();
        // A page waiting for events this resync was asked for after (see reach) won't get them.
        else
            this.unreached(new Error(`the thread's events up to the page's seq didn't come (resyncing from seq ${before} got to ${next.snapshot.seq})`));
    }
    failed(n, e) {
        if (n !== this.attempt)
            return;
        console.error("agent-threads: resync failed", e);
        // The next saved event to come tries again.
        this.asked = "none";
        this.update(this.drain(this.state));
        this.unreached(e instanceof Error ? e : new Error(String(e)));
    }
    /** `state` with the held events that follow on from it applied; with `force`, past any gap. */
    drain(state, force = false) {
        for (const seq of [...this.held.keys()])
            if (seq <= state.snapshot.seq)
                this.held.delete(seq);
        while (this.held.size) {
            let next = this.held.get(state.snapshot.seq + 1);
            if (!next && force)
                next = this.held.get(Math.min(...this.held.keys()));
            if (!next)
                break;
            this.held.delete(next.seq);
            state = this.apply(state, next);
        }
        if (!this.held.size && this.asked === "events")
            this.asked = "none";
        const resyncing = this.asked === "answer" || this.held.size > 0;
        return resyncing === state.resyncing ? state : { ...state, resyncing };
    }
    /** `state` with `event` applied: the snapshot, what's streaming, and the view. */
    apply(state, event) {
        const snapshot = applyEvent(state.snapshot, event);
        if (event.type === "items.removed" && snapshot !== state.snapshot)
            this.snapshots++;
        if (this.recorded && event.type !== "delta" && snapshot.seq !== state.snapshot.seq)
            this.recorded.push(event);
        const streaming = streamingAfter(state.streaming, event, snapshot);
        if (snapshot === state.snapshot && streaming === state.streaming)
            return state;
        const view = snapshot.items === state.snapshot.items && snapshot.requests === state.snapshot.requests
            ? state.view
            : buildView(snapshot.items, snapshot.requests, state.view);
        return { ...state, snapshot, streaming, view };
    }
    update(next) {
        if (next === this.state)
            return;
        this.state = next;
        if (this.waiting.length) {
            const seq = next.snapshot.seq;
            for (const w of this.waiting.filter((w) => w.seq <= seq))
                w.done(true);
            this.waiting = this.waiting.filter((w) => w.seq > seq);
        }
        for (const l of this.listeners)
            l();
    }
    /**
     * Resolves true once the state has the events up to `seq`; false if the store disconnects first;
     * or why not, if the resync it asks for doesn't bring them. The events are on their way, or were
     * missed (a gap the store had no saved event after to notice): it asks the source for them
     * (taking over a resync under way, which may have been asked before they were saved). A source
     * without resync can only send them.
     */
    reach(seq) {
        if (this.state.snapshot.seq >= seq)
            return Promise.resolve(true);
        if (!this.connected)
            return Promise.resolve(false);
        const reached = new Promise((done) => this.waiting.push({ seq, done }));
        if (this.source.resync)
            this.gap();
        return reached;
    }
    /** Tells the pages waiting for a state the store hasn't got to that it won't (see reach). */
    unreached(why) {
        for (const w of this.waiting.splice(0))
            w.done(why);
    }
}
/**
 * Whether item `id` is in `snapshot` with everything after it: it's in its window, not one of the
 * items from before it the window has for context (a subagent's call, whose earlier items aren't in).
 */
export function isLoaded(snapshot, id) {
    const ctx = snapshot.start ? (snapshot.context?.length ?? 0) : 0;
    for (let i = snapshot.items.length - 1; i >= 0; i--)
        if (snapshot.items[i].id === id)
            return i >= ctx;
    return false;
}
/** What's streaming after `event`: a delta's item is, until an event gives it its final text. */
function streamingAfter(streaming, event, snapshot) {
    switch (event.type) {
        case "delta":
            if (streaming.has(event.item_id) || !snapshot.items.some((i) => i.id === event.item_id))
                return streaming;
            return new Set(streaming).add(event.item_id);
        case "item.updated":
            return "text" in event.patch ? without(streaming, event.item_id) : streaming;
        case "item.added":
            return without(streaming, event.item.id);
        case "items.removed":
            return event.item_ids.reduce(without, streaming);
        case "turn.completed":
            return streaming.size ? NO_IDS : streaming;
        default:
            return streaming;
    }
}
function without(set, id) {
    if (!set.has(id))
        return set;
    const next = new Set(set);
    next.delete(id);
    return next;
}
