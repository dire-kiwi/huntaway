import { BROWSER_SERVER } from "./servers.ts"

// What a run with the board's `browser` server is told about it, beside the server's own instructions (HE-62).

export const browserNote = (codex: boolean): string => {
  const n = BROWSER_SERVER
  const t = (x: string) => (codex ? `\`${n}.${x}\`` : `mcp__${n}__${x}`)
  return (
    `\n\nYour task has its own web browser, which the user sees beside your thread on the board, with the \`${n}\` MCP ` +
    `server: ${t("navigate")} opens a page (a port like 5173 opens http://localhost:5173 on this machine), ${t("snapshot")} ` +
    `reads it as an outline with refs, ${t("click")}, ${t("type")} and ${t("press")} act on it, and ${t("screenshot")} shows ` +
    `it. Use it to check web work you make in a real browser, rather than a browser of your own (Playwright, a headless ` +
    `Chrome you start), so the user can watch and take over.`
  )
}
