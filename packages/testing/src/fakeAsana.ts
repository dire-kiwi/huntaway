import { Effect } from "effect"
import { startFakeAsana } from "../bin/fake-asana.ts"
import type { FakeAsanaData } from "../bin/fake-asana.ts"

// 6.11: the fake Asana API of bin/fake-asana.ts (what it has and answers is said there) for a test's scope. Give its URL
// to the server (`ServerConfig.asanaUrl`, `HUNTAWAY_ASANA_URL`).

export { ASANA_TOKEN, asanaTaskJson, DEFAULT_ASANA } from "../bin/fake-asana.ts"
export type { FakeAsanaData } from "../bin/fake-asana.ts"

/** A fake Asana on a free port of 127.0.0.1 for the scope: its base URL. */
export const fakeAsana = (data?: FakeAsanaData) =>
  Effect.acquireRelease(
    Effect.promise(() => startFakeAsana(data)),
    (s) => Effect.sync(s.close),
  ).pipe(Effect.map((s) => s.url))
