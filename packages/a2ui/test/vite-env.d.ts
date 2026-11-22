// The two Vite features the conformance runner reads its fixtures with, typed here: the package's tsconfig loads no
// Node or Vite types (see tsconfig.json), and a `?raw` import and `import.meta.glob` need neither at run time.

declare module "*?raw" {
  const text: string
  export default text
}

interface ImportMeta {
  glob(pattern: string, options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" }): Record<string, string>
}
