import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { isBuiltin } from "node:module"
import { join, posix } from "node:path"
import { fileURLToPath } from "node:url"
import { parseAst } from "vite/rolldown/parseAst"

// What the structural tests (docs/effect.md, Structural tests) share: the workspace's files, parsed with the oxc
// parser that Vite+ ships (`vite/rolldown/parseAst`), their imports and import graphs. Paths are relative to the
// workspace root, with `/`. A rule reports `file:line: what is wrong`.

/** The workspace root. */
export const root = fileURLToPath(new URL("../../../../", import.meta.url))

const abs = (path: string) => join(root, path)

export const exists = (path: string) => existsSync(abs(path))

const isFile = (path: string) => existsSync(abs(path)) && statSync(abs(path)).isFile()

/** Folders never read: installed, built or generated. */
const ignoredDirs = new Set(["node_modules", "dist", "target", "coverage", ".git", ".vite", ".vite-temp"])

const codeFile = /\.(?:[cm]?tsx?|[cm]?jsx?)$/

/** Every code file under `dir` (none when it does not exist), less declaration files and the folders in `skip`. */
export const listFiles = (dir: string, skip: ReadonlySet<string> = ignoredDirs): ReadonlyArray<string> => {
  if (!exists(dir) || !statSync(abs(dir)).isDirectory()) return []
  return readdirSync(abs(dir), { withFileTypes: true })
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) return skip.has(entry.name) ? [] : listFiles(path, skip)
      return codeFile.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : []
    })
}

/** `apps/*` and `packages/*`. */
export const workspaces = (): ReadonlyArray<string> =>
  ["apps", "packages"].flatMap((top) =>
    exists(top)
      ? readdirSync(abs(top), { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !ignoredDirs.has(entry.name))
          .map((entry) => `${top}/${entry.name}`)
          .toSorted()
      : [],
  )

/** The files under `apps/*\/src` and `packages/*\/src`, tests included. */
export const sourceFiles = (): ReadonlyArray<string> => workspaces().flatMap((workspace) => listFiles(`${workspace}/src`))

/** Sources and tests: `src`, `test`, `tests` and `migrations` of every app and package. */
export const allCode = (): ReadonlyArray<string> =>
  workspaces().flatMap((workspace) => ["src", "test", "tests", "migrations"].flatMap((dir) => listFiles(`${workspace}/${dir}`)))

export const isTest = (path: string) => /\.test\.[cm]?tsx?$/.test(path) || /(?:^|\/)(?:tests?|__tests__)\//.test(path)

export const read = (path: string) => readFileSync(abs(path), "utf8")

// The AST, read without casts: a node is an object with a string `type` and a `start` offset.

export interface Node {
  readonly type: string
  readonly start: number
  readonly end: number
  readonly [key: string]: unknown
}

export const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string" && "start" in value && typeof value.start === "number"

export const child = (node: Node, key: string): Node | undefined => {
  const value = node[key]
  return isNode(value) ? value : undefined
}

export const children = (node: Node, key: string): ReadonlyArray<Node> => {
  const value = node[key]
  if (!Array.isArray(value)) return []
  const items: ReadonlyArray<unknown> = value
  return items.filter(isNode)
}

/** An identifier's name or a string literal's value. */
export const nameOf = (node: Node | undefined): string | undefined => {
  if (node === undefined) return undefined
  const value = node.type === "Identifier" ? node["name"] : node.type === "Literal" ? node["value"] : undefined
  return typeof value === "string" ? value : undefined
}

/** `Object.property` as `["Object", "property"]`, for a plain (not computed) member of an identifier. */
export const member = (node: Node): readonly [string, string] | undefined => {
  if (node.type !== "MemberExpression" || node["computed"] === true) return undefined
  const object = child(node, "object")
  const property = child(node, "property")
  if (object?.type !== "Identifier" || property === undefined) return undefined
  const objectName = nameOf(object)
  const propertyName = nameOf(property)
  return objectName === undefined || propertyName === undefined ? undefined : [objectName, propertyName]
}

/** Visits every node depth first; `visit` returns false to skip a node's children. */
export const walk = (node: Node, visit: (node: Node, parents: ReadonlyArray<Node>) => boolean, parents: Array<Node> = []): void => {
  if (!visit(node, parents)) return
  parents.push(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      const items: ReadonlyArray<unknown> = value
      for (const item of items) if (isNode(item)) walk(item, visit, parents)
    } else if (isNode(value)) walk(value, visit, parents)
  }
  parents.pop()
}

export const isFunction = (node: Node) => node.type === "FunctionExpression" || node.type === "FunctionDeclaration" || node.type === "ArrowFunctionExpression"

export interface Parsed {
  readonly path: string
  readonly text: string
  /** Undefined when the file does not parse; `error` says why. */
  readonly program: Node | undefined
  readonly error: string | undefined
  /** The 1-based line of an offset. */
  readonly line: (offset: number) => number
}

