import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { Invalid } from "@huntaway/contracts"
import type { DirListing } from "@huntaway/contracts"
import { ServerConfig } from "../platform/ServerConfig.ts"

/** `~` and `~/…` in `home` (the old `util.ts` expand_tilde); anything else as given, trimmed. */
export const expandTilde = (path: string, home: string): string => {
  const p = path.trim()
  if (p === "~") return home
  if (p.startsWith("~/")) return `${home.replace(/\/+$/, "")}/${p.slice(2)}`
  return p
}

/** A path's parent as Rust's `Path::parent` gives it: null for `/` or an empty path, "" for a bare name. */
export const parentOf = (path: string): string | null => {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path
  if (trimmed === "/" || trimmed === "") return null
  const at = trimmed.lastIndexOf("/")
  if (at < 0) return ""
  return at === 0 ? "/" : trimmed.slice(0, at).replace(/\/+$/, "") || "/"
}

const key = (e: { readonly name: string }) => e.name.toLowerCase()

export interface FoldersShape {
  /**
   * `host.listDirs`, the folder browser (the old `fs_dirs`): a folder's subfolders, hidden ones flagged, sorted by name
   * whatever its case. Absent or blank is the home folder. A missing absolute folder is listed as empty.
   */
  readonly list: (path: string | undefined) => Effect.Effect<DirListing, Invalid>
}

/** Folders on this host, for picking a project's repository from another machine. */
export class Folders extends Context.Service<Folders, FoldersShape>()("huntaway-server/settings/Folders") {
  static readonly layer = Layer.effect(
    Folders,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const config = yield* ServerConfig
      const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false))
      const isDir = (p: string) =>
        fs.stat(p).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        )

      const list = Effect.fn("Folders.list")(function* (given: string | undefined) {
        const path = given !== undefined && given.trim() !== "" ? expandTilde(given, config.home) : config.home
        if (paths.isAbsolute(path) && !(yield* exists(path))) {
          return { path, parent: parentOf(path), exists: false, is_git: false, entries: [] }
        }
        const names = yield* fs.readDirectory(path).pipe(Effect.mapError((e) => new Invalid({ field: "path", reason: `${path}: ${e.message}` })))
        const entries = yield* Effect.forEach(
          names,
          (name) => {
            const p = paths.join(path, name)
            return Effect.gen(function* () {
              if (!(yield* isDir(p))) return []
              return [{ name, path: p, is_git: yield* exists(paths.join(p, ".git")), hidden: name.startsWith(".") }]
            })
          },
          { concurrency: 16 },
        )
        const sorted = entries.flat().toSorted((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
        return { path, parent: parentOf(path), exists: true, is_git: yield* exists(paths.join(path, ".git")), entries: sorted }
      })

      return Folders.of({ list })
    }),
  )
}
