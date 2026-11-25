import { Schema } from "effect"

// Settings → Experiments (docs/plan/09-frontend.md, Experiments): features still being tried, each switched on or off
// for the whole board. Adding one is an entry here; the host keeps its switch as the `settings` row
// `experiment_<id>` ("true" or none), which syncs like the other host-wide settings, and the web app and the server
// read it from the host's settings (`HostSettings.experiments`, through `knownExperiments`).

/** Every experiment, in the order Settings → Experiments lists them. All are off until switched on. */
export const EXPERIMENTS = [
  {
    id: "fold_turns",
    name: "Fold finished turns",
    description:
      "A finished turn's tool calls and its result line fold into one row, “Worked for 2m 10s · 7 steps”, with an amber dot if a step waited for approval and a red one if a step failed or was refused. Click it to see the steps.",
  },
  {
    id: "draft_cards",
    name: "Show outgoing mail and events as drafts",
    description:
      "When an agent asks to send a mail or to add or change a calendar event (the assistant's Google tools), its prompt shows the mail or the event as it will go out, rather than the tool's input: Send or Discard a mail, and edit its To, Subject and body before sending it (on Claude Code).",
  },
  {
    id: "check_ins",
    name: "Assistant check-ins",
    description:
      "The assistant's Routines tab offers Add check-ins: at the times you pick (say 11:00 and 16:30 on weekdays) the assistant looks over your boards and messages you only if something needs you, and stays quiet otherwise. It leaves you be while you're talking to it.",
  },
  {
    id: "a2ui",
    name: "Interactive replies (A2UI)",
    description:
      "Agents are told they can put interactive UI in a reply: an A2UI block, drawn in the thread as cards, choices, forms and buttons in the board's look. What you pick or fill in goes back to the agent as your message. Blocks are drawn whether this is on or not; it decides whether new runs are told about them.",
  },
  {
    id: "code_mode",
    name: "Claude Code's Code Mode",
    description:
      "New Claude Code conversations start in Code Mode (Claude Code's own experiment, CLAUDE_CODE_EXPERIMENTAL_CODE_MODE): the agent works by writing scripts that call its tools, rather than one tool call at a time. A conversation keeps the mode it started in, so switching this on or off applies to new conversations (a new task, or /new in a thread). Claude Code decides whether a conversation gets it (for now only on the Anthropic API, not through a gateway or cloud provider, and only for newer models); when it doesn't, the thread says why and the agent goes on with the ordinary tools.",
  },
] as const

/** An experiment's id. */
export const ExperimentId = Schema.Literals(EXPERIMENTS.map((e) => e.id))
export type ExperimentId = typeof ExperimentId.Type

const isExperimentId = Schema.is(ExperimentId)
const NONE: ReadonlyArray<ExperimentId> = []

const allKnown = (ids: ReadonlyArray<string>): ids is ReadonlyArray<ExperimentId> => ids.every(isExperimentId)

/**
 * The experiments a host says are on (`HostSettings.experiments`) that this build has: none for a host too old to say,
 * and without those a newer host has that this build doesn't. The same list when all are known.
 */
export const knownExperiments = (ids: ReadonlyArray<string> | undefined): ReadonlyArray<ExperimentId> =>
  ids === undefined ? NONE : allKnown(ids) ? ids : ids.filter(isExperimentId)

/** The `settings` key an experiment's switch is kept under. */
export const experimentKey = (id: ExperimentId): string => `experiment_${id}`
