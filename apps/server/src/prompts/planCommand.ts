import { labels } from "./labels.ts"

// What a `/plan` message says to the agent in place of the command (huntaway's agent/documents.ts plan_prompt): how to
// write the plan to `file`, unless its system prompt says so already (`told`), and what to plan (`rest`). Plan task 2.5.

export const planCommand = (file: string, rest: string, told: boolean): string => {
  let s = told
    ? `Write a plan to ${file}, as your instructions for this task's plan say, and iterate on it with me before you start on the work.`
    : labels([["plan", file]]).trimStart()
  s += rest === "" ? "\n\nWrite the plan now, for the work this task is about." : `\n\nWhat to plan: ${rest}`
  return s
}
