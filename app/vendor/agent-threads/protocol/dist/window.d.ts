import type { Item, ItemPage, Snapshot, ThreadRequest } from "./generated.js";
/**
 * The window of `state` with its last `limit` items, and what they need from before them: the
 * subagent calls they and the open requests belong to, the open requests' tool calls, and the
 * subagents still running (which may go on adding items to the window), with their own. Without
 * a limit, or with one it's within, it's the state itself. `state` must be whole (not a window).
 */
export declare function snapshotWindow(state: Snapshot, limit?: number): Snapshot;
/**
 * The page of `state`'s items before index `before` (a window's start), at most `limit` of them,
 * with what they need from before them (the subagent calls they belong to) and the requests they
 * have. `state` must be whole.
 */
export declare function itemPage(state: Snapshot, before: number, limit: number): ItemPage;
/**
 * `state` (a window) with `page`, the page before its start, put in front of its items: the
 * context items of both in order (the page's version of one they share), less those the page's own
 * items have, then the page's items, then its own. The page's requests go in front of its own, the
 * page's version of one it has replacing it in place. A page for another thread, or that doesn't
 * end at its start, changes nothing.
 */
export declare function withPage(state: Snapshot, page: ItemPage): Snapshot;
/**
 * Where a request is in the thread's items: the index of its tool call, or else of the last item
 * of its turn; -1 if it has neither. A window or page has the requests whose anchor is in it.
 */
export declare function requestAnchor(items: readonly Item[], request: ThreadRequest): number;
