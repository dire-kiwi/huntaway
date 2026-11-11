// What a run is told of its task's temp folder, its `$TMPDIR` (huntaway's agent/runner/prompt.ts instructions). `shared`:
// a review thread's, which is its task's. Plan task 2.5; the folders are plan task 2.8 (`TaskTmp`).

export const tempFolder = (dir: string, shared: boolean): string =>
  `\n\nYour temp folder is ${dir} (\`$TMPDIR\` in your shell${shared ? ", shared with the task's agent" : ""}). ` +
  `Put scratch files, logs and test data there rather than directly in /tmp. It's deleted once the task is done, so ` +
  `don't keep anything there that's needed after that.`
