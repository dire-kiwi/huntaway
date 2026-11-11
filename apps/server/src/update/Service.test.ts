import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer } from "effect"
import type { Scope } from "effect"
import { tempDir, TestBoard } from "@huntaway/testing"
import { spawnSync } from "node:child_process"
import type { ServerConfigShape } from "../platform/ServerConfig.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { Restarts } from "./Restarts.ts"
import { install, keptEnv, Service, serviceOf, thisServer, unitName, unitText } from "./Service.ts"
import type { Spec } from "./Service.ts"
import { Supervisor } from "./Supervisor.ts"
import { Systemd } from "./Systemd.ts"
import type { CtlResult } from "./Systemd.ts"

// The old update/service.test.ts's cases. systemctl and loginctl are a `Systemd` test layer and the unit folder is in
// the test's config folder: no test touches this machine's units or lingering.

const spec = (more: Partial<Spec> = {}): Spec => ({
  exe: "/opt/huntaway/huntaway",
  args: ["serve", "--host", "127.0.0.1", "--port", "7878"],
  env: [["HUNTAWAY_RELEASE_UPDATES", "dire-kiwi/huntaway"]],
  shell: "/bin/bash",
  cwd: "/home/me",
  port: 7878,
  ...more,
})

const text = (s: Spec) => {
  const t = unitText(s)
  return "text" in t ? t.text : assert.fail(t.refused)
}

/** The service on a board in a temp folder, with a fake systemd that says `answer` and records what it was asked. */
const host = (
  options: { readonly booted?: boolean; readonly lingering?: boolean; readonly answer?: (p: string, args: ReadonlyArray<string>) => CtlResult } = {},
  config: Partial<ServerConfigShape> = {},
) =>
  Effect.gen(function* () {
    const calls: Array<string> = []
    const layer = Layer.fresh(Service.layer).pipe(
      Layer.provideMerge(Layer.fresh(Restarts.layer)),
      Layer.provideMerge(
        Layer.mergeAll(
          Supervisor.layerTest(() => Effect.void),
          Systemd.layerTest({
            booted: options.booted ?? true,
            lingering: options.lingering ?? false,
            ...(options.answer === undefined ? {} : { answer: options.answer }),
            called: (l) => void calls.push(l),
          }),
        ),
      ),
      Layer.provideMerge(TestBoard({ port: 7878, ...config })),
    )
    const context = yield* Layer.build(layer)
    const config_ = Context.get(context, ServerConfig)
    const run = <A, E>(effect: Effect.Effect<A, E, ServerConfig | Systemd | FileSystem.FileSystem>) => Effect.provideContext(effect, context)
    return { service: Context.get(context, Service), calls, configHome: config_.configHome, run }
  })

