// A stand-in `ssh` for SSH links in tests (`HUNTAWAY_SSH_BIN`): the machine at the far end is this one, so nothing is
// added to an `authorized_keys` and no sshd is needed. It takes ssh's options as the hub gives them, then:
//
// - a command (`link` or `ensure`, which ssh would give the target's forced command as SSH_ORIGINAL_COMMAND): runs
//   `huntaway ssh-host --port $FAKE_SSH_PORT --data-dir $FAKE_SSH_DATA_DIR` with SSH_ORIGINAL_COMMAND set, as the
//   target's `command="huntaway ssh-host"` line would;
// - `-N … -L 127.0.0.1:<local>:127.0.0.1:<remote>`: forwards connections to the local port to the remote one until it
//   is killed, as the tunnel would.
//
// Each call appends its arguments as a JSON line to $FAKE_SSH_LOG, if set. With FAKE_SSH_REFUSE set it fails as a
// target that refuses the key does. Plain Node: it stands in for an outside program.
import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import { createConnection, createServer } from "node:net"

const args = process.argv.slice(2)
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify(args)}\n`)

// ssh's options that take a value. OpenSSH takes options after the target too (the hub puts `-N -L …` there): the
// first argument that is neither an option nor an option's value is the target, the others the command.
const withValue = new Set(["-i", "-o", "-p", "-L", "-R", "-l", "-F", "-J"])
let forward: string | undefined
const words: Array<string> = []
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? ""
  if (withValue.has(arg)) {
    if (arg === "-L") forward = args[i + 1]
    i++
  } else if (!arg.startsWith("-")) words.push(arg)
}
const [target, ...command] = words

if (process.env.FAKE_SSH_REFUSE) {
  process.stderr.write(`${target}: Permission denied (publickey).\n`)
  process.exit(255)
}

if (forward !== undefined) {
  const [, local, , remote] = forward.split(":")
  const server = createServer((socket) => {
    const upstream = createConnection(Number(remote), "127.0.0.1")
    socket.pipe(upstream)
    upstream.pipe(socket)
    const end = () => {
      socket.destroy()
      upstream.destroy()
    }
    socket.on("error", end)
    upstream.on("error", end)
    socket.on("close", end)
    upstream.on("close", end)
  })
  server.listen(Number(local), "127.0.0.1")
} else {
  const launcher = new URL("../../../apps/server/bin/huntaway", import.meta.url).pathname
  const child = spawn(launcher, ["ssh-host", "--port", process.env.FAKE_SSH_PORT ?? "7879", "--data-dir", process.env.FAKE_SSH_DATA_DIR ?? ""], {
    stdio: "inherit",
    env: { ...process.env, SSH_ORIGINAL_COMMAND: command.join(" ") },
  })
  child.on("exit", (code) => process.exit(code ?? 1))
}
