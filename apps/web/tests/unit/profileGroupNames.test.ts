import { assert, describe, it } from "@effect/vitest"
import type { HostProject } from "@huntaway/client"
import { HostId, ProfileId, ProjectId } from "@huntaway/contracts"
import { profileGroupNames } from "../../src/projectGroups"
import { project as wireProject } from "../../../../packages/client/test/fixtures"

// HE-108: a project's menu offers the groups of its own profile, not another profile's.

const project = (id: string, profile_id: string, group_name: string | null, host_id = "h1"): HostProject =>
  Object.assign(wireProject({ id: ProjectId.make(id), profile_id: ProfileId.make(profile_id), group_name }), { host_id: HostId.make(host_id) })

describe("the groups a project can be put in", () => {
  it("are its own profile's on its own host", () => {
    const projects = [
      project("a", "work", "Clients"),
      project("b", "personal", "Hobbies"),
      project("c", "work", "Internal"),
      project("d", "work", null),
      project("e", "work", "Elsewhere", "h2"),
    ]
    assert.deepStrictEqual(profileGroupNames(projects, project("d", "work", null)), ["Clients", "Internal"])
    assert.deepStrictEqual(profileGroupNames(projects, project("x", "personal", null)), ["Hobbies"])
  })
})
