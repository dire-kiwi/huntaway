import { documentGuide, documentsNamed } from "./documentGuide.ts"
import type { DocumentFile } from "./documentGuide.ts"

// What a task's agent is told about the documents its labels ask for, besides its other work: nothing without labels
// (huntaway's agent/documents.ts labels_prompt). Plan task 2.5; documents are plan task 6.2.

export const labels = (files: ReadonlyArray<DocumentFile>): string => {
  if (files.length === 0) return ""
  const names = files.map(([l]) => l)
  let s =
    `\n\nThis task has the label${names.length === 1 ? "" : "s"} ${names.join(", ")} on the board, so besides its other work you write ${documentsNamed(files)}. ` +
    "They're in the task's own folder, outside any repository (don't commit them), where you can write freely. " +
    `The board shows ${files.length === 1 ? "the file" : "each file"} in a tab of the task as it changes, and keeps a version from each turn.`
  if (names.includes("plan")) {
    s +=
      " The plan comes first: write it before you change anything else, and iterate on it with the user. Don't start on the work until the user " +
      "approves the plan and asks you to; then work from it, and keep it up to date as you go (tick off its steps, and note where you strayed from it and why)."
  }
  for (const [label] of files) s += documentGuide(label, false)
  return s
}
