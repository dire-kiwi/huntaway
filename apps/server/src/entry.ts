import { enableCompileCache } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"

// What the launcher (bin/huntaway) runs for `serve` and the other subcommands of bin.ts (docs/plan/06-server.md, The
// CLI). HE-71: most of a start is Node loading code, so Node keeps what it compiled (TypeScript with its types stripped,
// and V8's code) in its compile cache, in the temp folder as the hooks' (`$TMPDIR/node-compile-cache`), and the next
// start reads it back: from a checkout, about 470 ms to ready rather than 800. It's turned on here, in the process,
// rather than with NODE_COMPILE_CACHE, which every child would inherit (agents' own node, and what they run). Imports
// are hoisted, so bin.ts is loaded after it is on, with `import()`. A server rarely exits as Node writes the cache
// then: `serve` writes it once it's ready (serve.ts).
enableCompileCache(join(tmpdir(), "node-compile-cache"))

await import("./bin.ts")
