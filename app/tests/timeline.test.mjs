import assert from "node:assert/strict";
import { test } from "node:test";
import { ticks } from "../src/timeline.ts";

const at = (h, m) => new Date(2026, 9, 31, h, m).getTime();
const HOUR = 3600_000;

// HA-5 review: the 1h window ends on whatever minute it is now, and its ticks were only found when that was a multiple of ten.
test("an hour's window has a tick every ten minutes, whatever minute it ends on", () => {
  for (const m of [0, 3, 17, 40, 59]) {
    const to = at(12, m);
    const t = ticks(to - HOUR, to);
    assert.ok(t.length >= 5 && t.length <= 6, `ending at 12:${m}: ${t.length} ticks`);
    for (const x of t) {
      const d = new Date(x.at);
      assert.equal(d.getMinutes() % 10, 0, `ending at 12:${m}: a tick at ${d.toTimeString()}`);
      assert.ok(x.at >= to - HOUR && x.at < to);
    }
  }
});

test("longer windows have ticks on the hour, every few hours, or each day", () => {
  const to = at(12, 17);
  const hours = (span) => ticks(to - span, to).map((x) => new Date(x.at).getHours());
  assert.deepEqual(hours(6 * HOUR), [7, 8, 9, 10, 11, 12]);
  assert.deepEqual(hours(24 * HOUR), [15, 18, 21, 0, 3, 6, 9, 12]);
  const days = ticks(to - 7 * 24 * HOUR, to);
  assert.equal(days.length, 7);
  assert.ok(days.every((x) => x.day && new Date(x.at).getHours() === 0));
});
