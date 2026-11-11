// A task's first prompt (huntaway's agent/runner/prompt.ts start_prompt and external_links_note): a command first if
// the message is one, the task's heading and description, the tasks elsewhere it is for, a rule, the instructions for
// starting, then the message. Plan task 2.5.

/** A task in another tracker that a task is for. */
export interface StartLink {
  readonly provider: string
  readonly title: string
  readonly url: string
}

export interface StartFacts {
  /** E.g. `WEB-12`. */
  readonly key: string
  readonly title: string
  readonly description: string
  readonly links: ReadonlyArray<StartLink>
  /** What to do: the workflow's In progress text, the project's start prompt, or the default. */
  readonly instructions: string
  /** The message, trimmed. */
  readonly text: string
  /** The message is a command (`/skill …`), which goes first: Claude Code only expands a command at the start of a prompt. */
  readonly command: boolean
}

/** The tasks elsewhere a task is for, as its first prompt lists them. */
const linksNote = (links: ReadonlyArray<StartLink>): string => {
  if (links.length === 0) return ""
  let s = "\nThis task is for:\n"
  for (const l of links) {
    const provider = l.provider === "asana" ? "Asana" : l.provider
    const title = l.title !== "" ? l.title : l.url
    s += `- ${provider} task: ${title} (${l.url})\n`
  }
  return s
}

export const startPrompt = (t: StartFacts): string => {
  let p = ""
  if (t.command) p += `${t.text}\n\n`
  p += `# ${t.key}: ${t.title}\n`
  if (t.description.trim() !== "") p += `\n${t.description.trim()}\n`
  p += linksNote(t.links)
  p += `\n---\n\n${t.instructions}\n`
  if (t.text !== "" && !t.command) p += `\n${t.text}\n`
  return p
}
