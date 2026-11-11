import { DESKTOP_SERVER } from "./servers.ts"

// What a run with the board's desktop server is told about it, beside the server's own instructions (huntaway's
// agent/runner/access.ts desktop_note). `host`: the host's name, whose desktop it is. Plan task 2.5; computer use is plan
// task 6.10.

export const desktopNote = (codex: boolean, host: string): string => {
  const n = DESKTOP_SERVER
  const t = (x: string) => (codex ? `\`${n}.${x}\`` : `mcp__${n}__${x}`)
  return (
    `\n\nYou can see and use the desktop of ${host}, the computer you run on, with the \`${n}\` MCP server (${t("windows")}, ` +
    `${t("read")}, ${t("act")} and so on). Use it only for what needs a GUI, when the shell and other tools can't do it. ` +
    `Someone may be using that desktop, and other tasks may need it: keep to the background (don't take focus or the ` +
    `pointer unless the user allows it), leave it as you found it, and if the screen is locked or another task is using ` +
    `it, say so rather than work around it.`
  )
}
