// What the Changes tab and the compare view share: how diffs are laid out.
import { Schema } from "effect"
import { storedBare } from "../../../state/storage"
import type { Layout } from "../DiffLines"

/** Unified or split diffs, kept in this browser (the compare view's one at a time follows it too). */
export const layoutAtom = storedBare<Layout, "unified">("ia.changes.layout", Schema.Literals(["unified", "split"]), "unified")
