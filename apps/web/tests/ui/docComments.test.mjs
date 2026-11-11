// HA-302 (6.3): comments on a document's pages. Selecting text in the page (its sandboxed frame) offers "Comment", which
// quotes it in the Comments panel; a saved comment is listed there and highlighted in the page, and stays with the
// version it was made on. `--demo` seeds "Rollout plan" (two versions, published by DEMO-5). Sending them starts DEMO-5's
// agent, so this server runs the fake one.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { startServer, withBrowser } from "./harness.mjs"
import { demoProfile } from "./docs.mjs"

let server, profile
beforeAll(async () => {
  server = startServer("--demo", "--fake-claude")
  profile = await demoProfile(server)
})
afterAll(() => server?.stop())

const reader = (page) => page.frameLocator("iframe[title]").first()
/** The sizes of the frame's highlights: the comments', the chosen one's and the draft's. */
const highlights = (page) =>
  reader(page)
    .locator("body")
    .evaluate(() => ["ia-comment", "ia-comment-active", "ia-comment-draft"].map((n) => CSS.highlights.get(n)?.size ?? 0))

/** Waits (up to 5s) for the frame's highlights to be `want`, which they become as the board's messages reach it. */
async function waitHighlights(page, want) {
  let got
  for (let i = 0; i < 50; i++) {
    got = await highlights(page)
    if (JSON.stringify(got) === JSON.stringify(want)) return
    await page.waitForTimeout(100)
  }
  assert.deepEqual(got, want)
}

test("selecting text in a document's page comments on it, highlighted there and listed beside it", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /docs/Default/d/rollout-plan"])
    const frame = reader(page)
    const para = frame.locator("article p").first()
    await para.waitFor()
    const panel = page.getByRole("complementary", { name: "Comments" })
    await panel.getByText("Select text in the page to quote it").waitFor()

    // Select the paragraph's first words, as a reader would, by dragging over them. A frame that's just loaded may not
    // take the first drag yet, so it's tried again until there's a selection.
    const selected = () => frame.locator("body").evaluate(() => String(getSelection()))
    for (let i = 0; i < 5 && !(await selected()); i++) {
      const box = await para.boundingBox()
      await page.mouse.move(box.x + 1, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + 160, box.y + box.height / 2, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(100)
    }
    const button = frame.getByRole("button", { name: "Comment" })
    await button.waitFor()
    await button.click()
    const form = panel.getByRole("form", { name: "New comment" })
    await form.waitFor()
    const quote = await form.locator("blockquote").innerText()
    assert.match(quote, /^How the new board/)
    // The quote stays marked in the page while the comment's written.
    await waitHighlights(page, [0, 0, 1])
    await page.keyboard.type("Who signs this off?")
    await page.keyboard.press("Control+Enter")
    await form.waitFor({ state: "detached" })

    const item = panel.getByRole("listitem", { name: "Comment" })
    await item.getByText("Who signs this off?").waitFor()
    assert.equal(await item.locator("blockquote").innerText(), quote)
    assert.match(await item.innerText(), /not sent yet/)
    // Highlighted in the page, the draft's mark gone.
    await waitHighlights(page, [1, 0, 0])
    // Choosing it marks it in the page.
    await item.locator("blockquote").click()
    await waitHighlights(page, [1, 1, 0])

    // Edited in place.
    await item.getByRole("button", { name: "Edit comment" }).click()
    await page.keyboard.press("Control+a")
    await page.keyboard.type("Who signs this off, and when?")
    await page.keyboard.press("Control+Enter")
    await item.getByText("Who signs this off, and when?").waitFor()

    // Sent to the task that published the document, once.
    const send = panel.getByRole("button", { name: /Send 1 to the agent/ })
    assert.match(await send.getAttribute("title"), /to DEMO-5, the task that published this document/)
    await send.click()
    await panel.getByRole("status").getByText("DEMO-5").waitFor()
    await item.getByText("· sent").waitFor()
    assert.equal(await panel.getByRole("button", { name: /Send .*to the agent/ }).isDisabled(), true)
    const [stored] = (await server.rpc("docs.comments", { profile_id: profile.id, slug: "rollout-plan" })).comments
    assert.deepEqual([stored.version, stored.page, stored.comment, stored.sent_at !== null], [2, "index", "Who signs this off, and when?", true])

    // It belongs to version 2: version 1 lists it among the other versions', and opens it from there.
    await page.getByRole("combobox", { name: "Version" }).selectOption("1")
    const other = panel.getByText("1 comment on other versions")
    await other.waitFor()
    assert.equal(await panel.getByRole("listitem", { name: "Comment" }).count(), 0)
    await other.click()
    await panel.getByTitle("Open v2 · index").click()
    await item.waitFor()
    assert.equal(await page.getByRole("combobox", { name: "Version" }).inputValue(), "2")

    // Deleted, it's gone from the list and the page.
    await item.getByRole("button", { name: "Delete comment" }).click()
    await item.waitFor({ state: "detached" })
    await waitHighlights(page, [0, 0, 0])
  })
})
