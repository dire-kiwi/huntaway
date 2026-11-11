import { Schema } from "effect"

/** A folder in the folder browser (picking a project's repository on a remote host). Hidden folders are flagged. */
export const DirEntry = Schema.Struct({ name: Schema.String, path: Schema.String, is_git: Schema.Boolean, hidden: Schema.Boolean })

/** `host.listDirs`: a folder's subfolders, sorted by name. A missing absolute folder is listed as empty, so the picker can offer to make it. */
export const DirListing = Schema.Struct({
  path: Schema.String,
  parent: Schema.NullOr(Schema.String),
  exists: Schema.Boolean,
  is_git: Schema.Boolean,
  entries: Schema.Array(DirEntry),
})
export interface DirListing extends Schema.Schema.Type<typeof DirListing> {}
