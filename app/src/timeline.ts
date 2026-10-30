// The Timeline view's time axis (see components/TimelineView.tsx), apart for its tests.

/** Where the axis gets a line and a label: every few minutes, hours, a day or a week, on local time. */
export function ticks(from: number, to: number): { at: number; label: string; day: boolean }[] {
  const span = to - from;
  const minutes = span <= 2 * 3600_000 ? 10 : span <= 8 * 3600_000 ? 60 : span <= 26 * 3600_000 ? 180 : span <= 4 * 86400_000 ? 720 : 0;
  const days = minutes ? 0 : span <= 8 * 86400_000 ? 1 : 7;
  const out: { at: number; label: string; day: boolean }[] = [];
  // From the step at or before `from` (a window ends whenever it is now), going on a step at a time up to an hour.
  const step = Math.min(minutes, 60);
  const d = new Date(from);
  d.setSeconds(0, 0);
  if (minutes) d.setMinutes(Math.floor(d.getMinutes() / step) * step);
  else d.setHours(0, 0);
  for (let guard = 0; d.getTime() < to && guard < 500; guard++) {
    const at = d.getTime();
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    const onStep = minutes ? (d.getHours() * 60 + d.getMinutes()) % minutes === 0 : days === 1 || d.getDay() === 1;
    if (at >= from && onStep)
      out.push({
        at,
        day: midnight,
        label: midnight
          ? d.toLocaleDateString([], { weekday: "short", day: "numeric" })
          : d.toLocaleTimeString([], minutes < 60 ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" }),
      });
    if (minutes) d.setMinutes(d.getMinutes() + step);
    else d.setDate(d.getDate() + 1);
  }
  return out;
}
