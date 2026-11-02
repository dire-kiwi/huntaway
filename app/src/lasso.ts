/** Geometry for the board's lasso: a freehand path drawn with the mouse, and the cards it takes in. */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Whether `p` is inside the polygon whose corners are `poly` (it closes from the last point to the first). */
export function pointInPolygon(p: Point, poly: Point[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const inRect = (p: Point, r: Rect) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Whether the segments a-b and c-d cross. */
function crosses(a: Point, b: Point, c: Point, d: Point) {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Whether a lasso drawn as `poly` takes in a card at `rect`: it encloses the card's centre, or the path
 * goes through the card (a line drawn over the card selects it, as a loop round it does).
 */
export function polygonHitsRect(poly: Point[], rect: Rect) {
  if (!poly.length) return false;
  if (poly.length < 3) return poly.some((p) => inRect(p, rect));
  if (pointInPolygon({ x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }, poly)) return true;
  const corners: Point[] = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ];
  // The path is closed from its last point to its first, which isn't drawn but does enclose.
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    if (inRect(a, rect) || inRect(b, rect)) return true;
    if (corners.some((c, k) => crosses(a, b, c, corners[(k + 1) % 4]))) return true;
  }
  return false;
}

/** How far a path strays from its start: a press that hardly moved is a click, not a lasso. */
export function reach(path: Point[]) {
  const [first] = path;
  return first ? Math.max(0, ...path.map((p) => Math.hypot(p.x - first.x, p.y - first.y))) : 0;
}

/** `rect` cut down to what `clip` shows of it, or null if none of it shows. */
export function clipped(rect: Rect, clip: Rect): Rect | null {
  const r = { left: Math.max(rect.left, clip.left), top: Math.max(rect.top, clip.top), right: Math.min(rect.right, clip.right), bottom: Math.min(rect.bottom, clip.bottom) };
  return r.left < r.right && r.top < r.bottom ? r : null;
}
