import clsx from "clsx";
import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

/** Pieces the analytics charts share. */

type Tip = { x: number; y: number; content: ReactNode } | null;

export function useTip() {
  const [tip, setTip] = useState<Tip>(null);
  const bind = (content: () => ReactNode) => ({
    onMouseMove: (e: ReactMouseEvent) => setTip({ x: e.clientX, y: e.clientY, content: content() }),
    onMouseLeave: () => setTip(null),
  });
  const flip = tip ? tip.x > window.innerWidth - 300 : false;
  const node = tip && (
    <div
      className="pointer-events-none fixed z-50 max-w-xs rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-[12px] shadow-xl shadow-black/40"
      style={{
        left: flip ? tip.x - 12 : tip.x + 14,
        top: tip.y + 14,
        transform: flip ? "translateX(-100%)" : undefined,
      }}
    >
      {tip.content}
    </div>
  );
  return { bind, node };
}

export function Swatch({ color, className }: { color: string; className?: string }) {
  return <span className={clsx("inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]", className)} style={{ background: color }} />;
}
