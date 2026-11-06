import clsx from "clsx";
import { Menu } from "lucide-react";
import type { ButtonHTMLAttributes, ComponentProps, InputHTMLAttributes, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useDrawer, useNarrow } from "../../narrow";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" }) {
  return (
    <button
      {...props}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap",
        // Taller in the narrow layout, to tap.
        size === "sm" ? "h-7 px-2.5 text-xs narrow:h-9" : "h-8 px-3 text-[13px] narrow:h-10",
        variant === "primary" && "bg-accent-strong text-white hover:bg-accent",
        variant === "secondary" && "bg-raised text-fg border border-line hover:border-line-strong hover:bg-[#22222c]",
        variant === "ghost" && "text-muted hover:text-fg hover:bg-white/5",
        variant === "danger" && "bg-red-500/10 text-red-300 border border-red-500/25 hover:bg-red-500/20",
        className,
      )}
    />
  );
}

export function IconButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={clsx(
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:text-fg hover:bg-white/5 transition-colors disabled:opacity-40 narrow:h-9 narrow:w-9",
        className,
      )}
    />
  );
}

/** Opens the sidebar's drawer, at the start of a page's header in the narrow layout (nothing otherwise). */
export function MenuButton() {
  const narrow = useNarrow();
  if (!narrow) return null;
  return (
    <IconButton className="no-drag -ml-1.5 shrink-0" title="Menu" aria-label="Menu" onClick={() => useDrawer.getState().setOpen(true)}>
      <Menu size={18} />
    </IconButton>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        "h-8 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] text-fg placeholder:text-faint outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/15",
        className,
      )}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      {...props}
      className={clsx(
        "w-full rounded-md border border-line bg-panel px-2.5 py-2 text-[13px] text-fg placeholder:text-faint outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/15",
        className,
      )}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-faint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex items-center gap-2.5 text-[13px] text-fg">
      <span className={clsx("relative h-4.5 w-8 rounded-full transition-colors", checked ? "bg-accent-strong" : "bg-line-strong")}>
        <span className={clsx("absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all", checked ? "left-4" : "left-0.5")} />
      </span>
      {label}
    </button>
  );
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
/** How the submit shortcut is written on this platform. */
export const SUBMIT_KEYS = IS_MAC ? "⌘↵" : "Ctrl+Enter";

/** Ctrl+Enter, or Cmd+Enter on a Mac: submits a dialog or editor. */
export function isSubmitShortcut(e: KeyboardEvent | ReactKeyboardEvent) {
  const composing = "nativeEvent" in e ? e.nativeEvent.isComposing : e.isComposing;
  return e.key === "Enter" && (e.ctrlKey || e.metaKey) && !composing;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-raised px-1 font-mono text-[10px] text-muted">{children}</kbd>;
}
