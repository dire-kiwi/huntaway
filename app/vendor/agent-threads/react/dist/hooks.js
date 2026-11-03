import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, } from "react";
import { ThreadStore } from "./store.js";
import { lineage } from "./view.js";
/**
 * The store for `source`, connected to it while the component is mounted. A new source (e.g. after
 * a reconnect, with a fresh snapshot) makes a new store.
 */
export function useThreadStore(source) {
    // In state rather than a memo, which React may drop (and the events applied since with it).
    const [kept, keep] = useState(() => new ThreadStore(source));
    let store = kept;
    if (store.source !== source) {
        store = new ThreadStore(source);
        keep(store);
    }
    useEffect(() => store.connect(), [store]);
    return store;
}
/**
 * A thread's state, from `source`: its snapshot with the events since applied by applyEvent. Gaps
 * in seq ask the source for a resync. The component redraws for every event; inside a
 * ThreadProvider, useThreadState picks out just what a component needs.
 */
export function useThread(source) {
    const store = useThreadStore(source);
    return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
const Ctx = createContext(null);
const ConfigCtx = createContext({});
/**
 * Gives the components inside it a thread: its state from `source`, `onCommand` for the commands
 * they send, and the app's renderers (see ThreadConfig). Pass renderers that stay the same (made
 * once, or memoized): new ones redraw every row.
 */
export function ThreadProvider({ source, onCommand, children, tools, toolKinds, renderMarkdown, renderItem }) {
    const store = useThreadStore(source);
    const latest = useRef(onCommand);
    latest.current = onCommand;
    const [focus] = useState(() => new Focus());
    const ctx = useMemo(() => ({ store, command: (c) => latest.current(c), focus }), [store, focus]);
    const config = useMemo(() => ({ tools, toolKinds, renderMarkdown, renderItem }), [tools, toolKinds, renderMarkdown, renderItem]);
    return (_jsx(Ctx.Provider, { value: ctx, children: _jsx(ConfigCtx.Provider, { value: config, children: children }) }));
}
function useCtx() {
    const ctx = useContext(Ctx);
    if (!ctx)
        throw new Error("agent-threads: this component needs to be inside a <ThreadProvider> (or a <Thread> given a source)");
    return ctx;
}
/** Whether there's a ThreadProvider around. */
export const useHasThread = () => useContext(Ctx) !== null;
export function useThreadState(pick) {
    const { store } = useCtx();
    const get = () => (pick ? pick(store.getState()) : store.getState());
    return useSyncExternalStore(store.subscribe, get, get);
}
/** The app's renderers (see ThreadConfig). */
export const useThreadConfig = () => useContext(ConfigCtx);
// ---------- commands ----------
/** Sends a raw command for the thread (its thread_id filled in). */
export function useCommand() {
    const { store, command } = useCtx();
    return useCallback((c) => command({ ...c, thread_id: store.getState().snapshot.thread.id }), [store, command]);
}
/** Sends the agent a message: it starts a turn, or steers the running one. */
export function useSend() {
    const send = useCommand();
    return useCallback((text, options) => send({ type: "send", text, ...(options?.attachments?.length ? { attachments: options.attachments } : {}), client_id: options?.client_id ?? clientId() }), [send]);
}
/** Stops the running turn. */
export function useInterrupt() {
    const send = useCommand();
    return useCallback(() => send({ type: "interrupt" }), [send]);
}
/** Answers an open request (a permission or a question). */
export function useRespond() {
    const send = useCommand();
    return useCallback((request_id, resolution) => send({ type: "respond", request_id, resolution }), [send]);
}
/** Changes the thread's model, effort or permission mode; the ones left out stay as they are. */
export function useSetOptions() {
    const send = useCommand();
    return useCallback((options) => send({ type: "set_options", ...options }), [send]);
}
let sent = 0;
function clientId() {
    const c = globalThis.crypto;
    return c?.randomUUID ? c.randomUUID() : `c${Date.now().toString(36)}${(++sent).toString(36)}`;
}
// ---------- revealing a subagent ----------
/**
 * Asks the thread to show a subagent's row: the rows around it open, and it scrolls into view. The
 * request is pending until that row has shown itself, so rows that mount on the way (as their
 * parents open) still act on it, and ones that mount after it don't.
 */
class Focus {
    target = null;
    handled = 0;
    listeners = new Set();
    subscribe = (l) => {
        this.listeners.add(l);
        return () => void this.listeners.delete(l);
    };
    pending = () => (this.target && this.target.n > this.handled ? this.target : null);
    reveal(id) {
        this.target = { id, n: (this.target?.n ?? 0) + 1 };
        for (const l of this.listeners)
            l();
    }
    handle(n) {
        this.handled = Math.max(this.handled, n);
        for (const l of this.listeners)
            l();
    }
}
/**
 * Shows a subagent's row in the thread (see Focus). One that started before the items loaded (its
 * call is only there for context) has the earlier items loaded back to its start.
 */
export function useReveal() {
    const { focus, store } = useCtx();
    return useCallback((id) => {
        focus.reveal(id);
        if (!store.isLoaded(id))
            void store.loadEarlier({ to: id });
    }, [focus, store]);
}
/** Whether the thread's snapshot is a window with earlier items to load (with the source's loadEarlier). */
export function useHasEarlier() {
    const { store } = useCtx();
    return useThreadState((s) => !!s.snapshot.start) && !!store.source.loadEarlier;
}
/**
 * Loads the earlier items of a thread whose snapshot is a window (see ThreadStore.loadEarlier): a
 * page, or with `to`, back to that item.
 */
export function useLoadEarlier() {
    const { store } = useCtx();
    return useCallback((options) => store.loadEarlier(options), [store]);
}
/**
 * For a row that holds subagent `id`, or can hold the one being revealed: `open` if the subagent
 * being revealed is in it (or is it), `self` if it's the one, and `done` to say it's shown.
 */
export function useRevealed(ids) {
    const { focus, store } = useCtx();
    const target = useSyncExternalStore(focus.subscribe, focus.pending, focus.pending);
    return useMemo(() => {
        if (!target)
            return null;
        const path = lineage(store.getState().view.subagents, target.id);
        if (!ids.some((id) => path.includes(id)))
            return null;
        return { open: true, self: ids.length === 1 && ids[0] === target.id, done: () => focus.handle(target.n) };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target, ids.join(" ")]);
}