const live = <A, E>(name: string, test: () => Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
  it.live(name, () => test().pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 30_000)

describe("the unit", () => {
  it("unit_names_go_by_port", () => {
    assert.strictEqual(unitName(7878), "huntaway-7878.service")
    assert.strictEqual(unitName(7900), "huntaway-7900.service")
  })

  it("service_of_reads_the_unit_from_the_cgroup", () => {
    assert.deepStrictEqual(serviceOf("0::/user.slice/user-1000.slice/user@1000.service/app.slice/huntaway-7878.service\n"), {
      unit: "huntaway-7878.service",
      user: true,
    })
    assert.deepStrictEqual(serviceOf("0::/system.slice/huntaway.service\n"), { unit: "huntaway.service", user: false })
    // A login session, or an app's scope in the user manager, isn't a service.
    assert.isNull(serviceOf("0::/user.slice/user-1000.slice/session-254.scope\n"))
    assert.isNull(serviceOf("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-foot-1.scope\n"))
    assert.isNull(serviceOf(""))
    // cgroup v1.
    assert.deepStrictEqual(serviceOf("12:pids:/x\n1:name=systemd:/user.slice/user-1000.slice/user@1000.service/huntaway-7900.service\n"), {
      unit: "huntaway-7900.service",
      user: true,
    })
  })

  it("kept_env_keeps_the_servers_settings_not_one_starts", () => {
    const env: ReadonlyArray<readonly [string, string]> = [
      ["HUNTAWAY_RELEASE_UPDATES", "o/r"],
      ["HUNTAWAY_DATA_DIR", "/d"],
      ["HUNTAWAY_RESTART_FILE", "/tmp/x/next"],
      ["HUNTAWAY_BUNDLED_SERVER", "/a"],
      ["HUNTAWAY_DESKTOP_SHELL", "1"],
      ["HUNTAWAY_SKIP_DB_BACKUP_ONCE", "1"],
      ["HUNTAWAY_EXE", "/x/huntaway"],
      ["PATH", "/bin"],
    ]
    assert.deepStrictEqual(keptEnv(env), [
      ["HUNTAWAY_DATA_DIR", "/d"],
      ["HUNTAWAY_RELEASE_UPDATES", "o/r"],
    ])
  })

  it("unit_text_quotes_for_systemd_and_the_shell", () => {
    const t = text(
      spec({ exe: "/home/a b/it's/huntaway", args: ["serve", "--name", 'my "box" 100%', "--data-dir", "/d/$HOME"], env: [["HUNTAWAY_TOKEN", 'a"b%c$d\\e']] }),
    )
    assert.match(t, /^KillMode=process$/m)
    assert.match(t, /^WantedBy=default\.target$/m)
    assert.match(t, /^Restart=on-failure$/m)
    assert.match(t, /^RestartSec=5$/m)
    // Environment=: C escapes and %%, but $ is left alone (systemd doesn't expand it there).
    assert.match(t, /^Environment="HUNTAWAY_TOKEN=a\\"b%%c\$d\\\\e"$/m)
    assert.strictEqual(
      t.split("\n").find((l) => l.startsWith("ExecStart=")),
      `ExecStart="/bin/bash" -lc "exec '/home/a b/it'\\\\''s/huntaway' 'serve' '--name' 'my \\"box\\" 100%%' '--data-dir' '/d/$$HOME'"`,
    )
    const refused = unitText(spec({ args: ["serve", "--name", "a\nb"] }))
    assert.include("refused" in refused ? refused.refused : "", "can't go in a unit file")
  })

  it("the_unit_runs_in_the_folder_the_server_was_started_in", () => {
    assert.match(text(spec({ args: ["serve", "--data-dir", "board"], cwd: "/home/me/hosts/100% a" })), /^WorkingDirectory=-\/home\/me\/hosts\/100%% a$/m)
  })
})

/** The service where this process is in `cgroup`. */
const withCgroup = (cgroup: string) =>
  Layer.fresh(Service.layer).pipe(
    Layer.provideMerge(Layer.fresh(Restarts.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        Supervisor.layerTest(() => Effect.void),
        Systemd.layerTest({ booted: true, cgroup }),
      ),
    ),
    Layer.provideMerge(TestBoard({ port: 7878 })),
  )

/** The service status where this process is in `cgroup`. */
const statusIn = (cgroup: string) => Effect.flatMap(Layer.build(withCgroup(cgroup)), (c) => Context.get(c, Service).status)

describe("installing", () => {
  live("install_writes_and_enables_the_unit_and_turns_lingering_on", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { run, calls, configHome } = yield* host()
      const said: Array<string> = []
      const st = yield* run(install(spec(), (l) => Effect.sync(() => said.push(l))))
      const path = `${configHome}/systemd/user/huntaway-7878.service`
      assert.deepStrictEqual([st.path, st.installed], [path, true])
      assert.strictEqual((yield* fs.stat(path)).mode & 0o777, 0o600)
      assert.match(yield* fs.readFileString(path), /exec '\/opt\/huntaway\/huntaway' 'serve' '--host' '127\.0\.0\.1' '--port' '7878'/)
      assert.deepStrictEqual(calls, ["loginctl enable-linger", "systemctl --user daemon-reload", "systemctl --user enable huntaway-7878.service"])
      assert.isTrue(said[0]?.startsWith("wrote "))
    }),
  )

  live("install_says_when_lingering_cant_be_turned_on_and_carries_on", () =>
    Effect.gen(function* () {
      const { run, calls } = yield* host({ answer: (p) => (p === "loginctl" ? { success: false, out: "Access denied" } : { success: true, out: "" }) })
      const said: Array<string> = []
      yield* run(install(spec(), (l) => Effect.sync(() => said.push(l))))
      assert.isTrue(
        said.some((l) => l.includes("Access denied") && l.includes("sudo loginctl enable-linger")),
        said.join("\n"),
      )
      assert.include(calls, "systemctl --user enable huntaway-7878.service")
    }),
  )

  live("install_fails_with_systemctls_error", () =>
    Effect.gen(function* () {
      const { run } = yield* host({
        lingering: true,
        answer: (_, args) => (args.includes("enable") ? { success: false, out: "it failed" } : { success: true, out: "" }),
      })
      const e = yield* Effect.flip(run(install(spec(), () => Effect.void)))
      assert.strictEqual(e.reason, "systemctl --user enable huntaway-7878.service failed: it failed")
    }),
  )

  live("status_is_none_without_systemd_or_from_the_desktop_app", () =>
    Effect.gen(function* () {
      assert.isNull(yield* (yield* host({ booted: false })).service.status)
      assert.isNotNull(yield* (yield* host()).service.status)
      assert.isNull(yield* (yield* host({}, { desktopVersion: "0.5.0" })).service.status)
      // Nor for a server on a port picked at random.
      assert.isNull(yield* (yield* host({}, { port: 0 })).service.status)
    }),
  )

  live("status_says_whether_the_unit_is_installed_and_enabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { service, run, configHome } = yield* host({}, { port: 7900 })
      let st = yield* service.status
      assert.deepStrictEqual([st?.unit, st?.installed, st?.enabled, st?.running], ["huntaway-7900.service", false, false, false])
      yield* run(install(spec({ port: 7900 }), () => Effect.void))
      // `enable` links it into default.target.wants (the fake doesn't).
      const wants = `${configHome}/systemd/user/default.target.wants`
      yield* fs.makeDirectory(wants, { recursive: true })
      yield* fs.symlink(`${configHome}/systemd/user/huntaway-7900.service`, `${wants}/huntaway-7900.service`)
      st = yield* service.status
      assert.deepStrictEqual([st?.installed, st?.enabled], [true, true])
    }),
  )

  live("a server running as its unit says so, and one run by another says which", () =>
    Effect.gen(function* () {
      const user = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/huntaway-7878.service\n"
      assert.deepStrictEqual([(yield* statusIn(user))?.running, (yield* statusIn(user))?.other], [true, null])
      assert.strictEqual((yield* statusIn("0::/system.slice/other.service\n"))?.other, "other.service (system)")
    }),
  )

  live("install_and_switch_needs_bin_huntaway", () =>
    Effect.gen(function* () {
      const { service } = yield* host()
      const e = yield* Effect.flip(service.installAndSwitch)
      assert.include(e._tag === "Unavailable" ? e.reason : e._tag, "wasn't started by bin/huntaway")
    }),
  )
})

