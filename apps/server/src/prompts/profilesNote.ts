// Which other profiles' boards on this host the agent's tools reach, so it looks there (and asks) before adding a
// project that may already be on one (huntaway's agent/runner/prompt.ts profiles_note). Plan task 2.5.

export const profilesNote = (own: string, shared: ReadonlyArray<string>, closed: ReadonlyArray<string>): string => {
  let s = `\n\nYour profile on the board is "${own}".`
  if (shared.length > 0) s += ` Your board tools also reach these profiles' boards: ${shared.join(", ")}.`
  if (closed.length > 0) {
    s +=
      ` These profiles' boards don't let your agents in, so their projects aren't listed: ${closed.join(", ")}. If the user mentions a ` +
      `project you can't find, it may be on one of them: ask the user rather than creating it.`
  }
  return s
}
