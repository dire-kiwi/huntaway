import { describe, expect, it } from "@effect/vitest"
import { dictated, errorMessage, fallsBack, hear, languageOf, SILENCE } from "../src/logic/dictation"

describe("dictation", () => {
  it("puts what is heard after what was typed, a stretch at a time", () => {
    // The recogniser changes its mind about the stretch being said, then is done with it.
    const first = hear(hear(SILENCE, "fix the", false), "fix the login", false)
    expect(dictated("", first)).toBe("fix the login")
    const done = hear(first, " Fix the login page. ", true)
    expect(done).toEqual({ said: "Fix the login page.", saying: "" })
    const next = hear(done, "then run", false)
    expect(dictated("", next)).toBe("Fix the login page. then run")
    expect(dictated("Please", next)).toBe("Please Fix the login page. then run")
    expect(dictated("Please\n", hear(next, "Then run the tests.", true))).toBe("Please\nFix the login page. Then run the tests.")
  })

  it("leaves the field as it was while nothing is heard", () => {
    expect(dictated("typed ", SILENCE)).toBe("typed ")
    expect(dictated("typed", hear(SILENCE, "  ", false))).toBe("typed")
    expect(hear(SILENCE, "", true)).toEqual(SILENCE)
  })

  it("tries the phone's service when the phone itself can't listen", () => {
    expect(fallsBack("language-not-supported")).toBe(true)
    expect(fallsBack("service-not-allowed")).toBe(true)
    expect(fallsBack("network")).toBe(false)
    expect(fallsBack("not-allowed")).toBe(false)
  })

  it("says why a dictation failed, and nothing when it was only stopped or silent", () => {
    expect(errorMessage("aborted", "")).toBeNull()
    expect(errorMessage("no-speech", "No speech detected")).toBeNull()
    expect(errorMessage("speech-timeout", "")).toBeNull()
    expect(errorMessage("not-allowed", "x")).toContain("microphone")
    expect(errorMessage("network", "x")).toContain("couldn't reach")
    expect(errorMessage("client", " Something odd ")).toBe("Something odd")
    expect(errorMessage("unknown", "")).toBe("The phone's speech recognition failed.")
  })

  it("listens for the phone's language", () => {
    expect(languageOf("en-NZ")).toBe("en-NZ")
    expect(languageOf("en_NZ")).toBe("en-NZ")
    expect(languageOf("zh-Hans-CN")).toBe("zh-Hans-CN")
    expect(languageOf("")).toBe("en-US")
    expect(languageOf(undefined)).toBe("en-US")
    expect(languageOf("C.UTF-8")).toBe("en-US")
  })
})
