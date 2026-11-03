import type { FileChange, ThreadRequest, ToolCall as ToolCallItem, ToolKind } from "@dire-kiwi/agent-threads-protocol";
import { type ComponentType } from "react";
import type { ThreadConfig, ToolBodyProps, ToolRenderer } from "../config.js";
import type { ToolGroup as ToolGroupRow } from "../view.js";
/** How the call's drawn: the app's renderer for its name, over the app's for its kind, over the built-in one. */
export declare function toolRenderer(config: ThreadConfig, call: Pick<ToolCallItem, "name" | "kind">): ToolRenderer;
/**
 * What a permission card shows of the call it asks about, under its summary line: the renderer's
 * body, except the built-in ones that only show a result (read, search, web), whose input it shows
 * instead (what's to be read, searched or fetched).
 */
export declare function permissionBody(renderer: ToolRenderer): ComponentType<ToolBodyProps>;
/** A tool call: its summary line, which opens to show its input and result. */
export declare const ToolCall: import("react").MemoExoticComponent<({ call, className }: {
    call: ToolCallItem;
    className?: string;
}) => import("react").JSX.Element>;
/** Where a call's got to, at the end of its row: nothing once it's done. */
export declare function ToolStatus({ call, request }: {
    call: ToolCallItem;
    request?: ThreadRequest;
}): import("react").JSX.Element | null;
/** Tool calls in a row: the latest few, and a button for the rest. */
export declare const ToolGroup: import("react").MemoExoticComponent<({ group, className }: {
    group: ToolGroupRow;
    className?: string;
}) => import("react").JSX.Element>;
/** The call's result: its text (an error's in red), and whether it was cut short. */
export declare function ToolResultView({ call }: ToolBodyProps): import("react").JSX.Element | null;
/** A replacement of `before` with `after`, as Claude's Edit gives it. */
export declare function EditDiff({ before, after }: {
    before: string;
    after: string;
}): import("react").JSX.Element;
/** A unified diff of one file, as Codex gives it. */
export declare function PatchDiff({ change }: {
    change: FileChange;
}): import("react").JSX.Element;
/** The built-in renderers, by kind. */
export declare const builtinToolRenderers: Record<ToolKind, ToolRenderer>;
