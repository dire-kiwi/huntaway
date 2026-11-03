import { type ReactNode } from "react";
import { type ThreadProviderProps } from "../hooks.js";
export interface ThreadProps extends Partial<Omit<ThreadProviderProps, "children">> {
    className?: string;
    /** The composer's placeholder. */
    placeholder?: string;
    /** Shown while the thread has no items. */
    empty?: ReactNode;
    /** Whether to show the composer, or a composer of the app's own. Default true. */
    composer?: boolean | ReactNode;
    /** A theme preset; without one it follows the page's (see styles.css). */
    theme?: "light" | "dark";
}
/**
 * A thread, with its composer. Inside a ThreadProvider it draws that one's thread; or give it a
 * `source` and `onCommand` (and any of ThreadConfig) and it makes its own provider.
 */
export declare function Thread({ source, onCommand, tools, toolKinds, renderMarkdown, renderItem, ...props }: ThreadProps): import("react").JSX.Element;
/** Whether the thread's working, waiting on the user, or failed. */
export declare function ThreadStatusLine({ className }: {
    className?: string;
}): import("react").JSX.Element | null;
