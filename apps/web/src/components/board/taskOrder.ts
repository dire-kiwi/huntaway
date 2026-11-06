/** A task's place in a board column: columns sort by position, ties by when the task was created. */
export interface Placed {
  id: string;
  position: number;
}

/**
 * Where a task dropped at index `at` of a column (`column`, without the task) goes. Positions are
 * given out per project, so on a group's board tasks next to each other can have the same one;
 * then no position fits between them, and the column is numbered again in its new order.
 * `moves` are the column's other tasks whose positions change.
 */
export function dropPosition(column: Placed[], at: number): { position: number; moves: Placed[] } {
  const prev = column[at - 1];
  const next = column[at];
  let position: number;
  if (!prev && !next) position = 1;
  else if (!next) position = prev.position + 1;
  else if (!prev) position = next.position - 1;
  else position = (prev.position + next.position) / 2;
  if ((!prev || prev.position < position) && (!next || position < next.position)) return { position, moves: [] };
  const moves = column.map((t, i) => ({ id: t.id, position: i < at ? i + 1 : i + 2 })).filter((m, i) => m.position !== column[i].position);
  return { position: at + 1, moves };
}
