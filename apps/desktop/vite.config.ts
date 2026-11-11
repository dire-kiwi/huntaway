import { defineConfig } from "vite-plus"

// The desktop shell (docs/plan/09-frontend.md, The desktop shell). `vp pack` bundles it into the three CommonJS files
// Electron loads, each a single file with every dependency inside it (the packaged app carries no node_modules):
// `dist/boot.cjs` (the frame, the package's `main`), `dist/main.cjs` (the main process) and `dist/preload.cjs` (the bridge
// the page sees; a sandboxed preload must be CommonJS). One build per file, so that no chunk is shared between them: a
// release replaces main.cjs and preload.cjs, never boot.cjs. `electron` is Electron's own module, never bundled.
const bundle = (name: string, entry: string) => ({
  entry: { [name]: entry },
  format: "cjs" as const,
  platform: "node" as const,
  target: "node22",
  outDir: "dist",
  clean: false,
  deps: { neverBundle: ["electron"], onlyBundle: false as const },
  report: false,
})

export default defineConfig({
  pack: [bundle("boot", "src/boot/boot.ts"), bundle("main", "src/main/main.ts"), bundle("preload", "src/preload/preload.ts")],
  // `pnpm test` runs the tests beside the sources, in Node.
  test: {
    name: "desktop",
    include: ["src/**/*.test.ts"],
  },
})
