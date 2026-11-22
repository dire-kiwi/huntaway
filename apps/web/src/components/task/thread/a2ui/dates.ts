// What a DateTimeInput of an interactive reply (HE-77, catalog.tsx) shows in its input.

/**
 * A date, time or date-time (RFC 3339 from the agent, or what the input itself wrote) as an input of `type` takes it:
 * `YYYY-MM-DD`, `HH:MM` or `YYYY-MM-DDTHH:MM`. A time is the part after a `T` when there's one, else the value itself.
 */
export function forInput(type: "date" | "time" | "datetime-local", value: string): string {
  const t = value.indexOf("T")
  if (type === "time") return (t === -1 ? value : value.slice(t + 1)).slice(0, 5)
  if (type === "date") return value.slice(0, 10)
  return t === -1 ? (value === "" ? "" : `${value.slice(0, 10)}T00:00`) : value.slice(0, 16)
}
