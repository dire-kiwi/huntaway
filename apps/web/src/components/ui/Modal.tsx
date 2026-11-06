import clsx from "clsx";
import { Loader2, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, IconButton, isSubmitShortcut } from "./controls";
import { useAsyncAction } from "./hooks";

/** The fields, buttons and links in `el` that Tab stops at, in order. */
function focusables(el: HTMLElement): HTMLElement[] {
  const sel =
    "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
  return [...el.querySelectorAll<HTMLElement>(sel)].filter((f) => !f.hidden && f.getClientRects().length > 0);
}

/** Whether this dialog is the one on top (a dialog can open another). */
const topModal = (el: HTMLElement) => [...document.querySelectorAll("[data-modal]")].at(-1) === el.parentElement;

const InModal = createContext(false);

/**
 * A dialog's buttons (with the error above them): in a dialog too tall for the window, they stay at its bottom while its
 * fields scroll. Outside a dialog (a form also shown on a page) it's a plain div.
 */
export function ModalFooter({ className, children }: { className?: string; children: ReactNode }) {
  const inModal = useContext(InModal);
  // The negative margins and matching padding keep its place at rest, and cover the dialog's padding when it's stuck.
  return (
    <div className={clsx(inModal && "sticky bottom-0 -mx-4 -mt-3 -mb-4 bg-panel px-4 pt-3 pb-4 narrow:-mx-3 narrow:-mb-3 narrow:px-3 narrow:pb-3", className)}>
      {children}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  onSubmit,
  children,
  width = "max-w-lg",
}: {
  title: ReactNode;
  onClose: () => void;
  /** Runs on Ctrl/Cmd+Enter anywhere while the dialog is open, not just inside its form. */
  onSubmit?: () => void;
  children: ReactNode;
  width?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog opened from this one (a confirmation, say) takes the keys while it's open.
      if (box.current && !topModal(box.current)) return;
      if (e.key === "Escape") onClose();
      else if (onSubmit && isSubmitShortcut(e)) {
        // Stops the textarea newline, or a click on a focused button.
        e.preventDefault();
        onSubmit();
      } else if (e.key === "Tab" && box.current) {
        // Tab goes round the dialog's fields and buttons, not the page behind it.
        const all = focusables(box.current);
        const at = document.activeElement;
        if (!all.length) return;
        const wraps = !box.current.contains(at) || (e.shiftKey ? at === all[0] || at === box.current : at === all[all.length - 1]);
        if (!wraps) return;
        e.preventDefault();
        (e.shiftKey ? all[all.length - 1] : all[0]).focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onSubmit]);
  // Focus goes into the dialog (unless a field in it took it), and back to where it was when it closes: what had it
  // before the dialog's fields were there to take it.
  const [before] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    const el = box.current;
    if (el && !el.contains(document.activeElement)) el.focus();
    return () => {
      if (before?.isConnected && (!document.activeElement || document.activeElement === document.body || el?.contains(document.activeElement))) before.focus();
    };
  }, [before]);
  // A click on the backdrop closes the dialog, if it was pressed there too (not a drag out of a field) and nothing typed in
  // it would be lost: a field marked `data-draft`, or a text field changed since it was first focused. Escape and the
  // close button still close it.
  const pressed = useRef(false);
  const initial = useRef(new WeakMap<Element, string>());
  const hasDraft = () => {
    const el = box.current;
    if (!el) return false;
    if (el.querySelector("[data-draft]")) return true;
    return Array.from(el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input")).some((f) => {
      const was = initial.current.get(f);
      return was !== undefined && f.value !== was;
    });
  };
  return (
    <div
      data-modal
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[10vh] backdrop-blur-[2px] narrow:overflow-y-auto narrow:p-2 narrow:pt-[max(0.5rem,env(safe-area-inset-top))]"
      onMouseDown={(e) => (pressed.current = e.target === e.currentTarget && e.button === 0)}
      onClick={(e) => {
        const close = pressed.current && e.target === e.currentTarget && !hasDraft();
        pressed.current = false;
        if (close) onClose();
      }}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={clsx(
          "flex max-h-full w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl shadow-black/50 outline-none",
          width,
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onFocus={(e) => {
          const f = e.target;
          if ((f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement) && !initial.current.has(f)) initial.current.set(f, f.value);
        }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
          <div id={titleId} className="text-[14px] font-semibold">
            {title}
          </div>
          <IconButton onClick={onClose} title="Close" aria-label="Close" className="narrow:-mr-1">
            <X size={15} />
          </IconButton>
        </div>
        {/* No taller than the window: what doesn't fit scrolls, under the title. */}
        <div className="min-h-0 overflow-y-auto">
          <div className="p-4 narrow:p-3">
            <InModal.Provider value={true}>{children}</InModal.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A red box with an error in it. */
export function ErrorBox({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300", className)}>{children}</div>;
}

export type ConfirmProps = {
  title: ReactNode;
  /** What it does; fields (toggles, say) can go in it too. */
  body: ReactNode;
  /** The confirm button's label. */
  action: ReactNode;
  /** A red confirm button, for something that deletes or can't be undone. */
  danger?: boolean;
  /** Runs on confirm: the dialog closes once it resolves, and shows the error it rejects with. */
  onConfirm: () => Promise<unknown> | unknown;
  width?: string;
};

/** Asks before doing something: Cancel, or `action`, which runs `onConfirm` with its button disabled meanwhile. */
export function ConfirmModal({ title, body, action, danger, onConfirm, onClose, width = "max-w-md" }: ConfirmProps & { onClose: () => void }) {
  const { busy, error, run } = useAsyncAction();
  const confirm = () => {
    void run(onConfirm).then((ok) => ok && onClose());
  };
  return (
    <Modal title={title} onClose={onClose} onSubmit={confirm} width={width}>
      <div className="space-y-4 text-[13px]">
        <div className="space-y-3 text-muted">{body}</div>
        <ModalFooter className="space-y-3">
          {error && <ErrorBox>{error}</ErrorBox>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" variant={danger ? "danger" : "primary"} disabled={busy} onClick={confirm}>
              {busy && <Loader2 size={13} className="animate-spin" />} {action}
            </Button>
          </div>
        </ModalFooter>
      </div>
    </Modal>
  );
}

/** `ask(…)` opens a `ConfirmModal`; render `dialog` where it goes. */
export function useConfirm() {
  const [asking, setAsking] = useState<ConfirmProps | null>(null);
  const ask = useCallback((props: ConfirmProps) => setAsking(props), []);
  const dialog = asking && <ConfirmModal {...asking} onClose={() => setAsking(null)} />;
  return { ask, dialog };
}
