import { DOCS_SERVER } from "./servers.ts"

// What a run with the board's docs server is told about it (huntaway's agent/runner/access.ts docs_note). Plan task
// 2.5; the docs server is plan task 6.3.

export const docsNote = (codex: boolean): string => {
  const n = DOCS_SERVER
  const tool = codex ? `\`${n}.publish_document\`` : `mcp__${n}__publish_document`
  return (
    `\n\nTo give the user a report, plan, research or other write-up to read, publish it as a document with the ` +
    `\`${n}\` MCP server (${tool}; it's kept on this board, under your profile, with every version) and give them the ` +
    `URL it returns, rather than leaving it only in a message or a file. Its form fields (\`<Approval />\`, inputs) ` +
    `collect no answers here: ask in the thread for a decision or input.`
  )
}
