import { useLayoutEffect, useRef, useState } from "react";
import type { Completion } from "./useCompletion";
import type { EditorText } from "./useEditorText";

export type EditorLayout = ReturnType<typeof useEditorLayout>;

/** The highlighting behind the editor and the completion list, laid out against its text area as it's drawn. */
export function useEditorLayout({ input, completing, description }: EditorText, { listOpen }: Completion) {
  // The highlighting behind the editor, sized to its text area (without a scrollbar) and scrolled with it.
  const mirror = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(0);
  useLayoutEffect(() => {
    const ta = input.current;
    const m = mirror.current;
    if (!ta || !m) return;
    const fit = () => {
      m.style.width = `${ta.clientWidth}px`;
      m.style.height = `${ta.clientHeight}px`;
      m.scrollTop = ta.scrollTop;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(ta);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const ta = input.current;
    const m = mirror.current;
    if (m && ta) m.scrollTop = ta.scrollTop;
  }, [listOpen, completing?.start, description, scrolled]);
  // The completion list is fixed to the window (the dialog's body scrolls, and would clip it): under the caret, or over
  // it when there's more room there, no taller than that room, and moved with the caret as the dialog scrolls.
  useLayoutEffect(() => {
    if (!listOpen) return;
    const place = (rendered = false) => {
      const k = marker.current;
      const ta = input.current;
      const l = list.current;
      if (!k || !ta || !l) return;
      const at = k.getBoundingClientRect();
      const box = ta.getBoundingClientRect();
      const below = window.innerHeight - at.bottom - 10;
      const above = at.top - 10;
      const up = l.scrollHeight > below && above > below;
      l.style.maxHeight = `${Math.max(80, up ? above : below)}px`;
      l.style.top = `${up ? Math.max(8, at.top - 2 - l.offsetHeight) : at.bottom + 2}px`;
      l.style.left = `${Math.max(box.left, Math.min(at.left, box.left + ta.clientWidth - l.offsetWidth))}px`;
      if (!rendered) return;
      // Keeps the highlighted option in view when the list scrolls (not while the wheel scrolls it).
      const lit = l.querySelector<HTMLElement>("[aria-selected=true]");
      if (lit && lit.offsetTop < l.scrollTop) l.scrollTop = lit.offsetTop;
      else if (lit && lit.offsetTop + lit.offsetHeight > l.scrollTop + l.clientHeight) l.scrollTop = lit.offsetTop + lit.offsetHeight - l.clientHeight;
    };
    place(true);
    const move = () => place();
    window.addEventListener("scroll", move, true);
    window.addEventListener("resize", move);
    return () => {
      window.removeEventListener("scroll", move, true);
      window.removeEventListener("resize", move);
    };
  });
  return { mirror, marker, list, setScrolled };
}
