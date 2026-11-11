// Where the shell finds things, shared by the frame and the main process. Every name that differs from the old app's is
// here, so that the switch (docs/plan/11-migration.md) renames them in one place: the new server has a data folder and
// a port of its own (`~/.local/share/huntaway-effect`, 7879), so the new shell keeps its own configuration and window
// storage beside the old app's rather than in them, and never finds the old board.

/** The port the shell looks for a server on, and starts one on: the new server's default. */
export const DEFAULT_PORT = 7879

/** The name of the folder the shell's own files (`desktop.json`, the windows' storage) are in, under Electron's appData. */
export const CONFIG_FOLDER = "huntaway-effect"

/** `~` and `~/…` in a path from desktop.json, against `home`. */
export const expandHome = (path: string, home: string): string => (path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path)

/**
 * The server's data folder, as the server finds it (`ServerConfig` in apps/server): `HUNTAWAY_DATA_DIR`, else
 * desktop.json's `dataDir`, else `$XDG_DATA_HOME/huntaway-effect` (`~/.local/share/huntaway-effect`).
 */
export const dataDirFor = (options: {
  readonly envDataDir: string | null
  readonly configDataDir: string | null
  readonly home: string
  readonly xdgDataHome: string | null
}): string => {
  if (options.envDataDir !== null && options.envDataDir !== "") return options.envDataDir
  if (options.configDataDir !== null && options.configDataDir !== "") return expandHome(options.configDataDir, options.home)
  const base = options.xdgDataHome !== null && options.xdgDataHome !== "" ? options.xdgDataHome : `${options.home}/.local/share`
  return `${base}/huntaway-effect`
}

/** The shell's own folder: `HUNTAWAY_DESKTOP_DIR`, else `<appData>/huntaway-effect`. desktop.json is in it. */
export const configDirFor = (options: { readonly envDir: string | null; readonly appData: string }): string =>
  options.envDir !== null && options.envDir !== "" ? options.envDir : `${options.appData}/${CONFIG_FOLDER}`
