import { type ButtonHTMLAttributes, type ReactNode } from "react";
/** The class names that are set, joined. */
export declare const cx: (...names: (string | false | null | undefined)[]) => string;
export declare function CodeBlock({ text, tone, className, tall }: {
    text: string;
    tone?: "error";
    className?: string;
    tall?: boolean;
}): import("react").JSX.Element;
/** A section that opens when its label's clicked. */
export declare function Collapsible({ label, icon, children, className, defaultOpen }: {
    label: ReactNode;
    icon?: ReactNode;
    children: ReactNode;
    className?: string;
    defaultOpen?: boolean;
}): import("react").JSX.Element;
export declare const Chevron: ({ open, size }: {
    open: boolean;
    size?: number;
}) => import("react").JSX.Element;
export declare function Button({ variant, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "danger";
}): import("react").JSX.Element;
/** Markdown, drawn by the app's renderMarkdown if it gave one. */
export declare const Markdown: import("react").MemoExoticComponent<({ text, className }: {
    text: string;
    className?: string;
}) => import("react").JSX.Element>;
export declare const tokens: (n: number) => string;
export declare const seconds: (ms: number) => string;
export declare const cost: (usd: number) => string;
/** `n thing` or `n things`. */
export declare const plural: (n: number, thing: string) => string;
