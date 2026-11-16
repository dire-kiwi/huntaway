import type { StartupStep } from "@huntaway/contracts"

// What the progress page (progressPage.ts) and the board's restart dialog say about a server's start, from the steps it
// reports (`HUNTAWAY_PROGRESS`, contracts' `StartupStep`) and the app's own: plain functions.

/** A step of the start, as the page shows it. */
export interface StartupView {
  /** What is happening: "Backing up the database". */
  readonly step: string
  /** More about it: "0.8 GB of 1.6 GB". */
  readonly detail: string | null
  /** How far along the step is, 0 to 1, where that is known; null draws a bar that only moves. */
  readonly share: number | null
}

/** A number of bytes, for people. */
export const bytesText = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`)

/** What the app says before the server says anything. */
export const appStep = (step: string, detail: string | null = null): StartupView => ({ step, detail, share: null })

/**
 * A step the server reported. `written`: the bytes in the backup's file so far, which the app reads itself (the copy
 * holds the server's one thread, so it can't say).
 */
export const serverStep = (step: StartupStep, written: number | null = null): StartupView => {
  const total = step.total ?? 0
  switch (step.step) {
    case "backup": {
      const done = Math.min(written ?? step.done ?? 0, total)
      return {
        step: "Backing up the database",
        detail: total > 0 ? `${bytesText(done)} of ${bytesText(total)}, so that it can go back if the new version is no good` : null,
        share: total > 0 ? done / total : null,
      }
    }
    case "migrate": {
      const done = Math.min(step.done ?? 0, total)
      return { step: "Updating the database", detail: total > 0 ? `${Math.min(done + 1, total)} of ${total}` : null, share: total > 0 ? done / total : null }
    }
    case "start":
      return appStep("Starting the board")
    default:
      return appStep("Starting the server")
  }
}
