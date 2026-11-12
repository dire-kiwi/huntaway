import type { Family } from "../family.ts"

// The importer's table families, in the order they run (docs/plan/11-migration.md, Table by table): a family runs after
// the ones whose rows it points at. One line per family.

export const FAMILIES: ReadonlyArray<Family> = []
