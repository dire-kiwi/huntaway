import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Digest } from "effect/crypto"
import { Base64 } from "effect/encoding"
import { SqlClient } from "effect/sql"
import sharp from "sharp"
import { TestBoard } from "@huntaway/testing"
import { McpServers } from "../mcp/McpServers.ts"
import { DocRepo } from "./DocRepo.ts"
import { Docs } from "./Docs.ts"
import { imageRef, inlineName, MAX_IMAGE_BYTES } from "./imageRules.ts"
import { at, caller, listAt, ok, pluck, refused } from "./tests/docs.ts"

// Documents' images (the old mcp/doc_images.test.ts): `publish_document`'s `images` and inline data: images, converted
// to AVIF (`DocImages`), kept once per profile (`DocRepo`), and shown in the board's rendered pages (`Docs.version`,
// `Docs.image`). Dropped: `a_database_from_before_images_gets_their_tables` (the initial schema has them). Converting
// a large image takes a while on a busy machine, so those cases get 30 s.

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

type Format = "png" | "jpeg" | "webp" | "gif" | "avif" | "tiff"

/** A flat-coloured image of `w`×`h` in `format`. */
const picture = (format: Format, w = 64, h = 48, colour = { r: 200, g: 40, b: 40 }) =>
  Effect.promise(() =>
    sharp({ create: { width: w, height: h, channels: 3, background: colour } })
      .toFormat(format)
      .toBuffer(),
  )

/** A PNG of pseudo-random pixels (which compress badly, AVIF too). */
const noise = (n: number) => {
  const raw = new Uint8Array(n * n * 3)
  let x = 2463534242
  for (let i = 0; i < raw.length; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    raw[i] = x & 0xff
  }
  return Effect.promise(() =>
    sharp(raw, { raw: { width: n, height: n, channels: 3 } })
      .png()
      .toBuffer(),
  )
}

const b64 = (b: Uint8Array) => Base64.encode(b)
const sha = (b: Uint8Array) => Effect.flatMap(Digest.Digest, (d) => d.digestHex(Digest.sha256, b))
const stored = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ readonly sha256: string; readonly data: Uint8Array }>`SELECT sha256, data FROM doc_images`,
).pipe(Effect.orDie)
const metadata = (b: Uint8Array) => Effect.promise(() => sharp(b).metadata())
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/** The error for an image name that isn't a relative path. */
const relative = (name: string) => `image name "${name}" isn't a relative path like "images/chart.png" (letters, digits, '.', '_' and '-', separated by '/')`

