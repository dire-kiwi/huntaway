import { Context, Effect, Layer, Queue, Schema, Stream } from "effect"
import type { PlatformError, Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

// A minimal pseudo-terminal (huntaway's hosts/pty.ts; docs/plan/06-server.md, Terminal): run a command on the slave
// side, read and write the master side, and resize it.
//
// Node has no openpty without a native module, so a small Python helper holds the terminal: the command runs as the
// session leader of a new pty (Python's `pty.fork`), the helper copies its stdin to the terminal and the terminal's
// output to its stdout, and takes `<cols> <rows>` lines on fd 3 to resize it. It exits once the terminal's side has
// closed (or its stdin has), and the command is hung up when it goes. Kept as it was for M6; a small Rust binary beside
// the shim (`ia-pty`) can replace it if Python proves a burden on a release host.

const HELPER = `
import os, pty, sys, fcntl, termios, struct, select, signal
cols, rows = int(sys.argv[1]), int(sys.argv[2])
argv = sys.argv[3:]
def winsize(fd, c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(r, 1), max(c, 1), 0, 0))
pid, fd = pty.fork()
if pid == 0:
    try:
        winsize(0, cols, rows)
        os.execvp(argv[0], argv)
    except Exception as e:
        sys.stderr.write("starting terminal process: %s\\n" % e)
    os._exit(127)
signal.signal(signal.SIGTERM, lambda *a: (os.close(fd), os._exit(0)))
winsize(fd, cols, rows)
def write_all(f, data):
    while data:
        data = data[os.write(f, data):]
ins, ctl = [fd, 0, 3], b""
while True:
    r = select.select(ins, [], [])[0]
    if fd in r:
        try:
            data = os.read(fd, 32768)
        except OSError:
            data = b""
        if not data:
            break
        write_all(1, data)
    if 0 in r:
        data = os.read(0, 32768)
        if not data:
            break
        try:
            write_all(fd, data)
        except OSError:
            break
    if 3 in r:
        data = os.read(3, 4096)
        if not data:
            ins.remove(3)
        ctl += data
        while b"\\n" in ctl:
            line, ctl = ctl.split(b"\\n", 1)
            try:
                c, r_ = map(int, line.split())
                winsize(fd, c, r_)
                os.kill(pid, signal.SIGWINCH)
            except Exception:
                pass
os.close(fd)
try:
    os.waitpid(pid, 0)
except OSError:
    pass
`

/** The terminal's process couldn't be started, or its output couldn't be read. */
export class PtyFailed extends Schema.TaggedError<PtyFailed, { readonly brand: unique symbol }>()("PtyFailed", { reason: Schema.String }) {}

/** A command in a terminal of its own, for as long as the scope it was spawned in. */
export interface PtyProcess {
  /** The terminal's output. Ends once the command's side has closed (it exited, or was hung up). */
  readonly output: Stream.Stream<Uint8Array, PtyFailed>
  /** Typed into the terminal. */
  readonly write: (data: Uint8Array) => Effect.Effect<void>
  readonly resize: (cols: number, rows: number) => Effect.Effect<void>
  /** Waits for the helper (and so the command) to exit. */
  readonly exited: Effect.Effect<void>
}

export interface PtyShape {
  /**
   * Start `command` with `args` as the session leader of a new terminal of `cols` × `rows`, in `env` over the server's
   * environment (`extendEnv`). Closing the scope hangs it up.
   */
  readonly spawn: (
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly env: Readonly<Record<string, string | undefined>>; readonly cols: number; readonly rows: number },
  ) => Effect.Effect<PtyProcess, PtyFailed, Scope.Scope>
}

const failed = (e: PlatformError.PlatformError) => new PtyFailed({ reason: e.message })

export class Pty extends Context.Service<Pty, PtyShape>()("huntaway-server/terminal/Pty") {
  static readonly layer = Layer.effect(
    Pty,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const encoder = new TextEncoder()

      const spawn = Effect.fn("Pty.spawn")(function* (
        command: string,
        args: ReadonlyArray<string>,
        options: { readonly env: Readonly<Record<string, string | undefined>>; readonly cols: number; readonly rows: number },
      ) {
        const input = yield* Queue.unbounded<Uint8Array>()
        const control = yield* Queue.unbounded<Uint8Array>()
        const handle = yield* spawner
          .spawn(
            ChildProcess.make("python3", ["-I", "-c", HELPER, String(options.cols), String(options.rows), command, ...args], {
              env: options.env,
              extendEnv: true,
              stdin: Stream.fromQueue(input),
              additionalFds: { fd3: { type: "input", stream: Stream.fromQueue(control) } },
            }),
          )
          .pipe(Effect.mapError(failed))
        // What the helper says went wrong (it couldn't start the command) goes to the log.
        yield* handle.stderr.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => (line.trim() === "" ? Effect.void : Effect.logWarning(`terminal: ${line.trim()}`))),
          Effect.ignore,
          Effect.forkScoped,
        )
        return {
          output: handle.stdout.pipe(Stream.mapError(failed)),
          write: (data: Uint8Array) => Queue.offer(input, data).pipe(Effect.asVoid),
          resize: (cols: number, rows: number) => Queue.offer(control, encoder.encode(`${Math.max(cols, 1)} ${Math.max(rows, 1)}\n`)).pipe(Effect.asVoid),
          exited: handle.exitCode.pipe(Effect.ignore),
        } satisfies PtyProcess
      })

      return Pty.of({ spawn })
    }),
  )
}
