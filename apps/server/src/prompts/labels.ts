import { documentGuide, documentsNamed, publishGuide } from "./documentGuide.ts"
import type { DocumentFile } from "./documentGuide.ts"

// What a task's agent is told about the documents its labels ask for, besides its other work: nothing without labels
// (huntaway's agent/documents.ts labels_prompt). Plan task 2.5; documents are plan task 6.2. HE-122: published with the
// docs server.

export const labels = (files: ReadonlyArray<DocumentFile>): string => {
  if (files.length === 0) return ""
  const names = files.map(([l]) => l)
  let s = `\n\nThis task has the label${names.length === 1 ? "" : "s"} ${names.join(", ")} on the board, so besides its other work you make ${documentsNamed(files)}.`
  if (names.includes("plan")) {
    s +=
      " The plan comes first: publish it before you change anything else, and iterate on it with the user. Don't start on the work until the user " +
      "approves the plan and asks you to; then work from it, and keep it up to date as you go (tick off its steps, and note where you strayed from it and why)."
  }
  s += publishGuide(files)
  for (const [label] of files) s += documentGuide(label, false)
  return s
}
