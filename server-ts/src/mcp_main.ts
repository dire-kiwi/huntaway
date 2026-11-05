/**
 * What `bin/huntaway mcp` runs: the agents' MCP helper (mcp.ts's `serve_stdio`), without loading the whole server (see
 * main.ts). A file of its own rather than an `if (import.meta.main)` in mcp.ts, which Node before 24.2 doesn't set
 * (HA-245, see approval_rules/hook_main.ts).
 */
import { serve_stdio } from "./mcp.ts";
import { err_str } from "./util.ts";

serve_stdio().catch((e) => {
  console.error(`Error: ${err_str(e)}`);
  process.exit(1);
});
