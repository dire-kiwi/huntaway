import type { ToolCall } from "@dire-kiwi/agent-threads-protocol";
import { type SubagentStatus } from "../view.js";
/** What kind of subagent it is, e.g. "Explore"; "Skill" for a skill's forked one, "Subagent" for a general one. */
export declare function subagentKind(call: ToolCall): string;
/** Its title: its description, or the first line of its prompt. */
export declare function subagentTitle(call: ToolCall): string;
/**
 * The subagent's report, from its call's result: Claude frames a subagent's report with notes for
 * the agent (its lines indented under "The report follows:"), which this takes off.
 */
export declare function reportText(content: string): string;
/** Where a subagent's got to: working (and on what), waiting on the user, done, failed or stopped. */
export declare function SubagentStatusBadge({ status, waiting, activity, className }: {
    status: SubagentStatus;
    waiting?: boolean;
    activity?: string;
    className?: string;
}): import("react").JSX.Element;
/** A subagent's row, which opens to show what it did. */
export declare const Subagent: import("react").MemoExoticComponent<({ call, className }: {
    call: ToolCall;
    className?: string;
}) => import("react").JSX.Element>;
