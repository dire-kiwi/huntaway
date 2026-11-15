import { Option, Schema } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { BoardMessage } from "../src/events.ts"
import { knownExperiments } from "../src/experiments.ts"
import { HostSettingsPatch } from "../src/host.ts"

// HE-22: a host's settings say which experiments are on. A host one version behind doesn't say, and one ahead may name
// an experiment this build doesn't have: its board must load all the same (docs/plan/05-protocol.md, Versions).

const settings = {
  default_model: null,
  default_effort: null,
  default_permission_mode: null,
  scratch_host: null,
  terminal_tools: [],
  public_url: null,
  release_prereleases: false,
  settings_sync: false,
}
const snapshot = (extra: object) => ({
  type: "snapshot",
  seq: 1,
  profiles: [],
  configs: [],
  projects: [],
  archived_projects: [],
  tasks: [],
  pens: [],
  settings: { ...settings, ...extra },
  usage: [],
  approvals: [],
})
/** A board message's settings, or null when it doesn't decode (or has none). */
const settingsOf = (input: unknown) => {
  const m = Option.getOrNull(Schema.decodeUnknownOption(BoardMessage)(input))
  return m !== null && "settings" in m ? m.settings : null
}
const decodePatch = (input: unknown) => Option.getOrNull(Schema.decodeUnknownOption(HostSettingsPatch)(input))

describe("experiments on the wire", () => {
  it("decodes a snapshot and a settings_changed from a host without the field, or with an experiment this build lacks", () => {
    const older = settingsOf(snapshot({}))
    expect(older).not.toBeNull()
    expect(older?.experiments).toBeUndefined()
    expect(knownExperiments(older?.experiments)).toEqual([])
    const newer = settingsOf(snapshot({ experiments: ["fold_turns", "from_the_future"] }))
    expect(newer?.experiments).toEqual(["fold_turns", "from_the_future"])
    expect(knownExperiments(newer?.experiments)).toEqual(["fold_turns"])
    const changed = settingsOf({ type: "settings_changed", seq: 2, settings: { ...settings, experiments: ["from_the_future"] } })
    expect(changed?.experiments).toEqual(["from_the_future"])
    expect(knownExperiments(changed?.experiments)).toEqual([])
  })

  it("keeps the same list when every id is known", () => {
    const ids = ["fold_turns"]
    expect(knownExperiments(ids)).toBe(ids)
  })

  it("takes only known ids in a patch", () => {
    expect(decodePatch({ experiments: ["fold_turns"] })).toEqual({ experiments: ["fold_turns"] })
    expect(decodePatch({ experiments: ["from_the_future"] })).toBeNull()
  })
})
