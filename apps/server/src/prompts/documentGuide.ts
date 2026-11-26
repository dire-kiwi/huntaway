import type { DocumentLabel } from "@huntaway/contracts"
import { artifact } from "./artifact.ts"
import { diagram } from "./diagram.ts"
import { planFeedback } from "./planFeedback.ts"
import { DOCS_SERVER } from "./servers.ts"

// How to make the document for a label, and how the documents are named to the agent (huntaway's agent/documents.ts
// `guide` and `what`). Plan task 2.5; documents are plan task 6.2. HE-122: a label's document is published with the
// docs server, not written to a file for the board, which keeps the documents from before as they were.

/** A document a task's agent makes: its label, and the file the board kept it in before HE-122 (only older tasks have it). */
export type DocumentFile = readonly [label: DocumentLabel, file: string]

const named: { readonly [L in DocumentLabel]: string } = { plan: "a plan", artifact: "an artifact (a designed page)", diagram: "a diagram" }

/** The documents, for the agent: "a plan; an artifact (a designed page) and a diagram". */
export const documentsNamed = (files: ReadonlyArray<DocumentFile>): string => {
  const each = files.map(([label]) => named[label])
  if (each.length === 0) return ""
  if (each.length === 1) return each[0] ?? ""
  return `${each.slice(0, -1).join("; ")} and ${each[each.length - 1] ?? ""}`
}

/** How the documents are published, and what to do with the files older tasks have. */
export const publishGuide = (files: ReadonlyArray<DocumentFile>): string => {
  const one = files.length === 1
  let s =
    `\n\nPublish ${one ? "it" : "each"} as a document with the \`${DOCS_SERVER}\` MCP server's \`publish_document\` tool (its own instructions say how), ` +
    `titled after the task, and give the user the URL it returns. When the user gives feedback, publish a new version of the same document ` +
    "(read its latest pages first, as they may have edited it) and say briefly what changed; `get_feedback` reads their comments and answers. " +
    "Don't write it to a file for the board: the board no longer shows a task's document files."
  for (const [label, file] of files)
    s += ` If ${file} exists, it's this task's ${label} from before documents moved to docs: start from it, but leave the file as it is.`
  return s
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
    return `\n\nThe plan is a document that the user reads and iterates on with you. ${planFeedback} ${then}`
  }
  if (label === "artifact") return `\n\n${artifact}`
  return `\n\n${diagram}`
}
