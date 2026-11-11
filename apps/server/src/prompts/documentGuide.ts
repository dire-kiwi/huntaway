import type { DocumentLabel } from "@huntaway/contracts"
import { artifact } from "./artifact.ts"
import { diagram } from "./diagram.ts"
import { planFeedback } from "./planFeedback.ts"
import { planFormat } from "./planFormat.ts"

// How to make the document for a label, and how the documents are named to the agent (huntaway's agent/documents.ts
// `guide` and `what`). Plan task 2.5; documents are plan task 6.2.

/** A document a task's agent writes: its label, and the file it writes it to. */
export type DocumentFile = readonly [label: DocumentLabel, file: string]

/** The documents, for the agent: "a plan (HTML) to /…/plan.html and …". */
export const documentsNamed = (files: ReadonlyArray<DocumentFile>): string => {
  const each = files.map(([label, file]) => {
    const w = label === "plan" ? "a plan (HTML)" : label === "artifact" ? "an artifact (an HTML page)" : "a Mermaid diagram"
    return `${w} to ${file}`
  })
  if (each.length === 0) return ""
  if (each.length === 1) return each[0] ?? ""
  return `${each.slice(0, -1).join("; ")} and ${each[each.length - 1] ?? ""}`
}

/**
 * How to make the document for a label. `only`: in a task that makes only documents (whose plan is broken into tasks
 * rather than carried out in the task).
 */
export const documentGuide = (label: DocumentLabel, only: boolean): string => {
  if (label === "plan") {
    const then = only
      ? "When the user approves the plan and asks you to, break it into tasks with `create_task`: they're recorded as this task's, and the board shows how many are done."
      : "When the user approves the plan, do what they ask with it: carry it out in this task, or break it into tasks with `create_task` (they're recorded as this task's, and the board shows how many are done)."
    return `\n\nThe plan is HTML that the user reads and iterates on with you. ${planFeedback} ${then}\n\n${planFormat}`
  }
  if (label === "artifact") return `\n\n${artifact}`
  return `\n\n${diagram}`
}
