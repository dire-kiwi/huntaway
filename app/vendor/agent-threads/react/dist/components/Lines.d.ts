import type { Compaction, Notice as NoticeItem, TurnResult as TurnResultItem, Usage } from "@dire-kiwi/agent-threads-protocol";
/** The harness compacted its context: how big it was, and the summary it goes on from (which opens). */
export declare const CompactionLine: import("react").MemoExoticComponent<({ item, className }: {
    item: Compaction;
    className?: string;
}) => import("react").JSX.Element>;
/** What a turn's usage comes to, e.g. "1.2k in · 300 out · $0.003". */
export declare function usageText(usage: Usage): string;
/** How a turn ended: done, interrupted or failed, how long it took and what it used. */
export declare const TurnResult: import("react").MemoExoticComponent<({ item, className }: {
    item: TurnResultItem;
    className?: string;
}) => import("react").JSX.Element>;
/** Something to tell the user that isn't the agent talking; its detail opens. */
export declare const Notice: import("react").MemoExoticComponent<({ item, className }: {
    item: NoticeItem;
    className?: string;
}) => import("react").JSX.Element>;
