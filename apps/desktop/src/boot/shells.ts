import { readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { asObject, chooseShell, serverExe, serverFiles, shellSuits, stringList } from "../shared/versions.ts"

// What the frame (boot.ts) decides before any shell runs: which release's shell to load, and what to do about one that
// crashed. Plain Node, with no Electron, so that tests run it.
//
// `app/shell-state.json` is the shell's alone (the server leaves other files in app/ as they are), so it doesn't take
// part in state.json's two-writer protocol: `{bad: [versions whose shell failed], trying: {version, pid}}`.

/** A JSON file's object, or `{}` when there is none, it does not parse, or it is not an object. */
export const readJson = (file: string): Readonly<Record<string, unknown>> => {
  try {
    return asObject(JSON.parse(readFileSync(file, "utf8")))
  } catch {
    return {}
  }
}

/** Write `value` through a temp file and a rename, so that no reader sees half of it. */
export const writeJson = (file: string, value: unknown): void => {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, file)
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The shell's own state in `appDir` (`app/shell-state.json`). */
export const readShellState = (appDir: string): Readonly<Record<string, unknown>> => readJson(join(appDir, "shell-state.json"))

export const writeShellState = (appDir: string, state: Readonly<Record<string, unknown>>): void => {
  mkdirSync(appDir, { recursive: true })
  writeJson(join(appDir, "shell-state.json"), state)
}

/** The `trying` marker: the release shell a process is running, written before it loads. */
export const tryingOf = (state: Readonly<Record<string, unknown>>): { readonly version: string; readonly pid: number } | null => {
  const trying = asObject(state["trying"])
  return typeof trying["version"] === "string" && typeof trying["pid"] === "number" ? { version: trying["version"], pid: trying["pid"] } : null
}

/** Mark release `version`'s shell bad, and take away its marker. */
export const markShellBad = (appDir: string, version: string): void => {
  const state = readShellState(appDir)
  const bad = stringList(state, "bad")
  const { trying: _trying, ...rest } = state
  writeShellState(appDir, { ...(tryingOf(state)?.version === version ? rest : state), bad: bad.includes(version) ? bad : [...bad, version] })
}

/** Whether a process with this pid exists (one this user can't signal still does). */
export const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"
  }
}

export interface ShellChoice {
  readonly appDir: string
  readonly appVersion: string
  readonly electronVersion: string
  readonly platform?: string
}

/** The release shell to load, {dir, version}, or null for the package's own (`chooseShell` in shared/versions.ts). */
export const findShell = (options: ShellChoice): { readonly dir: string; readonly version: string } | null => {
  const exe = serverExe(options.platform ?? process.platform)
  const version = chooseShell({
    state: readJson(join(options.appDir, "state.json")),
    shellBad: stringList(readShellState(options.appDir), "bad"),
    appVersion: options.appVersion,
    installed: (v) => serverFiles(exe).every((file) => isFile(join(options.appDir, v, file))),
    usable: (v) =>
      isFile(join(options.appDir, v, "electron", "main.cjs")) &&
      shellSuits(readJson(join(options.appDir, v, "electron", "shell.json")), options.electronVersion),
  })
  return version === null ? null : { dir: join(options.appDir, version, "electron"), version }
}

/**
 * Deal with a release shell that was running when its process died (a `trying` whose pid is not running): mark it bad.
 * Returns whether another app process is running a release shell right now, which leaves the marker alone.
 */
export const settleCrash = (appDir: string, log: (line: string) => void): boolean => {
  const trying = tryingOf(readShellState(appDir))
  if (trying === null) return false
  if (trying.pid !== process.pid && alive(trying.pid)) return true
  log(`the desktop shell ${trying.version} stopped without quitting; using the one in the package`)
  markShellBad(appDir, trying.version)
  return false
}
