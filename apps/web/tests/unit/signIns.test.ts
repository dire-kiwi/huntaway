import { describe, expect, it } from "@effect/vitest"
import { SIGN_INS_TOOL, signInsAnswer, signInsAsk } from "../../src/components/task/thread/signIns"

// HE-49: what the sign-ins card reads of `space_request_sign_ins`'s prompt, and what it sends back.

const input = {
  space: "s1",
  space_name: "Signed",
  browser: "chromium",
  browser_label: "Chromium",
  profile: "Default",
  profile_label: "Me",
  sites: ["github.com", "stray.com"],
  offered: [
    { site: "github.com", cookie_count: 9, storage_count: 2, identity_provider: false },
    { site: "google.com", cookie_count: 4, storage_count: 0, identity_provider: true },
  ],
  not_found: ["nothere.com"],
}

describe("the sign-ins card", () => {
  it("reads the prompt's Space, profile and offered sites; only offered sites start ticked", () => {
    const ask = signInsAsk(SIGN_INS_TOOL, input)
    expect(ask).toEqual({
      space: "Signed",
      browser: "Chromium",
      profile: "Me",
      offered: [
        { site: "github.com", cookies: 9, storage: 2, identity: false },
        { site: "google.com", cookies: 4, storage: 0, identity: true },
      ],
      ticked: ["github.com"],
      notFound: ["nothere.com"],
    })
    expect(signInsAsk("mcp__spaces__space_bash", input)).toBeNull()
  })

  it("answers with the input as asked and the sites left ticked", () => {
    expect(signInsAnswer(input, ["google.com"])).toEqual({ ...input, sites: ["google.com"] })
  })
})