/** A test server's configuration started with `args`. */
const configOf = (args: ReadonlyArray<string>, more: Partial<ServerConfigShape> = {}) =>
  Effect.gen(function* () {
    const dir = yield* tempDir
    const layer = TestBoard({ dataDir: dir, args, cwd: "/home/me/hosts/a", huntawayEnv: [["HUNTAWAY_DATA_DIR", "board"]], ...more })
    return Context.get(yield* Layer.build(layer), ServerConfig)
  })

describe("the server's own unit", () => {
  // A server started on `--port 0` (as test servers are) got a unit that took another free port.
  live("this_server_runs_on_the_port_it_has", () =>
    Effect.gen(function* () {
      const s = thisServer(yield* configOf(["serve", "--host", "127.0.0.1", "--port", "0"]), "/x/huntaway", 7900)
      assert.deepStrictEqual(s.args, ["serve", "--host", "127.0.0.1", "--port", "7900"])
      assert.deepStrictEqual([s.port, s.cwd, s.exe, s.env], [7900, "/home/me/hosts/a", "/x/huntaway", [["HUNTAWAY_DATA_DIR", "board"]]])
      assert.match(text(s), /^WorkingDirectory=-\/home\/me\/hosts\/a$/m)
    }),
  )

  // A server started as bare `huntaway` got a unit running `huntaway --port N`, which isn't a command.
  live("this_server_names_serve_for_a_server_started_without_arguments", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(thisServer(yield* configOf([]), "/x", 7878).args, ["serve", "--port", "7878"])
      assert.deepStrictEqual(thisServer(yield* configOf(["--port=7000"]), "/x", 7878).args, ["serve", "--port", "7878"])
    }),
  )

  live("names the release the host was installed as, not the one it updated to", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        thisServer(yield* configOf(["serve"], { bundledServer: "/opt/huntaway/huntaway" }), "/data/app/0.2.0/huntaway", 7878).exe,
        "/opt/huntaway/huntaway",
      )
    }),
  )

  // systemd's own parser, where it's installed: it says nothing about a unit it reads as written. It only reads the file.
  live("systemd_reads_the_unit_without_complaint", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tempDir
      const cwd = `${dir}/100% a b`
      yield* fs.makeDirectory(cwd)
      const file = `${dir}/huntaway-7999.service`
      yield* fs.writeFileString(
        file,
        text(spec({ exe: "/bin/true", shell: "/bin/sh", cwd, port: 7999, env: [["HUNTAWAY_X", 'a"b%c$d\\e']], args: ["serve", "--name", "it's 100%"] })),
      )
      const r = spawnSync("systemd-analyze", ["verify", file], { encoding: "utf8" })
      if (r.error !== undefined) return
      const mine = `${r.stdout}${r.stderr}`.split("\n").filter((l) => l.includes(file) || l.includes("huntaway-7999.service"))
      assert.deepStrictEqual(mine, [])
    }),
  )
})
