import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { Atom } from "effect/reactivity"

// Which UI build the server serves (docs/plan/09-frontend.md, "An open tab detects a new build and offers a reload").

/** A page's entry scripts: each UI build gives them new hashed names. */
export function entryScripts(doc: Document): string {
  const scripts = [...doc.querySelectorAll<HTMLScriptElement>("script[type=module][src]")]
  return scripts.map((s) => s.getAttribute("src")).join(" ")
}

/** The UI build this page runs. */
export const loadedUiBuild: string = entryScripts(document)

/** The page's own origin, asked without the browser's cache. */
const pageRuntime = Atom.runtime(Layer.merge(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store" })))

/** The UI build the server serves at `/` now ("" when it doesn't answer with a page). Refresh it to look again. */
export const servedUiBuildAtom = pageRuntime.atom(
  HttpClient.get("/").pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((res) => res.text),
    Effect.map((html) => entryScripts(new DOMParser().parseFromString(html, "text/html"))),
    Effect.orElseSucceed(() => ""),
  ),
)
