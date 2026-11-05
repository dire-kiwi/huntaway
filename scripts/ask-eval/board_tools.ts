// The board's MCP tools as an agent's run lists them (see tools in server-ts/src/mcp.ts), for ask-eval's stub server:
// node --experimental-strip-types scripts/ask-eval/board_tools.ts
import { tools } from "../../server-ts/src/mcp.ts";

process.stdout.write(JSON.stringify(tools(false).filter((t) => t.name !== "permission_prompt")));
