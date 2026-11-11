// What a prompt is told of the projects and tasks it names by key (HA-400; huntaway's agent/runner/mentions.ts): a
// note after the prompt with a line for each. Plan task 2.5.

/** A project named by `word`; `board`: the other profile's board it is on, if not the agent's own. */
export const mentionedProject = (word: string, project: { readonly name: string; readonly repo_path: string }, board: string | null): string =>
  `- ${word}: project "${project.name}"${board !== null ? ` on profile ${board}'s board` : ""} (repository ${project.repo_path})`

/** A task named by `word`, in its project if it is in one; `status` as stored (`in_review`). */
export const mentionedTask = (word: string, task: { readonly title: string; readonly status: string }, project: string | null, board: string | null): string =>
  `- ${word}: task "${task.title}"${project !== null ? ` in project "${project}"` : ""}${board !== null ? ` on profile ${board}'s board` : ""} (${task.status.replaceAll("_", " ")})`

/** The note, from its lines; "" with none. */
export const mentionsNote = (lines: ReadonlyArray<string>): string => (lines.length === 0 ? "" : `\n\n[Mentions, from the board:\n${lines.join("\n")}]`)