describe("documents' images", () => {
  it.effect("each image format is converted to AVIF, and only that is kept", () =>
    run(
      Effect.gen(function* () {
        const r = yield* caller()
        const given: Record<string, Uint8Array> = {}
        for (const f of ["png", "jpeg", "webp", "gif"] as const) given[`images/a.${f}`] = yield* picture(f, 64, 48, { r: 10 * f.length, g: 90, b: 30 })
        const pub = yield* ok(r, "publish_document", {
          pages: [
            {
              path: "index",
              content: `# Pictures\n\n${Object.keys(given)
                .map((n) => `![${n}](${n})`)
                .join("\n")}\n`,
            },
          ],
          images: Object.entries(given).map(([name, data]) => ({ name, data: b64(data) })),
        })
        assert.deepStrictEqual(
          listAt(pub, "images").map((im) => [at(im, "name"), at(im, "width"), at(im, "height")]),
          Object.keys(given)
            .toSorted()
            .map((n) => [n, 64, 48]),
        )
        assert.deepStrictEqual(at(pub, "warnings"), [])
        const rows = yield* stored
        assert.strictEqual(rows.length, 4)
        for (const row of rows) {
          const m = yield* metadata(row.data)
          assert.deepStrictEqual([m.format, m.compression], ["heif", "av1"], "kept as AVIF")
          assert.strictEqual(yield* sha(row.data), row.sha256, "by the AVIF's hash")
        }
        // The originals aren't anywhere in the database.
        const sql = yield* SqlClient.SqlClient
        for (const original of Object.values(given)) {
          for (const row of rows) assert.isFalse(same(row.data, original))
          const pages = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM doc_pages WHERE instr(source, ${b64(original).slice(0, 40)}) > 0`
          assert.strictEqual(pages[0]?.n, 0)
        }
        // get_document lists them too.
        assert.strictEqual(listAt(yield* ok(r, "get_document", { slug: at(pub, "slug") }), "images").length, 4)
      }),
    ),
  )

  it.effect("an AVIF is kept as it came", () =>
    run(
      Effect.gen(function* () {
        const r = yield* caller()
        const avif = yield* picture("avif")
        yield* ok(r, "publish_document", { pages: [{ path: "index", content: "![x](x.avif)" }], images: [{ name: "x.avif", data: b64(avif) }] })
        assert.isTrue(same((yield* stored)[0]?.data ?? new Uint8Array(), avif))
      }),
    ),
  )

  it.effect("images that aren't taken are refused with the hosted server's errors", () =>
    run(
      Effect.gen(function* () {
        const r = yield* caller()
        const svg = new TextEncoder().encode(
          '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
        )
        const png = yield* picture("png")
        const broken = new Uint8Array([...png.subarray(0, 8), ...new TextEncoder().encode("broken")])
        const page = [{ path: "index", content: "# Hi\n" }]
        const cases: ReadonlyArray<readonly [unknown, string]> = [
          [
            [{ name: "images/logo.svg", data: b64(svg) }],
            'image "images/logo.svg" is SVG, which isn\'t supported: images must be PNG, JPEG, WebP, GIF or AVIF',
          ],
          [[{ name: "a.tif", data: b64(yield* picture("tiff", 4, 4)) }], 'image "a.tif" isn\'t PNG, JPEG, WebP, GIF or AVIF'],
          [[{ name: "a.png", data: "not base64!" }], 'image "a.png" isn\'t valid base64'],
          [[{ name: "../a.png", data: "" }], relative("../a.png")],
          [[{ name: "a b.png", data: "" }], relative("a b.png")],
          [
            [
              { name: "./a.png", data: b64(png) },
              { name: "a.png", data: b64(png) },
            ],
            'image "a.png" is given more than once',
          ],
          [[{ name: "a.png", data: b64(broken) }], 'image "a.png" couldn\'t be read: '],
          ["a.png", 'images is a list of {"name", "data"} (data in base64)'],
          [[{ name: "a.png" }], 'each image is {"name": "images/chart.png", "data": "<base64>"}'],
        ]
        for (const [images, error] of cases) {
          const text = yield* refused(r, "publish_document", { pages: page, images })
          assert.isTrue(text.startsWith(error), `${text} should start with ${error}`)
        }
        // An inline SVG is refused as one given is.
        assert.strictEqual(
          yield* refused(r, "publish_document", { pages: [{ path: "index", content: `![logo](data:image/svg+xml;base64,${b64(svg)})` }] }),
          'inline image 1 on page "index" is SVG, which isn\'t supported: images must be PNG, JPEG, WebP, GIF or AVIF',
        )
        // Nothing was published.
        assert.deepStrictEqual(yield* (yield* DocRepo).list(r.profile.id), [])
        assert.strictEqual((yield* stored).length, 0)
      }),
    ),
  )

  it.effect(
    "an image over 500 KB once converted is refused, and not resized",
    () =>
      run(
        Effect.gen(function* () {
          const r = yield* caller()
          const big = yield* noise(1000)
          const text = yield* refused(r, "publish_document", {
            pages: [{ path: "index", content: "![n](n.png)" }],
            images: [{ name: "n.png", data: b64(big) }],
          })
          const m =
            /^image "n\.png" is (\d+) bytes after conversion to AVIF, over the limit of 512000 bytes \(500 KB\): downscale or crop it and publish again$/.exec(
              text,
            )
          assert.isNotNull(m, text)
          assert.isAbove(Number(m?.[1]), MAX_IMAGE_BYTES)
          assert.deepStrictEqual(yield* (yield* DocRepo).list(r.profile.id), [])
          assert.strictEqual((yield* stored).length, 0)
        }),
      ),
    { timeout: 30_000 },
  )

  it.effect(
    "inline images are taken out of the page, so it passes the page size check",
    () =>
      run(
        Effect.gen(function* () {
          const r = yield* caller()
          // Over 1,000,000 bytes of base64, under 500 KB as AVIF.
          const png = yield* noise(600)
          const uri = `data:image/png;base64,${b64(png)}`
          assert.isAbove(uri.length, 1_000_000)
          const content = `# Noise\n\n![noise](${uri})\n\nAgain: <img src="${uri}" alt="again">\n\nAs code: \`${uri.slice(0, 40)}\`\n\n\`\`\`\n${uri.slice(0, 60)}\n\`\`\`\n`
          const pub = yield* ok(r, "publish_document", { pages: [{ path: "plan/noise", content }] })
          const name = inlineName(yield* sha(png))
          assert.match(name, /^images\/inline-[0-9a-f]{16}\.avif$/)
          assert.deepStrictEqual(pluck(listAt(pub, "images"), "name"), [name], "the same image twice is one")
          const page = yield* ok(r, "read_page", { slug: at(pub, "slug"), path: "plan/noise" })
          assert.strictEqual(
            at(page, "content"),
            `# Noise\n\n![noise](${name})\n\nAgain: <img src="${name}" alt="again">\n\nAs code: \`${uri.slice(0, 40)}\`\n\n\`\`\`\n${uri.slice(0, 60)}\n\`\`\`\n`,
            "code keeps what it shows",
          )
          // A page that's too large without its images still is.
          assert.strictEqual(
            yield* refused(r, "publish_document", { pages: [{ path: "index", content: "x".repeat(1_000_001) }] }),
            'page "index" is larger than 1000000 bytes',
          )
        }),
      ),
    { timeout: 30_000 },
  )

  it.effect("merge keeps the images its pages still show, and replace keeps none", () =>
    run(
      Effect.gen(function* () {
        const r = yield* caller()
        const [a, b] = [yield* picture("png", 10, 10), yield* picture("png", 20, 20)]
        const first = yield* ok(r, "publish_document", {
          slug: "pics",
          pages: [
            { path: "index", content: "# Pics\n\n![a](images/a.png)\n" },
            { path: "more/b", content: "# B\n\n![b](../images/b.png)\n" },
          ],
          images: [
            { name: "images/a.png", data: b64(a) },
            { name: "images/b.png", data: b64(b) },
          ],
        })
        assert.deepStrictEqual(at(first, "warnings"), [])
        // Merging a new index page: page b still shows b (relative to its folder), and a is shown by none.
        const second = yield* ok(r, "publish_document", { slug: "pics", mode: "merge", pages: [{ path: "index", content: "# Pics\n\nNo pictures.\n" }] })
        assert.deepStrictEqual(pluck(listAt(second, "images"), "name"), ["images/b.png"])
        // A page given again with its image name keeps it; a new upload of a name replaces it.
        const third = yield* ok(r, "publish_document", {
          slug: "pics",
          mode: "merge",
          pages: [{ path: "index", content: "![b](/images/b.png) ![a](images/a.png)" }],
          images: [{ name: "images/a.png", data: b64(yield* picture("png", 30, 30)) }],
        })
        assert.deepStrictEqual(
          listAt(third, "images").map((im) => [at(im, "name"), at(im, "width")]),
          [
            ["images/a.png", 30],
            ["images/b.png", 20],
          ],
        )
        // Replace keeps only those given: the missing one is a warning.
        const fourth = yield* ok(r, "publish_document", { slug: "pics", pages: [{ path: "index", content: "![a](images/a.png)" }] })
        assert.deepStrictEqual(at(fourth, "images"), [])
        assert.deepStrictEqual(at(fourth, "warnings"), [
          { page: "index", warning: "image \"images/a.png\" isn't one of this version's images; pass it in `images`" },
        ])
        // Earlier versions keep theirs.
        const repo = yield* DocRepo
        const doc = yield* repo.get(r.profile.id, "pics")
        const v1 = doc === null ? null : yield* repo.version(doc.id, 1)
        assert.strictEqual((yield* repo.images(v1?.id ?? "")).length, 2)
      }),
    ),
  )

  it.effect("the board shows a version's images from their route, and only the profile's", () =>
    run(
      Effect.gen(function* () {
        const docs = yield* Docs
        const r = yield* caller()
        const other = yield* caller("q")
        yield* ok(r, "publish_document", {
          slug: "pics",
          pages: [{ path: "plan/index", content: '# Pics\n\n![a](images/a.png "A")\n\n![remote](https://example.com/x.png) ![none](images/none.png)\n' }],
          images: [{ name: "plan/images/a.png", data: b64(yield* picture("png")) }],
        })
        const [row] = yield* stored
        const sha256 = row?.sha256 ?? ""
        const v = yield* docs.version(r.profile.id, "pics", null, {})
        const html = v.pages[0]?.html ?? ""
        assert.include(html, `<img src="/api/profiles/${r.profile.id}/doc_images/${sha256}" alt="a"`)
        // Others are left as they are: the board's frame doesn't load them.
        assert.include(html, 'src="https://example.com/x.png"')
        assert.include(html, 'src="images/none.png"')

        assert.deepStrictEqual(yield* docs.image(r.profile.id, sha256), { sha256, mime: "image/avif", data: b64(row?.data ?? new Uint8Array()) })
        // Another profile's route doesn't have it, and nothing that isn't a hash is looked up.
        for (const [profile, hash] of [
          [other.profile.id, sha256],
          [r.profile.id, "0".repeat(64)],
          [r.profile.id, "x"],
        ] as const)
          assert.strictEqual((yield* Effect.flip(docs.image(profile, hash)))._tag, "NotFound")
      }),
    ),
  )

  it.effect("an image goes with the last document that uses it", () =>
    run(
      Effect.gen(function* () {
        const r = yield* caller()
        const png = b64(yield* picture("png"))
        for (const slug of ["one", "two"])
          yield* ok(r, "publish_document", { slug, pages: [{ path: "index", content: "![a](a.png)" }], images: [{ name: "a.png", data: png }] })
        assert.strictEqual((yield* stored).length, 1, "kept once")
        const docs = yield* Docs
        yield* docs.delete(r.profile.id, "one")
        assert.strictEqual((yield* stored).length, 1)
        yield* docs.delete(r.profile.id, "two")
        assert.strictEqual((yield* stored).length, 0)
      }),
    ),
  )

  it.effect("publish_document's schema and the instructions tell agents about images", () =>
    run(
      Effect.gen(function* () {
        const servers = yield* McpServers
        const publish = (yield* servers.tools("docs", false)).find((t) => t.name === "publish_document")
        assert.deepStrictEqual(at(publish, "inputSchema", "properties", "images", "items", "required"), ["name", "data"])
        assert.include(publish?.description, "512000 bytes")
        assert.match(String(servers.initializeResult("docs", "2025-11-25")["instructions"]), /converted to AVIF and must be at most 500 KB/)
      }),
    ),
  )

  it("image names resolve against the page's folder, then the root", () => {
    const names = new Set(["images/a.png", "plan/images/b.png"])
    assert.strictEqual(imageRef("images/a.png", "plan/x", names), "images/a.png")
    assert.strictEqual(imageRef("./images/b.png", "plan/x", names), "plan/images/b.png")
    assert.strictEqual(imageRef("../images/a.png", "plan/x", names), "images/a.png")
    assert.strictEqual(imageRef("/images/a.png?x=1#y", "plan/x", names), "images/a.png")
    assert.strictEqual(imageRef("/plan/images/b.png", "index", names), "plan/images/b.png")
    assert.strictEqual(imageRef("images/b.png", "index", names), null)
    assert.strictEqual(imageRef("https://example.com/images/a.png", "index", names), null)
    assert.strictEqual(imageRef("//example.com/images/a.png", "index", names), null)
  })
})
