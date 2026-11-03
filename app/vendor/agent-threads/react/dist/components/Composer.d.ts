import { type ReactNode } from "react";
/** `typed` once `sent` has gone: what was typed after it while it was sending, or all of it if what was sent was changed. */
export declare const afterSent: (typed: string, sent: string) => string;
export interface ComposerProps {
    placeholder?: string;
    className?: string;
    /** Shown at the start of the composer's toolbar, e.g. a model or permission mode picker. */
    children?: ReactNode;
    /** Whether Enter sends (and Shift+Enter starts a new line). Ctrl/Cmd+Enter always sends. Default true. */
    enterSends?: boolean;
    autoFocus?: boolean;
}
export declare function Composer({ placeholder, className, children, enterSends, autoFocus }: ComposerProps): import("react").JSX.Element;
