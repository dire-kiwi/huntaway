import type { AssistantMessage as AssistantMessageItem, Item, Reasoning as ReasoningItem, UserMessage as UserMessageItem } from "@dire-kiwi/agent-threads-protocol";
import { type Row as RowItem } from "../view.js";
/** The rows of the thread (or, given `parentId`, of that subagent's own thread). */
export declare const MessageList: import("react").MemoExoticComponent<({ parentId, className }: {
    parentId?: string;
    className?: string;
}) => import("react").JSX.Element>;
/** One row: an item, a group of tool calls, or an answered request. */
export declare const MessageRow: import("react").MemoExoticComponent<({ row }: {
    row: RowItem;
}) => import("react").JSX.Element>;
/** The built-in row for an item. */
export declare function ItemView({ item }: {
    item: Item;
}): import("react").JSX.Element | null;
/** A message to the agent: steered ones joined a running turn, queued ones are waiting for the agent to take them in. */
export declare function UserMessage({ item, className }: {
    item: UserMessageItem;
    className?: string;
}): import("react").JSX.Element;
/** The agent's reply: plain text while it streams in, then Markdown. */
export declare function AssistantMessage({ item, className }: {
    item: AssistantMessageItem;
    className?: string;
}): import("react").JSX.Element;
/** The agent's thinking, folded away. */
export declare function Reasoning({ item, className }: {
    item: ReasoningItem;
    className?: string;
}): import("react").JSX.Element;
