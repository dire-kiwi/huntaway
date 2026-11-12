import { Effect, Option, Result, Schema } from "effect"
import { Tool } from "effect/ai"
import { Docs } from "../../docs/Docs.ts"
import type { DocsRefused } from "../../docs/Docs.ts"
import { DocsRender } from "../../docs/DocsRender.ts"
import type { RenderLib } from "../../docs/DocsRender.ts"
import { quoted } from "../../docs/docRules.ts"
import type { GivenImage } from "../../docs/imageRules.ts"
import { McpServers } from "../McpServers.ts"
import type { RegisteredTool } from "../McpServers.ts"
import { Rerunnable, toolArguments } from "../tool.ts"
import { ownThread } from "../tool.ts"
import type { LocalCaller } from "../tool.ts"

// The board's `docs` server (docs/plan/inventory/03-mcp.md 2.11; huntaway's mcp/docs_mcp.ts): agents publish documents
// (reports, plans, write-ups) to their profile's documents on this host (`Docs`), exactly as they would to the hosted
// docs app: the tools, their schemas, checks, errors and warnings are the hosted server's, from its renderer as
// WebAssembly (`toolDefinitions`). Its `share_document` is left out: local documents aren't shared. Until the renderer's
// definitions have them (0.2.0 doesn't), labels and images are added here as the hosted server has them (DOC-11, DOC-12).
// A tool's result is its JSON as text and as `structuredContent`; a failure is its message as a tool error, without the
// board's "Error: ", as the hosted server's. Every run gets the server unless its project has its own `docs` server or
// turns it off; its tools are allowed without asking (agents/claude/launch.ts, agents/codex/launch.ts).

/** The hosted server's tools this one leaves out. */
const LEFT_OUT = new Set(["share_document"])

/** The hosted server's `labels` argument (DOC-11), with what it's for. */
const labelsArg = (what: string) => ({
  type: "array",
  items: { type: "string" },
  description: `${what} Labels nest with '/' (e.g. ["research/ai", "needs-review"]) and match ignoring case; a label keeps the spelling it was first used with. At most 20, each up to 100 characters.`,
})

/** The hosted server's label tools (DOC-11), for a renderer whose tool definitions don't have them yet (before 0.3.0). */
const LABEL_TOOLS = [
  {
    name: "set_document_labels",
    description:
      "Replace the labels of one of your documents (pass [] to remove them all). This doesn't publish a new version. Only the owner can label a document. Returns the labels as stored.",
    inputSchema: {
      type: "object",
      properties: {
        document: { type: "string", description: "Document slug, as returned by publish_document or list_documents." },
        labels: labelsArg("The document's new labels."),
      },
      required: ["document", "labels"],
    },
    annotations: { idempotentHint: true },
  },
  {
    name: "list_labels",
    description:
      "Your labels as a tree, with how many of your documents have each label or one nested under it, and how many have no labels. Reuse these labels when you label a document.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
]

/** What publish_document's description says of images, for a renderer whose tool definitions don't have them (before DOC-12's). */
export const IMAGES_HELP =
  " Images: pass them in `images` and refer to them by name from pages (`![Chart](images/chart.png)`), or put them inline as `data:image/png;base64,…` URIs, which are taken out of the page. PNG, JPEG, WebP, GIF (first frame) and AVIF are taken; SVG isn't. Each image is converted to AVIF, and only that is kept (not the original); one over 512000 bytes (500 KB) after conversion is refused, so downscale or crop it. Image data doesn't count toward a page's size. With mode merge, the previous version's images that a page still refers to are kept."

/** The `images` argument of publish_document (DOC-12's). */
const IMAGES_ARG = {
  type: "array",
  description:
    "Images the pages show, each converted to AVIF (at most 512000 bytes after conversion; the original isn't kept). Pages refer to one by its name, relative to the page's folder or the document's root.",
  items: {
    type: "object",
    properties: {
      name: { type: "string", description: "A relative path, e.g. \"images/chart.png\": letters, digits, '.', '_' and '-', separated by '/'." },
      data: { type: "string", description: "The image's bytes in base64: PNG, JPEG, WebP, GIF or AVIF." },
    },
    required: ["name", "data"],
  },
}

/** A tool definition as the renderer gives it (and as this server patches it). */
interface Definition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly annotations?: Readonly<Record<string, unknown>> | undefined
}

