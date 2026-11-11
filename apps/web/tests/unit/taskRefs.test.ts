import { describe, expect, it } from "@effect/vitest"
import type { HostProfile, HostProject, HostTask } from "@huntaway/client"
import { HostId, ProfileId, ProjectId, TaskId } from "@huntaway/contracts"
import { fromMarkdown } from "mdast-util-from-markdown"
import { remarkTaskRefs, resolveTaskRef } from "../../src/components/task/thread/taskRefs"
import { profile as wireProfile, project as wireProject, task as wireTask } from "../../../../packages/client/test/fixtures"

// The old tests/taskRefs.test.ts: task keys in agents' messages open the task (HA-307).

/** A node of the tree as the plugin leaves it: a marked key has the tag and its properties for the page. */
interface Marked {
  readonly data?:
    | { readonly hName?: string | undefined; readonly hProperties?: { readonly taskKey?: unknown; readonly profile?: unknown } | undefined }
    | undefined
  readonly value?: string | undefined
  readonly children?: ReadonlyArray<Marked> | undefined
}

/** The keys the plugin marks in `md`, as [key, profile, text]. */
function refs(md: string): Array<Array<string | undefined>> {
  const tree = fromMarkdown(md)
  remarkTaskRefs()(tree)
  const out: Array<Array<string | undefined>> = []
  const visit = (n: Marked) => {
    const props = n.data?.hProperties
    if (n.data?.hName === "task-ref") out.push([String(props?.taskKey), String(props?.profile), n.value])
    n.children?.forEach(visit)
  }
  visit(tree)
  return out
}

const H = HostId.make("h")
const onH = { host_id: H }
const profile = (id: string, name: string): HostProfile => Object.assign(wireProfile({ id: ProfileId.make(id), name }), onH)
const project = (id: string, profile_id: string, key: string, former_keys: ReadonlyArray<string> = []): HostProject =>
  Object.assign(wireProject({ id: ProjectId.make(id), profile_id: ProfileId.make(profile_id), key, former_keys }), onH)
const task = (id: string, project_id: string, profile_id: string, number: number, kind: "task" | "review" = "task"): HostTask =>
  Object.assign(wireTask({ id: TaskId.make(id), project_id: ProjectId.make(project_id), profile_id: ProfileId.make(profile_id), number, kind, title: id }), onH)

const profiles = [profile("personal", "personal"), profile("work", "work")]
const projects = [project("ha", "personal", "HA", ["IA"]), project("ha2", "work", "HA"), project("sd", "work", "SD")]
const tasks = {
  mine: task("mine", "ha", "personal", 12),
  theirs: task("theirs", "ha2", "work", 12),
  sd: task("sd", "sd", "work", 3),
  review: task("review", "sd", "work", 4, "review"),
}
const board = { tasks, profiles, projects }
const id = (key: string, profileName: string, near: HostTask | undefined, active: string | null) =>
  resolveTaskRef(board, key, profileName, near, active)?.task.id ?? null

describe("task keys in Markdown", () => {
  it("marks task keys in text, but not in code, links, words or paths", () => {
    expect(refs("See HA-12, and work:SD-3.")).toEqual([
      ["HA-12", "", "HA-12"],
      ["SD-3", "work", "work:SD-3"],
    ])
    expect(refs("**HA-1** and _(HA-2)_\n\n- HA-3")).toEqual([
      ["HA-1", "", "HA-1"],
      ["HA-2", "", "HA-2"],
      ["HA-3", "", "HA-3"],
    ])
    expect(refs("`HA-1` [HA-2](https://x) https://x.y/t/HA-3 /t/HA-4 a.HA-5 HA-6-x HA-7.ts AHA-8a\n\n```\nHA-9\n```")).toEqual([])
    expect(refs("ends with HA-10.")).toEqual([["HA-10", "", "HA-10"]])
    expect(refs("0d290bc4-2c3e:SD-3"), "a profile's id before it").toEqual([["SD-3", "0d290bc4-2c3e", "0d290bc4-2c3e:SD-3"]])
  })

  it("finds the task a key names, beside the open task first, then in the active profile", () => {
    expect(id("HA-12", "", tasks.theirs, "personal"), "the open task's profile first").toBe("theirs")
    expect(id("HA-12", "", tasks.mine, "work")).toBe("mine")
    expect(id("HA-12", "", undefined, "work"), "then the profile the sidebar lists").toBe("theirs")
    expect(id("HA-12", "work", tasks.mine, "personal"), "a profile's name picks its task").toBe("theirs")
    expect(id("IA-12", "", undefined, null), "a project's former key still names its tasks").toBe("mine")
    expect(id("ha-12", "", undefined, null)).not.toBeNull()
    expect(id("SD-3", "", tasks.mine, "personal"), "a key in another profile only").toBe("sd")
    expect(id("HA-99", "", undefined, null), "no such task").toBeNull()
    expect(id("SD-4", "", undefined, null), "review threads aren't named by keys").toBeNull()
    expect(resolveTaskRef(board, "SD-3", "fix", undefined, null)?.qualified, "a word that isn't a profile isn't part of it").toBe(false)
    expect(resolveTaskRef(board, "SD-3", "work", undefined, null)?.qualified).toBe(true)
  })

  it("a profile's id names it too, as `@` completion puts it for a name with spaces", () => {
    const ops = {
      profiles: [...profiles, profile("4f2a-ops", "Ops team")],
      projects: [...projects, project("sd2", "4f2a-ops", "SD")],
      tasks: { ...tasks, ops: task("ops", "sd2", "4f2a-ops", 3) },
    }
    expect(resolveTaskRef(ops, "SD-3", "4f2a-ops", tasks.sd, null)?.task.id).toBe("ops")
    expect(resolveTaskRef(ops, "SD-3", "ops team", tasks.sd, null)?.task.id).toBe("ops")
    expect(resolveTaskRef(ops, "SD-3", "", tasks.sd, null)?.task.id).toBe("sd")
  })
})
