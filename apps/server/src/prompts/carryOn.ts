// What a thread that waited in In progress is sent when it can go on (huntaway's agent/runner/send.ts, when a usage
// limit resets or its dependencies are merged). Plan task 2.5 (`Runs`); waiting for dependencies is plan task 1.4's
// `Dependencies`, for usage limits plan task 2.8.

export const usageLimitReset = "The usage limit you ran into has reset, so carry on where you left off."

export const dependenciesMerged = "The tasks this one was waiting for are merged (or no longer needed), so carry on with it."
