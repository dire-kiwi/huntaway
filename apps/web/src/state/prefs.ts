import { Schema } from "effect"
import { Atom } from "effect/reactivity"
import { Status } from "@huntaway/contracts"
import { stored, storedBare } from "./storage"

// The persisted preferences the board, layout and ui components read (inventory 10, section 3.3), each under its old
// key with a schema. A value that does not decode is the default. Components still on `localStorage` (step 1) move to
// these one feature at a time.

const Keys = Schema.Array(Schema.String)
const OpenClosed = Schema.Literals(["open", "closed"])
const Flag = Schema.Literals(["0", "1"])

/** The profile picked last, whose projects the sidebar lists (`ia.activeProfile`). */
export const activeProfileAtom = storedBare("ia.activeProfile", Schema.String, null)

/** The last profile tint shown, applied before profiles load (`ia.tint`). */
export const tintAtom = storedBare("ia.tint", Schema.String, null)

/** How the boards show their tasks (`ia.boardView`). */
export const boardViewAtom = storedBare("ia.boardView", Schema.Literals(["board", "list", "triage", "graph"]), "board")

/** How the boards sort their tasks (`ia.board.sort`); null is the board's own order. */
export const boardSortAtom = storedBare("ia.board.sort", Schema.String, null)

/** Whether the kanban board's Backlog column is open (`ia.board.backlog`); it starts collapsed. */
export const backlogAtom = storedBare("ia.board.backlog", OpenClosed, "closed")

/** Whether the list view's Archived section is open (`ia.board.archived`); it starts collapsed. */
export const archivedSectionAtom = storedBare("ia.board.archived", OpenClosed, "closed")

/** The column a board shows in the narrow layout (`ia.board.column.<board>`). */
export const boardColumnAtom = Atom.family((board: string) => storedBare(`ia.board.column.${board}`, Status, null))

/** Stacks gathered into one card or spread out (`ia.board.stacks`). */
export const stacksAtom = storedBare("ia.board.stacks", Schema.Literals(["gathered", "spread"]), "gathered")

/** Each stack's own view where it differs (`ia.board.stackViews`). */
export const stackViewsAtom = stored("ia.board.stackViews", Schema.Record(Schema.String, Schema.Literals(["gathered", "spread"])), {})

/** The triage view's closed sections (`ia.triage.closed`). */
export const triageClosedAtom = stored("ia.triage.closed", Keys, ["start", "working"])

/** The sidebar's collapsed sections (`ia.sidebar.collapsedSections`). */
export const collapsedSectionsAtom = stored("ia.sidebar.collapsedSections", Keys, [])

/** The sidebar's collapsed groups, hidden, pinned and favourite projects (`projectGroups.ts`'s keys). */
export const collapsedGroupsAtom = stored("ia.collapsedGroups", Keys, [])
export const hiddenProjectsAtom = stored("ia.hiddenProjects", Keys, [])
export const pinnedProjectsAtom = stored("ia.pinnedProjects", Keys, [])
export const favoriteProjectsAtom = stored("ia.favoriteProjects", Keys, [])

/** Whether the sidebar's usage panel is open (`ia.usageOpen`). */
export const usageOpenAtom = storedBare("ia.usageOpen", Flag, "0")

/** A profile's open pen tab (`ia.pen.<profile>`), and its collapsed lanes (`ia.pen.collapsed.<profile>`). */
export const penTabAtom = Atom.family((profile: string) => storedBare(`ia.pen.${profile}`, Schema.String, null))
export const penCollapsedAtom = Atom.family((profile: string) => stored(`ia.pen.collapsed.${profile}`, Keys, []))
