// A stand-in for the Docker CLI as Spaces use it (apps/server/src/spaces/Docker.ts), for tests (HE-37): the server runs
// it as its Docker when its `HUNTAWAY_DOCKER` names it (`fakeDocker` in src/fakeDocker.ts). Plain Node: it stands in
// for an outside program, and runs no container.
//
// It keeps its images and containers in $HUNTAWAY_FAKE_DOCKER_DIR/state.json, logs each command (its arguments, a JSON
// line) to calls.jsonl there, and gives every container's spacesd port as the number in `spacesd-port` (a fake spacesd's,
// `fakeSpacesd`). `docker exec`: a command run through `timeout` (`Spaces.bash`) prints `Linux space <command>` and
// exits 0, or exits with the number after `exit ` in it; any other (a file written into a home) keeps its standard input
// in the container's `files`. `down` in the folder makes the engine unreachable.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

interface Container {
  Name: string
  State: { Status: string }
  Config: { Image: string; Env: Array<string>; Labels: Record<string, string> }
  NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }>> }
  files: Record<string, string>
}

interface State {
  images: Array<string>
  containers: Record<string, Container>
}

const dir = process.env["HUNTAWAY_FAKE_DOCKER_DIR"] ?? ""
if (dir === "") {
  process.stderr.write("fake-docker: HUNTAWAY_FAKE_DOCKER_DIR isn't set\n")
  process.exit(2)
}
const args = process.argv.slice(2)
appendFileSync(`${dir}/calls.jsonl`, `${JSON.stringify(args)}\n`)

const stateFile = `${dir}/state.json`
// Its own file, written only by itself.
const read = (): State => JSON.parse(readFileSync(stateFile, "utf8"))
const state: State = existsSync(stateFile) ? read() : { images: [], containers: {} }
const save = () => writeFileSync(stateFile, JSON.stringify(state))
const out = (s: string) => process.stdout.write(s)
const fail = (s: string, code = 1): never => {
  process.stderr.write(`${s}\n`)
  process.exit(code)
}
const stdin = () => readFileSync(0, "utf8")
const port = () => (existsSync(`${dir}/spacesd-port`) ? readFileSync(`${dir}/spacesd-port`, "utf8").trim() : "1")
const flags = (name: string) => args.flatMap((a, i) => (a === name ? [args[i + 1] ?? ""] : []))
const shown = (c: Container) => ({ Name: c.Name, State: c.State, Config: c.Config, NetworkSettings: c.NetworkSettings })
const named = (name: string) => state.containers[name] ?? fail(`Error response from daemon: No such container: ${name}`)

if (existsSync(`${dir}/down`)) fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?")

switch (args[0] ?? "") {
  case "version":
    out("29.0.0\n")
    break
  case "ps": {
    const label = (flags("--filter")[0] ?? "").replace(/^label=/u, "")
    const [k, v] = [label.slice(0, label.indexOf("=")), label.slice(label.indexOf("=") + 1)]
    for (const c of Object.values(state.containers)) {
      if (c.Config.Labels[k] === v) out(`${c.Name.slice(1)}\t${c.State.Status === "running" ? "Up 1 second" : "Exited (0) 1 second ago"}\n`)
    }
    break
  }
  case "inspect": {
    const found = args.slice(1).flatMap((n) => (state.containers[n] === undefined ? [] : [shown(state.containers[n])]))
    out(`${JSON.stringify(found)}\n`)
    if (found.length < args.length - 1) process.exitCode = 1
    break
  }
  case "image":
    if (!state.images.includes(args.at(-1) ?? "")) fail(`Error: No such image: ${args.at(-1)}`)
    out("sha256:fake\n")
    break
  case "pull":
  case "build":
    if (args[0] === "build") stdin()
    state.images.push(args[0] === "pull" ? (args.at(-1) ?? "") : (flags("--tag")[0] ?? ""))
    save()
    break
  case "run": {
    const name = flags("--name")[0] ?? ""
    const labels = Object.fromEntries(flags("--label").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
    state.containers[name] = {
      Name: `/${name}`,
      State: { Status: "running" },
      Config: { Image: args.at(-1) ?? "", Env: flags("--env"), Labels: labels },
      NetworkSettings: { Ports: { "3211/tcp": [{ HostIp: "127.0.0.1", HostPort: port() }] } },
      files: {},
    }
    save()
    out(`${name}-id\n`)
    break
  }
  case "start":
  case "stop":
    named(args.at(-1) ?? "").State = { Status: args[0] === "start" ? "running" : "exited" }
    save()
    break
  case "rm":
    named(args.at(-1) ?? "")
    delete state.containers[args.at(-1) ?? ""]
    save()
    break
  case "exec": {
    const rest = args.slice(1).filter((a) => a !== "--interactive")
    const user = rest[0] === "--user" ? 2 : 0
    const c = named(rest[user] ?? "")
    if (c.State.Status !== "running") fail(`Error response from daemon: container ${rest[user]} is not running`)
    const argv = rest.slice(user + 1)
    if (argv[0] === "timeout") {
      const command = argv.at(-1) ?? ""
      out(`Linux space ${command}\n`)
      const code = /exit (\d+)/u.exec(command)?.[1]
      process.exitCode = code === undefined ? 0 : Number(code)
    } else {
      c.files[argv.at(-1) ?? ""] = stdin()
      save()
    }
    break
  }
  default:
    fail(`fake-docker: ${args[0]} isn't faked`, 2)
}
