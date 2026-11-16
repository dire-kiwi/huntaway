import { SPACES_SERVER } from "./servers.ts"

// What a run with the board's `spaces` server is told about it, beside the server's own instructions (HE-37). `host`:
// the host's name, whose Spaces they are.

export const spacesNote = (codex: boolean, host: string): string => {
  const n = SPACES_SERVER
  const t = (x: string) => (codex ? `\`${n}.${x}\`` : `mcp__${n}__${x}`)
  return (
    `\n\nYou can make and use Spaces, Linux desktops in Docker on ${host}, with the \`${n}\` MCP server: ${t("create_space")} ` +
    `makes one (or reuses one of that name), ${t("space_bash")} runs commands in it, and ${t("space_list_tools")} and ` +
    `${t("space_call_tool")} drive its desktop through its Cua Driver (screenshots, clicks, typing). Use one when the work needs ` +
    `a desktop or a machine of its own to try things on, not for what your own shell can do. ${t("space_view")} gives a link ` +
    `for the user to watch it, and ${t("space_sign_in")} signs in to a website there with a password the user saved, once they approve. ` +
    `Stop or delete the Spaces you made when you're done with them, unless the user wants to keep them.`
  )
}
