import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { clipped, pointInPolygon, polygonHitsRect, reach } from "../src/lasso.ts";
import { FOCUSES, inFocus, isFocus, isNow } from "../src/focus.ts";

const square = (l, t, r, b) => [
  { x: l, y: t },
  { x: r, y: t },
  { x: r, y: b },
  { x: l, y: b },
];
const card = { left: 100, top: 100, right: 200, bottom: 140 };

// HA-109: the lasso takes in the cards it goes round, and the ones it goes over.
test("a loop round a card's centre takes it in", () => {
  assert.ok(pointInPolygon({ x: 5, y: 5 }, square(0, 0, 10, 10)));
  assert.ok(!pointInPolygon({ x: 15, y: 5 }, square(0, 0, 10, 10)));
  assert.ok(polygonHitsRect(square(90, 90, 210, 150), card));
  assert.ok(!polygonHitsRect(square(300, 300, 400, 400), card));
});

test("a line drawn over a card takes it in, though it doesn't go round it", () => {
  // Across the card's top-left corner, with the centre outside.
  const across = [
    { x: 80, y: 130 },
    { x: 130, y: 80 },
    { x: 80, y: 80 },
  ];
  assert.ok(!pointInPolygon({ x: 150, y: 120 }, across));
  assert.ok(polygonHitsRect(across, card));
  // A path that crosses the card from one side to the other, with no point in it.
  const through = [
    { x: 150, y: 50 },
    { x: 150, y: 200 },
    { x: 160, y: 200 },
  ];
  assert.ok(polygonHitsRect(through, card));
  // Beside it.
  const beside = [
    { x: 250, y: 50 },
    { x: 250, y: 200 },
    { x: 260, y: 200 },
  ];
  assert.ok(!polygonHitsRect(beside, card));
});

test("a loop that stops short of a card leaves it out, and an empty path takes none", () => {
  assert.ok(!polygonHitsRect(square(0, 0, 99, 99), card));
  assert.ok(!polygonHitsRect([], card));
});

test("a press that hardly moved is a click", () => {
  assert.equal(reach([]), 0);
  assert.ok(reach([{ x: 10, y: 10 }, { x: 12, y: 11 }]) < 6);
  assert.ok(reach([{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 11, y: 10 }]) >= 40);
});

test("a card is only as big as what shows of it", () => {
  assert.deepEqual(clipped(card, { left: 0, top: 0, right: 150, bottom: 120 }), { left: 100, top: 100, right: 150, bottom: 120 });
  assert.equal(clipped(card, { left: 0, top: 0, right: 90, bottom: 500 }), null);
});

test("a task is in Later until it has a time for Now", () => {
  assert.ok(!isNow({}));
  assert.ok(!isNow({ now_at: null }));
  assert.ok(isNow({ now_at: "2026-11-02T00:00:00.000Z" }));
  const [now, later] = [{ now_at: "2026-11-02T00:00:00.000Z" }, { now_at: null }];
  assert.deepEqual([inFocus(now, "now"), inFocus(later, "now")], [true, false]);
  assert.deepEqual([inFocus(now, "later"), inFocus(later, "later")], [false, true]);
  assert.deepEqual([inFocus(now, "all"), inFocus(later, "all")], [true, true]);
  assert.ok(FOCUSES.every((f) => isFocus(f.id)) && !isFocus("soon"));
});
