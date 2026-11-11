// What a pen's thread is told of its pen as it is when the run starts, for the end of its instructions (huntaway's
// agent/pens.ts pen_brief). Plan task 2.5.

export interface PenBriefTask {
  /** E.g. `WEB-12`. */
  readonly key: string
  readonly status: string
  readonly running: boolean
  /** Its project's name, `another project` for one not the profile's, or `no project`. */
  readonly project: string
  readonly title: string
}

/** The pen, or null once it is deleted. */
export const penBrief = (
  pen: { readonly name: string; readonly id: string; readonly active: boolean; readonly tasks: ReadonlyArray<PenBriefTask> } | null,
): string => {
  if (pen === null) return "\n\nYour pen has been deleted: tell the user, and don't make tasks in a pen for it."
  const tasks = pen.tasks
  let out = `\n\nYour pen, as it was when this run started: "${pen.name}" (id ${pen.id})${pen.active ? "" : ", inactive (not a tab on the board)"}, `
  if (tasks.length === 0) return `${out}with no tasks in it yet.`
  out += `with ${tasks.length === 1 ? "this task" : `these ${tasks.length} tasks`} (key, status, project, title):\n`
  for (const t of tasks) out += `- ${t.key} [${t.status}${t.running ? ", running" : ""}] (${t.project}) ${t.title}\n`
  return out.trimEnd()
}
