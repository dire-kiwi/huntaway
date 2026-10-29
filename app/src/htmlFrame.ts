/**
 * What runs in a document's frame (see HtmlFrame in components/Document.tsx), after its HTML: it
 * leaves `inset` pixels at the bottom for what covers it (updated by an iaInset message), reports
 * where it's scrolled to (iaScroll), and after a reload puts it back at `y`. It runs as source, so
 * it can't use anything from outside.
 */
function keepPlace(y: number, inset: number) {
  const pad = (b: number) => (document.documentElement.style.paddingBottom = b ? `${b}px` : "");
  pad(inset);
  addEventListener("message", (e) => {
    if (e.source === parent && typeof e.data?.iaInset === "number") pad(e.data.iaInset);
  });
  // Put back on load, whenever that is (images and <ia-html> frames' scripts can hold it up). Layout can still
  // move after it (an <ia-html> frame reports its height), so it's put back again as the page changes size,
  // until the reader scrolls or 3s have passed.
  let hold = false;
  const stop = () => (hold = false);
  for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) addEventListener(type, stop, { capture: true, passive: true });
  addEventListener("load", () => {
    if (!y) return;
    scrollTo(0, y);
    hold = true;
    setTimeout(stop, 3000);
    new ResizeObserver(() => hold && scrollTo(0, y)).observe(document.documentElement);
  });
  addEventListener("scroll", () => parent.postMessage({ iaScroll: scrollY }, "*"), { passive: true });
}

/** A document's HTML with the script that keeps its place (`keepPlace`). */
export const frameDoc = (html: string, y: number, inset: number) => `${html}\n<script>(${keepPlace})(${y},${inset})</script>`;
