import { labels } from "./labels.ts"

// What a `/plan` message says to the agent in place of the command (huntaway's agent/documents.ts plan_prompt): how to
// make the plan (published with the docs server, HE-122; `file` is where an older task's plan was), unless its system prompt says so already (`told`), and what to plan (`rest`). Plan task 2.5.

export const planCommand = (file: string, rest: string, told: boolean): string => {
  let s = told
    ? "Make a plan and publish it with the docs server, as your instructions for this task's plan say, and iterate on it with me before you start on the work."
    : labels([["plan", file]]).trimStart()
  s += rest === "" ? "\n\nMake the plan now, for the work this task is about." : `\n\nWhat to plan: ${rest}`
  return s
}
