import { assert, describe, it } from "@effect/vitest"
import { checkTarget, sshArgs } from "./Ssh.ts"

// The old hosts/ssh.test.ts's pure case (HA-341, from the 10-31 review): a target starting with `-` went to ssh as an
// option (`-oProxyCommand=…` ran a command). It is refused on input and again when the arguments are built. The
// `ssh-host` cases (HA-271, HA-278) are whole-server tests in tests/e2e/hosts.test.ts.

describe("an SSH target", () => {
  it("is never an option", () => {
    const refused = checkTarget("-oProxyCommand=touch /tmp/x@y")
    assert.isTrue(typeof refused !== "string" && refused.reason.includes("can't start with -"))
    assert.throws(() => sshArgs("/d", { target: "-oProxyCommand=x@y", ssh_port: 22, remote_port: 7879 }, []), /starts with -/)
    assert.deepStrictEqual(sshArgs("/d", { target: "me@box", ssh_port: 22, remote_port: 7879 }, ["true"]).slice(-2), ["me@box", "true"])
  })

  it("is user@host, trimmed", () => {
    assert.strictEqual(checkTarget("  me@box "), "me@box")
    assert.notStrictEqual(typeof checkTarget("box"), "string")
    assert.notStrictEqual(typeof checkTarget("me@box; rm"), "string")
  })

  it("is reached with the hub's own key and known hosts, in batch mode, on its port", () => {
    assert.deepStrictEqual(sshArgs("/data/ssh", { target: "me@box", ssh_port: 2222, remote_port: 7879 }, ["link"]), [
      "-i",
      "/data/ssh/id_ed25519",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "UserKnownHostsFile=/data/ssh/known_hosts",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-p",
      "2222",
      "me@box",
      "link",
    ])
  })
})
