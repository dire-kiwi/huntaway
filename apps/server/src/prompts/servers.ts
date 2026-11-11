// The MCP servers' names, as the prompts name them (huntaway's agent/runner.ts MCP_SERVER_NAME and the SERVER_NAME of
// mcp/gh_mcp.ts, mcp/docs_mcp.ts and mcp/desktop_mcp.ts). Here, above `mcp/`, so the prompts and the servers share them.

/** The board's own tools. */
export const BOARD_SERVER = "huntaway"
/** GitHub through the gh CLI (plan task 4.4). */
export const GH_SERVER = "gh"
/** The profile's published documents (plan task 6.3). */
export const DOCS_SERVER = "docs"
/** Computer use (plan task 6.10). */
export const DESKTOP_SERVER = "desktop"
