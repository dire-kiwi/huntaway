import type { PermissionRequest, PlanRequest, QuestionRequest, ThreadRequest } from "@dire-kiwi/agent-threads-protocol";
/** The thread's open requests, oldest first: all of them, or those from one subagent (`parentId`, "" for the main thread's own). */
export declare const OpenRequests: import("react").MemoExoticComponent<({ parentId, className }: {
    parentId?: string;
    className?: string;
}) => import("react").JSX.Element | null>;
/** A request's card: a permission's, questions' or plan's, open or answered. */
export declare function RequestCard({ request, className }: {
    request: ThreadRequest;
    className?: string;
}): import("react").JSX.Element;
/** A tool call the agent wants to make: allow it (once, or always for this tool) or deny it, with a note for the agent. */
export declare const PermissionCard: import("react").MemoExoticComponent<({ request, className }: {
    request: PermissionRequest;
    className?: string;
}) => import("react").JSX.Element>;
/**
 * The agent's plan: approve it, and the agent starts on it in the mode picked (the thread's own, or
 * the default if that's plan); or keep planning, with feedback for the agent.
 */
export declare const PlanCard: import("react").MemoExoticComponent<({ request, className }: {
    request: PlanRequest;
    className?: string;
}) => import("react").JSX.Element>;
/**
 * The agent's questions, each with its options to pick from (one, or several with multi_select),
 * and a typed answer where it takes one. Keys 1–9 pick in the question that's current; picking the
 * one answer of a question moves on to the next, and answers a lone question outright.
 */
export declare const QuestionCard: import("react").MemoExoticComponent<({ request, className }: {
    request: QuestionRequest;
    className?: string;
}) => import("react").JSX.Element>;
