import type { Item, ThreadRequest, ToolCall } from "@dire-kiwi/agent-threads-protocol";
export type SubagentStatus = "running" | "completed" | "failed" | "stopped";
/** A subagent: a tool call of kind `subagent`, and the items it made. */
export interface SubagentInfo {
    /** Its call's id, which its items have as their `parent_id`. */
    id: string;
    call: ToolCall;
    /** What it did: the items whose parent_id is its id. */
    items: readonly Item[];
    status: SubagentStatus;
    /**
     * It runs in the background: its call returned as soon as it started, and it carries on after
     * (so it can be running while its call has completed, and after its turn).
     */
    background: boolean;
    /** How many tools it has called. */
    toolUses: number;
    /** One of its requests (a permission or question) is open. */
    waiting: boolean;
    /** The subagent that started this one, for nested subagents. */
    parent?: string;
}
export interface ThreadView {
    /** The items of each list, in order, by parent_id: "" for the main thread, a subagent's id for its own. */
    children: ReadonlyMap<string, readonly Item[]>;
    /** The thread's subagents, in the order they started, by id. */
    subagents: ReadonlyMap<string, SubagentInfo>;
    /** The open requests for tool calls, by the call's id. */
    requestsByCall: ReadonlyMap<string, ThreadRequest>;
    /** The resolved requests, oldest first, by the list they're drawn in: their parent_id, "" for the main thread's. */
    answered: ReadonlyMap<string, readonly ThreadRequest[]>;
}
export declare const NO_ITEMS: readonly Item[];
/** The view of `items` and `requests`, keeping what's unchanged from `prev` (the view of an earlier state). */
export declare function buildView(items: readonly Item[], requests: readonly ThreadRequest[], prev?: ThreadView): ThreadView;
/** A subagent and the subagents that started it, innermost first. */
export declare function lineage(subagents: ReadonlyMap<string, SubagentInfo>, id: string): string[];
/**
 * Tool calls in a row, shown together. Keyed by its first call, or by the key of the group it was
 * before (when earlier calls are put in front of it, say), so its row stays the same row.
 */
export interface ToolGroup {
    type: "tool_group";
    key: string;
    calls: readonly ToolCall[];
}
/** A resolved request, drawn where it was asked (see groupRows). */
export interface RequestRow {
    type: "request";
    request: ThreadRequest;
}
/** One row of a list: an item, a group of tool calls, or an answered request. */
export type Row = Item | ToolGroup | RequestRow;
export declare const rowKey: (row: Row) => string;
/**
 * The rows to draw for a list of items: tool calls in a row become a group (except those `alone`
 * says to show by themselves), and assistant messages and reasoning with no text yet are left out.
 * `answered` (the list's resolved requests) are drawn where they were asked: a permission just
 * before its tool call, a question in place of its call (the card has the answers), one without a
 * call in the list after the last item of its turn, and one with neither at the end. Rows
 * unchanged from `prev` (the rows of an earlier version of the list) are its, and so is the list
 * if they all are; a group keeps the key it had in `prev`.
 */
export declare function groupRows(items: readonly Item[], prev?: readonly Row[], alone?: (call: ToolCall) => boolean, answered?: readonly ThreadRequest[]): readonly Row[];
