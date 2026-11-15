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
