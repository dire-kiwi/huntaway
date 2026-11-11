// What a Codex run in plan mode is told (Claude Code tells Claude itself) (huntaway's agent/runner/prompt.ts
// instructions). Plan task 2.5; Codex runs are plan task 5.2.

export const codexPlanMode =
  "\n\nYou are in plan mode: investigate and propose a plan, but don't change any files. The user will switch modes once they approve it."
