import type { Effort } from "./claudeConfigs";
import { type Http } from "./http";
import type { PermissionMode } from "./tasks";
import type { TerminalTool } from "./terminal";

export interface RestartJob {
  /** A release update (`POST /admin/release/update`) goes through `downloading`, `verifying` and `installing` when
   * the version isn't staged yet. */
  phase: "starting" | "building_ui" | "building_server" | "downloading" | "verifying" | "installing" | "restarting" | "failed";
  log: string;
  error: string | null;
}

export interface ServerStatus {
  boot_id: string;
  started_at: string;
  source_dir: string | null;
  running_commit: string | null;
  running_agents: number;
  restart: RestartJob | null;
  source_commit?: string | null;
  source_branch?: string | null;
  dirty?: boolean;
  /** `<short sha> <subject>` for commits in the checkout that this server isn't running yet. */
  new_commits?: string[];
  /** API 65, with `--update-from`: the deployment this host follows, and what it last said it runs. */
  update_from?: string;
  deployed?: { commit: string | null; checked_at: string; error: string | null } | null;
  /** `<short sha> <subject>` for the deployed commits this server isn't running (when it's ahead of it). */
  deployed_commits?: string[];
  /** API 88, with `--release-updates`: the GitHub release this server could update to. */
  release?: ReleaseStatus;
  /** API 108, on a server that keeps the board in `huntaway-2.db` (`IA_NEW_DB_FILE`): which file the database is in. */
  database?: DatabaseFile;
}

/** The database file of a server that keeps the board in `huntaway-2.db`, copied from the one older builds use
 * (`huntaway.db`, or `issue-agent.db`) on its first start, which an older build goes back to as it was then. */
export interface DatabaseFile {
  file: string;
  /** The older file it was copied from, its database version then, and when; null for a data dir that had none. */
  copied_from: { source: string; source_version: number; copied_at: string } | null;
  /** The file an older build would open now, when it's changed since the copy: an older build has used the data dir
   * since, and what it did isn't in `file`. `POST /admin/database/recopy` copies it again. */
  older_changed: string | null;
}

/** A release asset (a server tarball or a desktop package), with its sha256 from GitHub's digest. */
export interface ReleaseAsset {
  name: string;
  /** Its `browser_download_url`. */
  url: string;
  size: number;
  sha256: string | null;
}

/** What the release checks found (API 88). Checked 30s after start, every 6 hours and on `POST /admin/release/check`. */
export interface ReleaseStatus {
  /** `OWNER/REPO` on GitHub. */
  repo: string;
  /** The version this server runs. */
  running: string;
  /** Where it runs from: `<data dir>/app/<v>/huntaway`, the desktop app's own server, or a tarball's. */
  exe?: string;
  /** The highest release with a server for this platform (prereleases only when `prereleases`), or null if none. */
  latest: {
    version: string;
    prerelease: boolean;
    published_at: string | null;
    /** The release's notes, in markdown. */
    notes: string | null;
    /** The release's page on GitHub. */
    url: string;
    /** Its server tarball for this platform. */
    asset: ReleaseAsset;
    /** Whether it's newer than `running`. */
    newer: boolean;
  } | null;
  /** The *Include prereleases* setting (`release_prereleases` in `/settings`). */
  prereleases: boolean;
  checked_at: string | null;
  /** Why the last check failed (what it found before is kept). */
  error: string | null;
  /** When GitHub's rate limit resets, if the last check ran into it. */
  rate_limit_reset: string | null;
  /** The desktop app that started this server, or null when none did (a server installed from the tarball). */
  shell: {
    version: string | null;
    install: "pacman" | "appimage" | "mac" | "other" | (string & {});
    /** The AppImage, or the .app on a mac. */
    path: string | null;
    /** Whether the latest release was built with another shell, which needs the new package. */
    outdated: boolean;
    /** The latest release's package for this install (the .pacman or the .AppImage), or null. */
    package: ReleaseAsset | null;
  } | null;
  /** The package's own server, to fall back to. */
  bundled_server: string | null;
  /** A newer version downloaded, checked and unpacked into `<data dir>/app/<v>/`, which Update
   * (`POST /admin/release/update {version}`) restarts onto. */
  staged: string | null;
  /** The background download of the latest release while it runs, or the last one's failure (tried again on the
   * next check); null once it's staged. */
  download: ReleaseDownload | null;
  /** The version before the one running from `app/`, kept for a rollback. */
  previous: string | null;
  /** Versions rolled back from or that didn't start, which aren't offered again. */
  bad: string[];
  /** What Roll back (`POST /admin/release/rollback`) would start: `previous`, `"bundled"` (the desktop app's own
   * server), or null when there's nothing to roll back to (or this server isn't running from `app/`). */
  rollback_to: string | null;
}

export interface ReleaseDownload {
  version: string;
  phase: "downloading" | "verifying" | "installing" | "failed";
  bytes: number;
  total: number | null;
  error: string | null;
}

/** Agent defaults for a host. */
export interface HostSettings {
  /** Used when the thread, project and profile don't pick a model. */
  default_model: string | null;
  default_effort: Effort | null;
  /** Used when the thread and project don't pick a mode (API 2). */
  default_permission_mode?: PermissionMode | null;
  /** On a board that can't run agents: the linked host its scratch tasks go to (API 6). */
  scratch_host?: string | null;
  /** TUI programs offered as shortcuts in task terminals (API 13). New ones get an id when saved. */
  terminal_tools?: TerminalTool[];
  /** Where the host is reached from outside, which its webhook URLs are shown with (API 63). */
  public_url?: string | null;
  /** Whether release checks include prereleases (API 88). Changing it checks again. */
  release_prereleases?: boolean;
  /** Hours a task can go without activity in Now before it goes back to Later (API 97): 0 for never, null for the default of a day. */
  now_expiry_hours?: number | null;
  /**
   * Keep threads as items (API 112): tasks whose first message comes while it's on keep their threads as items as well
   * as messages (docs/threads.md), and stay so. Off by default.
   */
  thread_items?: boolean;
}

/** The host API that has the thread_items setting. */
export const THREAD_ITEMS_API = 112;

export const serverApi = ({ on }: Http) => ({
  settings: (h: string) => on(h).get<HostSettings>("/settings"),
  updateSettings: (h: string, b: Partial<HostSettings>) => on(h).patch<HostSettings>("/settings", b),
  serverStatus: (h: string) => on(h).get<ServerStatus>("/admin/server"),
  restartServer: (h: string, b: { rebuild: boolean }) => on(h).post(`/admin/restart`, b),
  /** API 88, with `--release-updates`: check now, and get the server's status after. */
  checkReleases: (h: string) => on(h).post<ServerStatus>("/admin/release/check"),
  /** Restart onto a release (staged, or downloaded first), as a restart job. */
  updateRelease: (h: string, version: string) => on(h).post<{ ok: boolean }>("/admin/release/update", { version }),
  /** Restart onto `release.rollback_to`, marking the running version bad, as a restart job. */
  rollbackRelease: (h: string) => on(h).post<{ ok: boolean }>("/admin/release/rollback"),
  /** API 108: copy `database.older_changed` into `database.file` again as the server restarts, as a restart job. It
   * discards what's been done in `database.file` since it was copied (kept in `<file>.replaced` until the next copy). */
  recopyDatabase: (h: string) => on(h).post<{ ok: boolean }>("/admin/database/recopy"),
  /** Fetch `commit` from the host's origin, fast-forward its checkout to it, then rebuild and restart. */
  updateServer: (h: string, commit: string) => on(h).post<{ ok: boolean; up_to_date?: boolean }>(`/admin/update`, { commit }),
});
