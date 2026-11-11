import { Effect } from "effect"
import { Base64 } from "effect/encoding"
import type { ProfileId, Task } from "@huntaway/contracts"
import type { PublishInput } from "./publish.ts"

// The demo board's published document (huntaway's demo.ts `seed_doc`), which `--demo` seeds (lifecycle/Demo.ts) by
// `Docs.seedDemo`: "Rollout plan" in two versions, the second merged into the first, in its project's folder, with a
// label and an image, as an agent of the task in review would have published it.

/** Its versions' messages and pages. A merge keeps the carried-over pages' positions, so they give their menu order. */
const VERSIONS: ReadonlyArray<{
  readonly message: string
  readonly pages: ReadonlyArray<{ readonly path: string; readonly content: string; readonly format?: string }>
}> = [
  {
    message: "First draft of the rollout plan",
    pages: [
      {
        path: "index",
        content:
          "---\norder: 0\n---\n# Rollout plan\n\nHow the new board ships, in two phases. See [Phase 1](plan/phase-1) for the details, " +
          "and [the notes](notes) for open questions.\n\n## Goals\n\n- Every profile has its own documents.\n- Agents publish them as they work.\n\n" +
          "![Progress by phase](images/progress.avif)\n\n" +
          "Pages render as in [the docs app](https://github.com/dire-kiwi/docs).\n",
      },
      { path: "plan/index", content: "---\norder: 1\n---\n# Phases\n\nThe rollout is split into phases:\n\n1. [Phase 1](phase-1): the store.\n" },
      {
        path: "plan/phase-1",
        content: "---\norder: 2\n---\n# Phase 1\n\nThe document store and the agents' `docs` server.\n\n## Steps\n\n1. Store versions.\n2. Render pages.\n",
      },
    ],
  },
  {
    message: "Add phase 2 and the open questions",
    pages: [
      {
        path: "plan/index",
        content:
          "---\norder: 1\n---\n# Phases\n\nThe rollout is split into phases:\n\n1. [Phase 1](phase-1): the store.\n2. [Phase 2](phase-2): the board's page.\n",
      },
      {
        path: "plan/phase-2",
        content: "---\norder: 3\n---\n# Phase 2\n\nThe board's Docs page: the list, the menu, the versions.\n\n[Back to the plan](../)\n",
      },
      {
        path: "notes",
        format: "mdx",
        content:
          '---\norder: 4\n---\n# Notes\n\n<Callout type="warning">Forms in local documents collect no answers.</Callout>\n\n' +
          '<Approval />\n\n<TextInput name="why" label="Anything to add?" />\n',
      },
    ],
  },
]

/** The document's image: a bar chart, drawn here and rasterised, then converted to AVIF as an agent's upload would be. */
const PROGRESS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200" viewBox="0 0 480 200">
<rect width="480" height="200" rx="10" fill="#16161d"/>
<text x="24" y="36" fill="#e6e6ec" font-family="sans-serif" font-size="16">Progress by phase</text>
<text x="24" y="86" fill="#9a9aab" font-family="sans-serif" font-size="13">Phase 1</text>
<rect x="100" y="70" width="340" height="24" rx="4" fill="#33333f"/><rect x="100" y="70" width="340" height="24" rx="4" fill="#34d399"/>
<text x="24" y="146" fill="#9a9aab" font-family="sans-serif" font-size="13">Phase 2</text>
<rect x="100" y="130" width="340" height="24" rx="4" fill="#33333f"/><rect x="100" y="130" width="150" height="24" rx="4" fill="#7c7cf8"/>
</svg>`

/** The image as a PNG, in base64. */
const progressPng = Effect.promise(() =>
  import("sharp").then((m) =>
    m
      .default(new TextEncoder().encode(PROGRESS_SVG))
      .png()
      .toBuffer()
      .then((b) => Base64.encode(new Uint8Array(b.buffer, b.byteOffset, b.length))),
  ),
)

/** The demo document's publishes, in order, for `task`'s profile in `folder`. */
export const demoPublishes = (folder: string) =>
  Effect.map(progressPng, (png): ReadonlyArray<PublishInput> =>
    VERSIONS.map((v, n) => ({
      slug: "rollout-plan",
      title: null,
      message: v.message,
      mode: "merge",
      folder,
      delete_paths: [],
      // So the Docs page's Labels view has one to show.
      labels: ["plans/releases"],
      pages: v.pages,
      // The first version's (the second keeps it, as a merge does).
      images: n === 0 ? [{ name: "images/progress.avif", data: png }] : [],
    })),
  )

/** Who publishes the demo document. */
export const demoCaller = (profile: ProfileId, task: Task) => ({ profile, task, run: null })