const parsedFiles = new Map<string, Parsed>()

const lineStarts = (text: string): ReadonlyArray<number> => {
  const starts = [0]
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1)
  return starts
}

const parseProgram = (path: string, text: string): { readonly program: Node | undefined; readonly error: string | undefined } => {
  const lang = /\.[cm]?tsx$/.test(path) ? "tsx" : /\.[cm]?ts$/.test(path) ? "ts" : /\.[cm]?jsx$/.test(path) ? "jsx" : "js"
  try {
    const program: unknown = parseAst(text, { lang, sourceType: "module" }, path)
    return isNode(program) ? { program, error: undefined } : { program: undefined, error: "no program" }
  } catch (error) {
    return { program: undefined, error: error instanceof Error ? error.message.split("\n")[0] : "does not parse" }
  }
}

export const parse = (path: string): Parsed => {
  const cached = parsedFiles.get(path)
  if (cached !== undefined) return cached
  const text = read(path)
  const starts = lineStarts(text)
  const line = (offset: number) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if ((starts[mid] ?? 0) <= offset) low = mid
      else high = mid - 1
    }
    return low + 1
  }
  const parsed: Parsed = { path, text, line, ...parseProgram(path, text) }
  parsedFiles.set(path, parsed)
  return parsed
}

/** A file that does not parse is a finding of every rule that reads it, so a rule never passes by not looking. */
export const parseFailure = (parsed: Parsed): ReadonlyArray<string> =>
  parsed.program === undefined ? [`${parsed.path}:1: does not parse: ${parsed.error}`] : []

export interface Import {
  readonly specifier: string
  /** The names imported or re-exported: `default`, `*`, or the exported name. */
  readonly names: ReadonlyArray<string>
  /** `import type` / `export type`: erased, loads nothing. */
  readonly typeOnly: boolean
  readonly line: number
}

const importedNames = (declaration: Node): ReadonlyArray<string> =>
  children(declaration, "specifiers").flatMap((specifier) => {
    if (specifier.type === "ImportDefaultSpecifier") return ["default"]
    if (specifier.type === "ImportNamespaceSpecifier") return ["*"]
    const name = nameOf(child(specifier, specifier.type === "ExportSpecifier" ? "local" : "imported"))
    return name === undefined ? [] : [name]
  })

/** Every static import, re-export and literal dynamic `import()` of a file. */
export const imports = (path: string): ReadonlyArray<Import> => {
  const parsed = parse(path)
  if (parsed.program === undefined) return []
  const found: Array<Import> = []
  walk(parsed.program, (node) => {
    const isDeclaration = node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration"
    if (!isDeclaration && node.type !== "ImportExpression") return true
    const specifier = nameOf(child(node, "source"))
    if (specifier === undefined || child(node, "source")?.type !== "Literal") return true
    found.push({
      specifier,
      names: node.type === "ExportAllDeclaration" ? ["*"] : importedNames(node),
      typeOnly: node["importKind"] === "type" || node["exportKind"] === "type",
      line: parsed.line(node.start),
    })
    return true
  })
  return found
}

export const isEffect = (specifier: string) => specifier === "effect" || specifier.startsWith("effect/") || specifier.startsWith("@effect/")

export const isNodeModule = (specifier: string) => isBuiltin(specifier)

/**
 * The file an import loads, for a relative import or a workspace package (`@huntaway/<name>` is
 * `packages/<name>/src/index.ts`: the packages ship their sources). Undefined for anything else, or a file that is
 * not there.
 */
export const resolveImport = (from: string, specifier: string): string | undefined => {
  if (specifier.startsWith(".")) {
    const target = posix.normalize(posix.join(posix.dirname(from), specifier))
    if (target.startsWith("../")) return undefined
    return [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`].find(isFile)
  }
  const workspace = /^@huntaway\/([^/]+)$/.exec(specifier)
  if (workspace === null) return undefined
  const index = `packages/${workspace[1]}/src/index.ts`
  return isFile(index) ? index : undefined
}

export interface Reached {
  readonly path: string
  /** How the entry reaches it: `entry.ts -> a.ts -> path`. */
  readonly chain: string
}

/** Every file reachable from `entries` through the imports `follow` accepts and that resolve to a file. */
export const importGraph = (entries: ReadonlyArray<string>, follow: (from: string, imported: Import) => boolean): ReadonlyArray<Reached> => {
  const reached = new Map<string, Reached>(entries.map((path) => [path, { path, chain: path }]))
  const queue = [...entries]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const from = reached.get(next)
    for (const imported of imports(next)) {
      if (!follow(next, imported)) continue
      const target = resolveImport(next, imported.specifier)
      if (target === undefined || reached.has(target)) continue
      reached.set(target, { path: target, chain: `${from?.chain ?? next} -> ${target}` })
      queue.push(target)
    }
  }
  return [...reached.values()]
}