const Properties = Schema.Struct({ properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) })
const propertiesOf = (schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
  Option.match(Schema.decodeOption(Properties)(schema), { onNone: () => ({}), onSome: (s) => s.properties ?? {} })
const withProperty = (d: Definition, name: string, value: unknown): Definition => ({
  ...d,
  inputSchema: { ...d.inputSchema, properties: { ...propertiesOf(d.inputSchema), [name]: value } },
})

/** The tools it offers: the hosted server's (`toolDefinitions`), but those it leaves out, with labels and images where they're missing. */
export const docsDefinitions = (lib: RenderLib): ReadonlyArray<Definition> => {
  const defs: Array<Definition> = lib.toolDefinitions().filter((t) => !LEFT_OUT.has(t.name))
  const patched = defs.map((d) => {
    const props = propertiesOf(d.inputSchema)
    let out = d
    if (d.name === "publish_document") {
      if (!("labels" in props)) {
        out = withProperty(
          out,
          "labels",
          labelsArg(
            "The document's labels. When given they replace its labels; when omitted its labels are kept. Labels belong to the document, not to a version.",
          ),
        )
      }
      if (!("images" in props)) out = { ...withProperty(out, "images", IMAGES_ARG), description: out.description + IMAGES_HELP }
    }
    if (d.name === "list_documents" && !("label" in props)) {
      out = withProperty(out, "label", {
        type: "string",
        description: 'Only your documents with this label or one nested under it ("research" includes "research/ai").',
      })
    }
    return out
  })
  for (const t of LABEL_TOOLS) if (!patched.some((d) => d.name === t.name)) patched.push(t)
  return patched
}

// ---- arguments, read as the hosted server's serde structs read them ------------------------------------------------

/** serde's description of a JSON value's type, for "invalid type" errors. */
const jsonKind = (v: unknown): string => {
  if (v === null) return "null"
  if (Array.isArray(v)) return "a sequence"
  if (typeof v === "number") return Number.isInteger(v) ? `integer \`${v}\`` : `floating point \`${v}\``
  if (typeof v === "string") return `string ${quoted(v)}`
  if (typeof v === "boolean") return `boolean \`${v}\``
  return "a map"
}

type Read<A> = Result.Result<A, string>
const bad = (v: unknown, expected: string): Read<never> => Result.fail(`invalid arguments: invalid type: ${jsonKind(v)}, expected ${expected}`)

/** A list of strings. */
const list = (v: unknown): Read<ReadonlyArray<string>> => {
  if (!Array.isArray(v)) return bad(v, "a sequence")
  const out: Array<string> = []
  for (const x of v) {
    if (typeof x !== "string") return bad(x, "a string")
    out.push(x)
  }
  return Result.succeed(out)
}

/** An agent's arguments, read field by field. */
const reader = (a: Readonly<Record<string, unknown>>) => {
  return {
    has: (k: string) => a[k] !== undefined,
    str: (k: string): Read<string> => {
      const v = a[k]
      if (v === undefined) return Result.fail(`invalid arguments: missing field \`${k}\``)
      return typeof v === "string" ? Result.succeed(v) : bad(v, "a string")
    },
    optStr: (k: string): Read<string | null> => {
      const v = a[k]
      if (v === undefined || v === null) return Result.succeed(null)
      return typeof v === "string" ? Result.succeed(v) : bad(v, "a string")
    },
    optInt: (k: string): Read<number | null> => {
      const v = a[k]
      if (v === undefined || v === null) return Result.succeed(null)
      return typeof v === "number" && Number.isInteger(v) ? Result.succeed(v) : bad(v, "i64")
    },
    strList: (k: string): Read<ReadonlyArray<string>> => (a[k] === undefined ? Result.succeed([]) : list(a[k])),
    optStrList: (k: string): Read<ReadonlyArray<string> | null> => (a[k] === undefined || a[k] === null ? Result.succeed(null) : list(a[k])),
    raw: (k: string): unknown => a[k],
  }
}

const GivenImages = Schema.Array(Schema.Struct({ name: Schema.String, data: Schema.String }))

/** The `images` argument: a list of `{name, data}`. */
const imagesOf = (v: unknown): Read<ReadonlyArray<GivenImage>> => {
  if (v === undefined || v === null) return Result.succeed([])
  if (!Array.isArray(v)) return Result.fail('images is a list of {"name", "data"} (data in base64)')
  return Option.match(Schema.decodeOption(GivenImages)(v), {
    onNone: () => Result.fail('each image is {"name": "images/chart.png", "data": "<base64>"}'),
    onSome: (images) => Result.succeed(images),
  })
}

// ---- the server ------------------------------------------------------------------------------------------------------

/** A tool's answer: its JSON (text and `structuredContent`), or its text as it is. */
const answer = (out: unknown): unknown =>
  typeof out === "string" ? { content: [{ type: "text", text: out }] } : { content: [{ type: "text", text: pretty(out) }], structuredContent: out }
const failed = (text: string) => ({ content: [{ type: "text", text }], isError: true })
const prettyJson = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
const pretty = (v: unknown): string => Result.getOrElse(prettyJson(v), () => String(v))

/** The caller as the docs area knows it. */
const as = (caller: LocalCaller) => ({ profile: caller.task.profile_id, task: caller.task, run: caller.run.id })
const read = <A>(r: Read<A>) => Effect.fromResult(r)

/** What a tool does with its caller and arguments. */
type Handle = (caller: LocalCaller, a: ReturnType<typeof reader>) => Effect.Effect<unknown, DocsRefused | string>

/** The docs server's tools with their handlers, each a `Docs` call as the caller's run. */
export const docsTools = Effect.gen(function* () {
  const docs = yield* Docs
  const lib = yield* (yield* DocsRender).lib

  const handlers: Readonly<Record<string, Handle>> = {
    list_documents: (c, a) => Effect.flatMap(read(a.optStr("label")), (label) => docs.agentList(as(c), label)),
    get_document: (c, a) =>
      Effect.gen(function* () {
        return yield* docs.agentGet(as(c), yield* read(a.str("slug")), yield* read(a.optInt("version")))
      }),
    read_page: (c, a) =>
      Effect.gen(function* () {
        return yield* docs.readPage(as(c), yield* read(a.str("slug")), yield* read(a.str("path")), yield* read(a.optInt("version")))
      }),
    publish_document: (c, a) =>
      Effect.gen(function* () {
        const pages = a.raw("pages") === undefined ? [] : a.raw("pages")
        if (!Array.isArray(pages)) return yield* read(bad(pages, "a sequence"))
        const given: ReadonlyArray<unknown> = pages
        return yield* docs.publish(as(c), {
          slug: yield* read(a.optStr("slug")),
          title: yield* read(a.optStr("title")),
          message: yield* read(a.optStr("message")),
          mode: (yield* read(a.optStr("mode"))) ?? "replace",
          folder: yield* read(a.optStr("folder")),
          delete_paths: yield* read(a.strList("delete_paths")),
          labels: yield* read(a.optStrList("labels")),
          pages: given,
          images: yield* read(imagesOf(a.raw("images"))),
        })
      }),
    move_document: (c, a) =>
      Effect.gen(function* () {
        return yield* docs.agentMove(as(c), yield* read(a.str("slug")), yield* read(a.str("folder")))
      }),
    get_feedback: (c, a) =>
      Effect.gen(function* () {
        return yield* docs.feedback(as(c), yield* read(a.str("slug")), yield* read(a.optInt("version")), yield* read(a.optInt("since")))
      }),
    list_components: () => docs.components,
    // The hosted server names the document `document`; the other tools name it `slug`, which agents may give too.
    set_document_labels: (c, a) =>
      Effect.gen(function* () {
        const slug = yield* read(!a.has("document") && a.has("slug") ? a.str("slug") : a.str("document"))
        if (!a.has("labels")) return yield* read(Result.fail("invalid arguments: missing field `labels`"))
        return yield* docs.setLabels(as(c), slug, yield* read(a.strList("labels")))
      }),
    list_labels: (c) => docs.agentLabels(as(c)),
  }

  return docsDefinitions(lib).flatMap((d): ReadonlyArray<RegisteredTool> => {
    const handle = handlers[d.name]
    if (handle === undefined) return []
    const reads = d.annotations?.["readOnlyHint"] === true
    const tool = Tool.dynamic(d.name, { description: d.description, parameters: d.inputSchema }).annotate(Tool.Readonly, reads).annotate(Rerunnable, reads)
    const args = toolArguments(tool)
    return [
      {
        tool,
        // Each tool reads its own arguments, with the hosted server's messages for one missing or of the wrong type (a
        // folder may be "", the top level); `set_document_labels` takes the document as `slug` too.
        args: { names: d.name === "set_document_labels" ? [...args.names, "slug"].toSorted() : args.names, required: [] },
        run: (given, caller) =>
          // The docs server is only given to this host's runs (M7's callers from other hosts are refused).
          Effect.flatMap(ownThread(caller, d.name), (local) => handle(local, reader(given))).pipe(
            Effect.map(answer),
            Effect.catch((e) => Effect.succeed(failed(typeof e === "string" ? e : e.message))),
          ),
      },
    ]
  })
})

/** The `docs` server's tools, registered (`Main.ts`' `mcpLayer`, beside the board's and gh's). */
export const DocsTools = McpServers.register("docs", docsTools)
