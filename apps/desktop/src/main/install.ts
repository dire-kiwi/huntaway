import { Effect, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { installKind } from "../shared/versions.ts"
import type { DesktopShape } from "./Desktop.ts"

// What a release build tells the server it starts about how it was installed, and the PATH it starts it with.

/** Whether pacman owns `file` (`pacman -Qqo`): the app was installed from the pacman package. */
const ownedByPacman = (file: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const code = yield* spawner.exitCode(ChildProcess.make("pacman", ["-Qqo", file], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }))
    return Number(code) === 0
  }).pipe(
    Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed(false) }),
    // Not owned, or no pacman.
    Effect.orElseSucceed(() => false),
  )

/** How this release build was installed (`HUNTAWAY_DESKTOP_INSTALL`): `appimage:<file>`, `pacman`, `mac:<.app>` or `other`. */
export const installKindOf = Effect.fn("installKind")(function* (desktop: DesktopShape) {
  const resources = desktop.resourcesDir ?? ""
  const owned = desktop.platform === "linux" && resources.startsWith("/opt/") ? yield* ownedByPacman(resources) : false
  return installKind({ platform: desktop.platform, appimage: desktop.appimage, resourcesPath: resources, pacmanOwns: () => owned })
})

const MARK = "__HUNTAWAY_PATH__"

/**
 * The PATH to start the server with. An app started from the Dock or a desktop launcher gets a minimal PATH, without the
 * folders of claude, codex, git and gh (Homebrew's, ~/.local/bin, nvm's): a packaged app takes its login shell's, as a
 * terminal would have it, in front of its own. install.sh's launcher sets PATH itself, so a checkout keeps its own.
 */
export const serverPath = Effect.fn("serverPath")(function* (desktop: DesktopShape) {
  if (!desktop.isPackaged || desktop.platform === "win32") return desktop.path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const found = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(desktop.loginShell, ["-ilc", `printf "\\n${MARK}%s\\n" "$PATH"`], { stdin: "ignore", stderr: "ignore" }),
      )
      return yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.startsWith(MARK)),
        Stream.runHead,
      )
    }),
  ).pipe(
    Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeedNone }),
    Effect.tapError((error) => Effect.logWarning(`couldn't read the login shell's PATH: ${error.message}`)),
    Effect.orElseSucceed(() => Option.none<string>()),
  )
  const dirs = [...Option.match(found, { onNone: () => [], onSome: (line) => line.slice(MARK.length).split(":") }), ...desktop.path.split(":")]
  return [...new Set(dirs.filter((dir) => dir !== ""))].join(":")
})
