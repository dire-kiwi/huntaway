import { GH_SERVER } from "./servers.ts"

// What a run with the board's gh server is told about GitHub (huntaway's agent/runner/access.ts gh_note, and the Codex
// wording in agent/runner/prompt.ts instructions). `account`: the GitHub account its gh tools act as, if one is set.
// Plan task 2.5; the gh server is plan task 4.4.

/** For Claude Code, whose gh in Bash is turned away by a hook. */
export const githubNote = (account: string | null): string =>
  `\n\nFor GitHub (pull requests, issues, CI runs, the API), use the \`${GH_SERVER}\` MCP server's tools (mcp__${GH_SERVER}__pr_view, ` +
  `pr_create, pr_checks and so on; mcp__${GH_SERVER}__gh runs any other gh command) rather than the gh CLI in Bash, which is ` +
  `blocked here. They run gh outside the sandbox${account !== null ? ` as the GitHub account ${account}` : ""}.`

/**
 * For Codex, whose sandbox may keep `gh` in the shell off the network, and whose GitHub app may not reach the user's
 * repositories. Codex has no hook to turn gh in the shell away, so it is only told.
 */
export const codexGithubNote = (account: string | null): string => {
  const n = GH_SERVER
  const as = account !== null ? ` as the GitHub account ${account}` : ""
  const other = account !== null ? " or would act as another account" : ""
  return (
    `\n\nFor GitHub, use the \`${n}\` MCP server's tools (e.g. \`${n}.pr_view\`, \`${n}.pr_diff\`), which run gh with ` +
    `the user's login${as}: don't run \`gh\` in your shell, which may not reach GitHub${other}, and the codex_apps ` +
    `GitHub tools may not have access to this repository.`
  )
}
