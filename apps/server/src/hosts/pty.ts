// Port of server/src/hosts/pty.rs: a minimal pseudo-terminal: run a command on the slave side, read and write the
// master side, and resize it.
//
// Node has no openpty without a native module, so a small Python helper holds the terminal: the command runs as the
// session leader of a new pty (Python's `pty.fork`), the helper copies its stdin to the terminal and the terminal's
// output to its stdout, and takes `<cols> <rows>` lines on fd 3 to resize it. It exits once the terminal's side has
// closed (or its stdin has), and the command is hung up when it goes.
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

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
`;

export class Pty {
  child: ChildProcess;
  /** The terminal's output. Ends once the other side has closed. */
  output: Readable;
  private input: Writable;
  private control: Writable;

  private constructor(child: ChildProcess) {
    this.child = child;
    this.output = child.stdout!;
    this.input = child.stdin!;
    this.control = child.stdio[3] as Writable;
    for (const s of [this.input, this.control]) s.on("error", () => {});
  }

  /** Start `cmd` with `args` as the session leader of a new terminal of the given size. */
  static spawn(cmd: string, args: string[], env: NodeJS.ProcessEnv, cols: number, rows: number): Promise<Pty> {
    return new Promise((resolve, reject) => {
      const child = spawn("python3", ["-I", "-c", HELPER, String(cols), String(rows), cmd, ...args], { env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
      child.once("error", (e) => reject(new Error("starting terminal process", { cause: e })));
      child.once("spawn", () => resolve(new Pty(child)));
      child.stderr!.on("data", (d: Buffer) => console.error(`terminal: ${d.toString().trim()}`));
    });
  }

  write(data: Buffer) {
    this.input.write(data);
  }

  resize(cols: number, rows: number) {
    this.control.write(`${Math.max(cols, 1)} ${Math.max(rows, 1)}\n`);
  }

  /** Ends the terminal: the command is hung up (Rust's `kill_on_drop`). */
  kill() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }

  /** Waits for the helper (and so the command) to exit. */
  wait(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    return new Promise((r) => this.child.once("exit", () => r()));
  }
}
