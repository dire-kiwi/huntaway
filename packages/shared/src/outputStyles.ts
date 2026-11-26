// Claude Code's built-in output styles (HE-102, HE-111; docs/plan/07-agents.md, Output styles): what a task's
// `/output-style` menu has before any run lists them (the server), and what the project's and the profile's output
// style fields suggest (the web app).

/** The built-in styles of Claude Code 2.1, with their descriptions. */
export const BUILT_IN_OUTPUT_STYLES: ReadonlyArray<{ readonly name: string; readonly description: string }> = [
  { name: "default", description: "Claude Code's own: completes coding tasks efficiently" },
  { name: "Proactive", description: "Claude executes immediately, minimizes interruptions, and prefers action over planning" },
  { name: "Concise", description: "Claude responds tersely, leading with results and skipping preamble and narration" },
  { name: "Explanatory", description: "Claude explains its implementation choices and codebase patterns" },
  { name: "Learning", description: "Claude pauses and asks you to write small pieces of code for hands-on practice" },
]
