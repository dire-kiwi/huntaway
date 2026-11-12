import { Schema } from "effect"

// The profile's assistant (docs/plan/inventory/02-agent-support.md 2.12; huntaway's packages/client/src/assistant.ts):
// its memory (files in its workspace and their history), the Google card, the morning brief and its ratings. The
// assistant itself is a task (`Task`, `task_type` "assistant").

/** What kind of file the Memory tab lists: USER.md, MEMORY.md, a daily log (`memory/YYYY-MM-DD.md`) or anything else. */
export const MemoryFileKind = Schema.Literals(["user", "memory", "log", "other"])
export type MemoryFileKind = typeof MemoryFileKind.Type

/** A file in the assistant's workspace. */
export const MemoryFileInfo = Schema.Struct({
  path: Schema.String,
  kind: MemoryFileKind,
  /** In bytes. */
  size: Schema.Finite,
  /** Its length in characters, for the files a run is told (USER.md, MEMORY.md, today's and yesterday's logs); null for the rest. */
  chars: Schema.NullOr(Schema.Finite),
  modified: Schema.NullOr(Schema.String),
})
export type MemoryFileInfo = typeof MemoryFileInfo.Type

/** The workspace and its files, how much of each memory file a run is told, and the prompt for an import. */
export const MemoryOverview = Schema.Struct({
  task_id: Schema.String,
  /** The workspace, on its host. */
  dir: Schema.String,
  /** How many characters of USER.md, MEMORY.md and each loaded daily log a run is told, and how many bytes. */
  cap: Schema.Finite,
  cap_bytes: Schema.Finite,
  /** Today's log's path, in the host's time zone. */
  today: Schema.String,
  /** Whether the workspace has history (a git repository of the board's, beside it). */
  history: Schema.Boolean,
  files: Schema.Array(MemoryFileInfo),
  /** What to paste into another assistant for it to write out what it knows about the user. */
  import_prompt: Schema.String,
})
export type MemoryOverview = typeof MemoryOverview.Type

/** A file, now or as it was in commit `rev`. */
export const MemoryFileContent = Schema.Struct({ path: Schema.String, content: Schema.String, rev: Schema.NullOr(Schema.String) })
export type MemoryFileContent = typeof MemoryFileContent.Type

/** A file written: its content, and the commit that saved it (none if it didn't change). */
export const MemoryWrite = Schema.Struct({ path: Schema.String, content: Schema.String, commit: Schema.NullOr(Schema.String) })
export type MemoryWrite = typeof MemoryWrite.Type

/** A commit of the workspace's history. `author`: "Assistant", or "You" for an edit from the Memory tab. */
export const MemoryCommit = Schema.Struct({
  sha: Schema.String,
  author: Schema.String,
  date: Schema.String,
  message: Schema.String,
  files: Schema.Array(Schema.String),
})
export type MemoryCommit = typeof MemoryCommit.Type

export const MemoryHistory = Schema.Struct({ commits: Schema.Array(MemoryCommit) })
export type MemoryHistory = typeof MemoryHistory.Type

/** What a commit changed (in one file), as a patch. */
export const MemoryDiff = Schema.Struct({ rev: Schema.String, diff: Schema.String })
export type MemoryDiff = typeof MemoryDiff.Type

/** A file the Google server reads, on the assistant's host. `private`: readable by its owner alone. */
export const GoogleFile = Schema.Struct({ path: Schema.String, exists: Schema.Boolean, private: Schema.Boolean })
export type GoogleFile = typeof GoogleFile.Type

/** An account with credentials in the Google server's folder. */
export const GoogleAccount = Schema.Struct({
  email: Schema.String,
  file: Schema.String,
  /** It has a refresh token, so the server can go on using it (without one it lasts an hour). */
  refresh_token: Schema.Boolean,
  private: Schema.Boolean,
  scopes: Schema.Array(Schema.String),
  /** What the brief reads that it wasn't granted. */
  missing_scopes: Schema.Array(Schema.String),
})
export type GoogleAccount = typeof GoogleAccount.Type

/** The host's global MCP server called `google`: `on` when the profile switches it on. */
export const GoogleServer = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
  on: Schema.Boolean,
  command: Schema.String,
  /** The command is on the host's PATH (or is a path to a program). */
  command_found: Schema.Boolean,
})
export type GoogleServer = typeof GoogleServer.Type

/** Whether Google is connected for the assistant, on its host, and what's missing if it isn't. */
export const GoogleStatus = Schema.Struct({
  connected: Schema.Boolean,
  /** The account it acts as, once connected. */
  account: Schema.NullOr(Schema.String),
  /** What's in the way, in words. */
  problem: Schema.NullOr(Schema.String),
  /** What's off but doesn't stop it. */
  warnings: Schema.Array(Schema.String),
  server: Schema.NullOr(GoogleServer),
  client_secret: GoogleFile,
  credentials_dir: Schema.String,
  accounts: Schema.Array(GoogleAccount),
  /** What to run on the host to sign in (`huntaway google-auth …`). */
  consent_command: Schema.String,
  /** The host's name and the port the sign-in listens on, for the ssh command. */
  host: Schema.String,
  consent_port: Schema.Finite,
  /** With `check`: whether Google took the refresh token, and why not. */
  verified: Schema.optionalKey(Schema.Boolean),
  verify_error: Schema.optionalKey(Schema.String),
})
export type GoogleStatus = typeof GoogleStatus.Type

/** How the user rated one of the brief's items: `clear` takes a rating back. */
export const BriefRating = Schema.Literals(["up", "down", "clear"])
export type BriefRating = typeof BriefRating.Type

/** The kinds of item a brief has. */
export const BriefKind = Schema.Literals(["calendar", "mail", "drive", "board", "other"])
export type BriefKind = typeof BriefKind.Type

/** One of the brief's items, as the board lists it to rate: its kind, what a rating of it is about, and the item in a line. */
export const BriefItem = Schema.Struct({ kind: BriefKind, topic: Schema.String, title: Schema.String })
export type BriefItem = typeof BriefItem.Type

/** A rating's line in MEMORY.md (none for `clear`), what MEMORY.md says now, and its commit. */
export const BriefFeedback = Schema.Struct({ line: Schema.NullOr(Schema.String), content: Schema.String, commit: Schema.NullOr(Schema.String) })
export type BriefFeedback = typeof BriefFeedback.Type
