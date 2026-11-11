import { Context, Effect, Layer, Result, Schema } from "effect"
import { Digest } from "effect/crypto"
import { allImages, findInline, givenImages, inlineName, MAX_IMAGE_BYTES, takeInline } from "./imageRules.ts"
import type { GivenImage, Upload } from "./imageRules.ts"

// Documents' images converted (huntaway's mcp/doc_images.ts; docs/plan/inventory/02-agent-support.md 2.8): each image
// `publish_document` is given, or finds inline in a page, is converted to AVIF with `sharp` (libvips, a native module,
// on libuv's threads, so the server isn't held up), and refused if that is over 500 KB: it isn't resized to fit. Only
// the AVIF is kept (`DocRepo`), not what was uploaded. An AVIF is kept as it came, once sharp has read it, as the hosted
// app does (it has no AV1 decoder to re-encode it with). The rules that read nothing are `imageRules.ts`.

/** AVIF encoding (sharp's `avif()`): quality 1-100, and effort 0 (fastest) to 9 (smallest). */
export const AVIF_QUALITY = 60
export const AVIF_EFFORT = 2
/** The most pixels an image may have to be decoded at all (about 100 megapixels), so a small file can't expand to gigabytes. */
export const MAX_INPUT_PIXELS = 100_000_000

/** Why an image isn't taken, in the hosted app's words. */
export class ImageRefused extends Schema.TaggedError<ImageRefused, { readonly brand: unique symbol }>()("ImageRefused", { message: Schema.String }) {}

/** An image ready to store: its name in the version, and the AVIF it was converted to. */
export interface NewDocImage {
  readonly name: string
  readonly sha256: string
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

/** A page as `publish_document` is given it: its content checked as a string. */
export interface PageIn {
  readonly path: string
  readonly content: string
}

export interface DocImagesShape {
  /**
   * The `images` argument's images and the pages' inline ones (taken out of their content, which is given back without
   * them), checked but not converted: the pages are checked before the slow part.
   */
  readonly take: (
    pages: ReadonlyArray<unknown>,
    given: ReadonlyArray<GivenImage>,
  ) => Effect.Effect<{ readonly pages: ReadonlyArray<unknown>; readonly images: ReadonlyArray<Upload> }, ImageRefused>
  /** Each image converted, one at a time (each takes all of libvips' threads). */
  readonly convert: (images: ReadonlyArray<Upload>) => Effect.Effect<ReadonlyArray<NewDocImage>, ImageRefused>
  /** The hex sha256 of some bytes. */
  readonly sha256: (bytes: Uint8Array) => Effect.Effect<string>
}

const refused = <A>(r: Result.Result<A, { readonly problem: string }>) => Effect.fromResult(Result.mapError(r, (e) => new ImageRefused({ message: e.problem })))

const PageShape = Schema.Struct({ path: Schema.optional(Schema.Unknown), content: Schema.String })
const isPage = Schema.is(PageShape)

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class DocImages extends Context.Service<DocImages, DocImagesShape>()("huntaway-server/docs/DocImages") {
  static readonly layer = Layer.effect(
    DocImages,
    Effect.gen(function* () {
      const digest = yield* Digest.Digest
      // sharp, loaded the first time an image is converted.
      const sharp = yield* Effect.cached(Effect.promise(() => import("sharp").then((m) => m.default)))
      const sha256 = (bytes: Uint8Array) => digest.digestHex(Digest.sha256, bytes)

      const take: DocImagesShape["take"] = Effect.fn("DocImages.take")(function* (pages, given) {
        const uploads = yield* refused(givenImages(given))
        const inline: Array<Upload> = []
        const out: Array<unknown> = []
        for (const page of pages) {
          if (!isPage(page)) {
            out.push(page)
            continue
          }
          const found = yield* refused(findInline(typeof page.path === "string" ? page.path : "", page.content))
          if (found.length === 0) {
            out.push(page)
            continue
          }
          const named = yield* Effect.forEach(found, (f) => Effect.map(sha256(f.bytes), (hex) => ({ ...f, name: inlineName(hex) })), { concurrency: 1 })
          const taken = yield* refused(takeInline(page.content, named))
          inline.push(...taken.images)
          out.push({ ...page, content: taken.content })
        }
        return { pages: out, images: yield* refused(allImages(uploads, inline)) }
      })

      const toAvif = Effect.fnUntraced(function* (im: Upload) {
        const lib = yield* sharp
        const unreadable = (e: unknown) => new ImageRefused({ message: `${im.subject} couldn't be read: ${message(e)}` })
        const out =
          im.format === "avif"
            ? // Already AVIF: kept as it is, once it's read as one.
              yield* Effect.tryPromise({ try: () => lib(im.bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata(), catch: unreadable }).pipe(
                Effect.flatMap((m) =>
                  m.format !== "heif" || m.compression !== "av1" || !m.width || !m.height
                    ? Effect.fail(unreadable(new Error("not an AVIF image")))
                    : Effect.succeed({ data: im.bytes, width: m.width, height: m.height }),
                ),
              )
            : // An animation's first frame (`animated: false`), turned as its EXIF says (`rotate()`), without its metadata.
              yield* Effect.tryPromise({
                try: () =>
                  lib(im.bytes, { animated: false, limitInputPixels: MAX_INPUT_PIXELS })
                    .rotate()
                    .avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT })
                    .toBuffer({ resolveWithObject: true }),
                catch: unreadable,
              }).pipe(
                Effect.map((r) => ({ data: new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.length), width: r.info.width, height: r.info.height })),
              )
        if (out.data.length > MAX_IMAGE_BYTES) {
          return yield* new ImageRefused({
            message: `${im.subject} is ${out.data.length} bytes after conversion to AVIF, over the limit of ${MAX_IMAGE_BYTES} bytes (500 KB): downscale or crop it and publish again`,
          })
        }
        const image: NewDocImage = { name: im.name, sha256: yield* sha256(out.data), data: out.data, width: out.width, height: out.height }
        return image
      })

      return DocImages.of({
        take,
        convert: Effect.fn("DocImages.convert")(function* (images) {
          return yield* Effect.forEach(images, toAvif, { concurrency: 1 })
        }),
        sha256,
      })
    }),
  )
}
