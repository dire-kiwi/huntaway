/**
 * Text as it streams in, drawn plainly: drawing it as Markdown again for each delta would take
 * longer the longer it got. A paragraph each, so a delta changes (and lays out again) only the last
 * one. The message is drawn as Markdown once its final text comes.
 */
export declare const StreamingText: import("react").MemoExoticComponent<({ text, className }: {
    text: string;
    className?: string;
}) => import("react").JSX.Element>;
