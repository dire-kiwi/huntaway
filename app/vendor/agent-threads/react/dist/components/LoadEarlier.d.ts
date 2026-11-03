/**
 * "Load earlier messages", while there are any: a page of them, or with `to`, those back to that
 * item (a subagent's call, in its own thread). Nothing once they're all in.
 */
export declare function LoadEarlier({ to, className }: {
    to?: string;
    className?: string;
}): import("react").JSX.Element | null;
