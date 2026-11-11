import { assert, describe, it } from "@effect/vitest"
import { ProfileId, ProjectId, TaskId, Timestamp } from "@huntaway/contracts"
import type { MentionBoard } from "./mentions.ts"
import { mentionsNote } from "./mentions.ts"

// What a prompt is told of the projects and tasks it names by key (huntaway's agent/runner/mentions.test.ts), on the
// pure builder: the board is the rows the service would load for the keys.

const me = ProfileId.make("me")
const work = ProfileId.make("work")
const secret = ProfileId.make("secret")

const project = (id: string, profile_id: ProfileId, key: string, name: string, repo_path: string) => ({
  id: ProjectId.make(id),
  profile_id,
  key,
  name,
  repo_path,
  archived_at: null,
})

const task = (id: string, profile_id: ProfileId, project_id: string | null, number: number, title: string, status: "todo" | "in_review") => ({
  id: TaskId.make(id),
  profile_id,
  project_id: project_id === null ? null : ProjectId.make(project_id),
  number,
  title,
  status,
})

const board: MentionBoard = {
  profiles: [
    { id: me, name: "personal", agent_access: [] },
    { id: work, name: "work", agent_access: ["personal"] },
    { id: secret, name: "secret", agent_access: [] },
  ],
  projects: [
    project("ha", me, "HA", "Huntaway", "/src/huntaway"),
    project("sd", work, "SD", "Site deploy", "/src/sd"),
    project("sec", secret, "SEC", "Secrets", "/src/sec"),
  ],
  tasks: [
    task("own", me, "ha", 1, "This one", "todo"),
    task("other", me, "ha", 2, "Fix the board", "in_review"),
    task("theirs", work, "sd", 1, "Deploy previews", "todo"),
    task("hidden", secret, "sec", 1, "Hidden", "todo"),
    task("notes", me, null, 3, "Notes", "todo"),
  ],
}

const own = { id: TaskId.make("own"), profile_id: me }
const theirs = { id: TaskId.make("theirs"), profile_id: work }

describe("mentionsNote", () => {
  it("says what the keys in a prompt name", () => {
    assert.strictEqual(
      mentionsNote(own, "Look at HA and HA-2, then work:SD-1. HA again.", board),
      "\n\n[Mentions, from the board:\n" +
        '- HA: project "Huntaway" (repository /src/huntaway)\n' +
        '- HA-2: task "Fix the board" in project "Huntaway" (in review)\n' +
        '- work:SD-1: task "Deploy previews" in project "Site deploy" on profile work\'s board (todo)]',
    )
    assert.isTrue(mentionsNote(own, "see work:SD", board).includes('- work:SD: project "Site deploy" on profile work\'s board (repository /src/sd)'))
    // A scratch task in no project, by its `S-` key.
    assert.strictEqual(mentionsNote(own, "S-3", board), '\n\n[Mentions, from the board:\n- S-3: task "Notes" (todo)]')
  })

  it("names nothing the profile's agents can't use or that isn't written as a key", () => {
    // A board that doesn't let it in, qualified or not; another board's key unqualified; its own task; an unknown number.
    for (const text of ["secret:SEC secret:SEC-1 SEC", "SD SD-1", "HA-1", "HA-99 nope:HA"]) assert.strictEqual(mentionsNote(own, text, board), "", text)
    // Lower case, a longer word, a path, an address, another token.
    assert.strictEqual(mentionsNote(own, "ha Ha HAT XHA src/HA/x HA/x me@HA #HA !HA", board), "")
    // work's agents aren't let into personal's board.
    assert.strictEqual(mentionsNote(theirs, "personal:HA HA", board), "")
    // An archived project isn't on the board.
    const archived = { ...board, projects: board.projects.map((p) => (p.key === "HA" ? { ...p, archived_at: Timestamp.make("2026-11-11T00:00:00Z") } : p)) }
    assert.strictEqual(mentionsNote(own, "HA", archived), "")
  })

  it("describes at most twelve", () => {
    const many: MentionBoard = {
      ...board,
      projects: Array.from({ length: 14 }, (_, i) => project(`p${i}`, me, `K${i}`, `P${i}`, `/p${i}`)),
    }
    const note = mentionsNote(own, many.projects.map((p) => p.key).join(" "), many)
    assert.strictEqual(note.split("\n- ").length - 1, 12)
  })
})
