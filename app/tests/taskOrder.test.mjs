import assert from "node:assert/strict";
import { test } from "node:test";
import { dropPosition } from "../src/taskOrder.ts";

const t = (id, position) => ({ id, position });
// Sorts as the board does (ties keep the column's order, which is by creation).
const apply = (column, id, { position, moves }) => {
  const at = new Map(moves.map((m) => [m.id, m.position]));
  return [...column.map((x) => ({ ...x, position: at.get(x.id) ?? x.position })), { id, position }]
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => a.position - b.position || a.i - b.i)
    .map((x) => x.id);
};

test("drops between, before and after tasks with a position in between", () => {
  const column = [t("a", 1), t("b", 3)];
  assert.deepEqual(dropPosition(column, 1), { position: 2, moves: [] });
  assert.deepEqual(dropPosition(column, 0), { position: 0, moves: [] });
  assert.deepEqual(dropPosition(column, 2), { position: 4, moves: [] });
  assert.deepEqual(dropPosition([], 0), { position: 1, moves: [] });
});

test("numbers the column again between tasks of different projects with the same position", () => {
  // A group's column: A1 and B1 both have position 1, A2 has 2. Drop A2 between them.
  const column = [t("A1", 1), t("B1", 1)];
  const drop = dropPosition(column, 1);
  assert.deepEqual(drop, { position: 2, moves: [t("B1", 3)] });
  assert.deepEqual(apply(column, "A2", drop), ["A1", "A2", "B1"]);
  // Dropped first, ahead of a tie.
  const three = [t("A1", 1), t("B1", 1), t("C1", 1)];
  assert.deepEqual(apply(three, "X", dropPosition(three, 2)), ["A1", "B1", "X", "C1"]);
});
