import { Result } from "effect"
import { Base64 } from "effect/encoding"
import { quoted } from "./docRules.ts"

// Documents' images, the parts that read nothing but what they're given (huntaway's mcp/doc_images.ts; docs/plan/
// inventory/02-agent-support.md 2.8, as the hosted docs app's since DOC-12):
//
// - An image comes in `publish_document`'s `images` argument (`{name, data}`, `data` base64, `name` a relative path such
//   as `images/chart.png` that pages refer to it by), or inline in a page as a `data:image/…;base64,…` URI, which is
//   taken out of the page and replaced with a name of its own (`images/inline-<hash>.avif`), unless it's in code (a
//   fenced block or an inline code span), which shows it as written.
// - Its format is read from its bytes: PNG, JPEG, WebP, GIF and AVIF are taken; anything else (SVG included, which isn't
//   rasterised) is refused.
// - A rendered page's `<img>` refers to one by name, from the page's folder, else from the document's root.
//
// The errors' wording is the hosted app's, so an agent gets the same message from either. `DocImages` converts them.

/** The most an image may be once converted to AVIF: 500 KB. */
export const MAX_IMAGE_BYTES = 512_000
/** The most images a version may have. */
export const MAX_IMAGES = 200
/** The longest image name, in characters. */
export const MAX_IMAGE_NAME_CHARS = 200
export const FORMATS = "PNG, JPEG, WebP, GIF or AVIF"

export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "avif"

/** An image as it came, before it's converted. */
export interface Upload {
  readonly name: string
  /** How errors name it: `image "images/chart.png"`, or `inline image 2 on page "index"`. */
  readonly subject: string
  readonly bytes: Uint8Array
  readonly format: ImageFormat
}

/** Why an image isn't taken, as the agent is told. */
export interface ImageProblem {
  readonly problem: string
}

const latin1 = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.subarray(from, to))
const fail = (problem: string): Result.Result<never, ImageProblem> => Result.fail({ problem })

/** A name from the agent, normalised (`./images/a.png` → `images/a.png`). */
export const imageName = (raw: string): Result.Result<string, ImageProblem> => {
  const name = raw.replace(/^(\.\/|\/)+/, "")
  const ok = name.length > 0 && name.length <= MAX_IMAGE_NAME_CHARS && name.split("/").every((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..")
  return ok
    ? Result.succeed(name)
    : fail(`image name ${quoted(raw)} isn't a relative path like "images/chart.png" (letters, digits, '.', '_' and '-', separated by '/')`)
}

/** The bytes of base64 `data` (whitespace in it ignored, padding optional). */
export const base64Bytes = (data: string, subject: string): Result.Result<Uint8Array, ImageProblem> => {
  const s = data.replace(/\s+/g, "")
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 === 1 || s.length === 0) return fail(`${subject} isn't valid base64`)
  const padded = s.includes("=") ? s : s + "=".repeat((4 - (s.length % 4)) % 4)
  return Result.mapError(Base64.decode(padded), () => ({ problem: `${subject} isn't valid base64` }))
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The format of an image's bytes, by their signature; "svg" for SVG; null for anything else. */
export const sniff = (b: Uint8Array): ImageFormat | "svg" | null => {
  if (b.length >= 8 && PNG.every((x, i) => b[i] === x)) return "png"
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg"
  if (b.length >= 6 && /^GIF8[79]a$/.test(latin1(b, 0, 6))) return "gif"
  if (b.length >= 12 && latin1(b, 0, 4) === "RIFF" && latin1(b, 8, 12) === "WEBP") return "webp"
  if (b.length >= 12 && latin1(b, 4, 8) === "ftyp") {
    // An ISO-BMFF file: AVIF if its major or a compatible brand is avif (a still) or avis (a sequence).
    const declared = (((b[0] ?? 0) << 24) | ((b[1] ?? 0) << 16) | ((b[2] ?? 0) << 8) | (b[3] ?? 0)) >>> 0
    const size = Math.min(declared, b.length)
    for (let i = 8; i + 4 <= size; i += 4) {
      if (i === 12) continue // the minor version
      const brand = latin1(b, i, i + 4)
      if (brand === "avif" || brand === "avis") return "avif"
    }
    return null
  }
  // SVG is text: after any BOM, whitespace, XML declaration, comments or doctype, an <svg> element.
  const head = new TextDecoder().decode(b.subarray(0, 4096)).replace(/^﻿/, "")
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) return "svg"
  return null
}

/** An image to convert, from its bytes, unless it's in a format that isn't taken. */
export const upload = (name: string, subject: string, bytes: Uint8Array): Result.Result<Upload, ImageProblem> => {
  const format = sniff(bytes)
  if (format === "svg") return fail(`${subject} is SVG, which isn't supported: images must be ${FORMATS}`)
  if (format === null) return fail(`${subject} isn't ${FORMATS}`)
  return Result.succeed({ name, subject, bytes, format })
}

/** The `images` argument as given: each `{name, data}`. */
export interface GivenImage {
  readonly name: string
  readonly data: string
}

/** The `images` argument's images (not yet converted). */
export const givenImages = (given: ReadonlyArray<GivenImage>): Result.Result<ReadonlyArray<Upload>, ImageProblem> => {
  const out: Array<Upload> = []
  for (const im of given) {
    const name = imageName(im.name)
    if (Result.isFailure(name)) return Result.fail(name.failure)
    const subject = `image ${quoted(name.success)}`
    const bytes = base64Bytes(im.data, subject)
    if (Result.isFailure(bytes)) return Result.fail(bytes.failure)
    const one = upload(name.success, subject, bytes.success)
    if (Result.isFailure(one)) return Result.fail(one.failure)
    out.push(one.success)
  }
  return Result.succeed(out)
}

/** A data URI of an image in base64, in a page's source. */
const DATA_URI = /data:image\/[A-Za-z0-9.+-]+;base64,([A-Za-z0-9+/]+={0,2})/g

/** The name an inline image gets, from the hex sha256 of its bytes as they came: the same image gets the same name. */
export const inlineName = (sha256Hex: string): string => `images/inline-${sha256Hex.slice(0, 16)}.avif`

/**
 * Where a page's source has code, as [start, end) offsets: fenced code blocks (``` or ~~~, to their closing fence or
 * the end) and inline code spans (a run of backticks to the next run as long) outside them. The hosted app finds them
 * with its Markdown parser; this is close enough for data URIs, which are only ever in code to be shown as text.
 */
export const codeRanges = (src: string): ReadonlyArray<readonly [number, number]> => {
  const fenced: Array<readonly [number, number]> = []
  let fence: { readonly ch: string; readonly len: number; readonly start: number } | null = null
  for (let at = 0; at < src.length;) {
    const nl = src.indexOf("\n", at)
    const end = nl < 0 ? src.length : nl + 1
    const m = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(src.slice(at, end))
    const marks = m?.[1] ?? ""
    const rest = m?.[2] ?? ""
    if (fence !== null) {
      if (m !== null && marks[0] === fence.ch && marks.length >= fence.len && rest.trim() === "") {
        fenced.push([fence.start, end])
        fence = null
      }
    } else if (m !== null && !(marks[0] === "`" && rest.includes("`"))) fence = { ch: marks[0] ?? "`", len: marks.length, start: at }
    at = end
  }
  if (fence !== null) fenced.push([fence.start, src.length])
  const out = [...fenced]
  const inside = (i: number) => fenced.some(([a, b]) => i >= a && i < b)
  const runs = [...src.matchAll(/`+/g)].filter((m) => !inside(m.index)).map((m) => ({ at: m.index, len: m[0].length }))
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i]
    if (open === undefined) continue
    const close = runs.findIndex((r, j) => j > i && r.len === open.len)
    const closing = runs[close]
    if (closing === undefined) continue
    out.push([open.at, closing.at + closing.len])
    i = close
  }
  return out
}

/** An inline image found in a page, before its name is known (that needs its bytes' hash). */
export interface InlineFound {
  /** Where its URI is in the source, and the URI. */
  readonly at: number
  readonly uri: string
  readonly subject: string
  readonly bytes: Uint8Array
}

/** A page's inline images (data URIs outside code), in order: what `takeInline` names. */
export const findInline = (path: string, content: string): Result.Result<ReadonlyArray<InlineFound>, ImageProblem> => {
  if (!content.includes("data:image/")) return Result.succeed([])
  const code = codeRanges(content)
  const out: Array<InlineFound> = []
  let n = 0
  for (const m of content.matchAll(DATA_URI)) {
    if (code.some(([a, b]) => m.index >= a && m.index < b)) continue
    const subject = `inline image ${++n} on page ${quoted(path)}`
    const bytes = base64Bytes(m[1] ?? "", subject)
    if (Result.isFailure(bytes)) return Result.fail(bytes.failure)
    out.push({ at: m.index, uri: m[0], subject, bytes: bytes.success })
  }
  return Result.succeed(out)
}

/**
 * A page's content with its inline images (`found`, each with its name) replaced with their names, and those images
 * (each once), unless one isn't an image that's taken.
 */
export const takeInline = (
  content: string,
  found: ReadonlyArray<InlineFound & { readonly name: string }>,
): Result.Result<{ readonly content: string; readonly images: ReadonlyArray<Upload> }, ImageProblem> => {
  const images: Array<Upload> = []
  let out = ""
  let from = 0
  for (const f of found) {
    out += content.slice(from, f.at) + f.name
    from = f.at + f.uri.length
    if (images.some((im) => im.name === f.name)) continue
    const one = upload(f.name, f.subject, f.bytes)
    if (Result.isFailure(one)) return Result.fail(one.failure)
    images.push(one.success)
  }
  return Result.succeed({ content: out + content.slice(from), images })
}

/**
 * The version's images: `given` and `inline` (whose names are unique to their bytes, so one in both is kept once),
 * checked for names given twice and how many there are.
 */
export const allImages = (given: ReadonlyArray<Upload>, inline: ReadonlyArray<Upload>): Result.Result<ReadonlyArray<Upload>, ImageProblem> => {
  const seen = new Set<string>()
  for (const im of given) {
    if (seen.has(im.name)) return fail(`image ${quoted(im.name)} is given more than once`)
    seen.add(im.name)
  }
  const out = [...given]
  for (const im of inline) {
    if (seen.has(im.name)) continue
    seen.add(im.name)
    out.push(im)
  }
  if (out.length > MAX_IMAGES) return fail(`a version can have at most ${MAX_IMAGES} images, not ${out.length}`)
  return Result.succeed(out)
}

const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" }

const decoded = (s: string): string | null => {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

const resolve = (base: ReadonlyArray<string>, rel: string): string => {
  const out = [...base]
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") out.pop()
    else out.push(seg)
  }
  return out.join("/")
}

/**
 * The name of the image an `<img src>` on page `page` refers to, if `names` has it: a relative `src` resolved against
 * the page's folder, else against the document's root (as `/images/a.png` is). Null for any other src.
 */
export const imageRef = (src: string, page: string, names: ReadonlySet<string>): string | null => {
  const raw = src.replace(/&(amp|quot|#39|lt|gt);/g, (e) => ENTITIES[e] ?? e).replace(/[?#].*$/, "")
  if (raw === "" || raw.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return null
  const ref = decoded(raw)
  if (ref === null) return null
  const folder = page.split("/").slice(0, -1)
  const tries = ref.startsWith("/") ? [resolve([], ref)] : [resolve(folder, ref), resolve([], ref)]
  return tries.find((t) => names.has(t)) ?? null
}

/**
 * Rendered page `html` (docs-render's, sanitized) with the `src` of each `<img>` that refers to one of the version's
 * `images` (name → sha256) replaced with `url(sha256)`, and the relative srcs that refer to none.
 */
export const withImages = (
  html: string,
  page: string,
  images: ReadonlyMap<string, string>,
  url: (sha256: string) => string,
): { readonly html: string; readonly missing: ReadonlyArray<string> } => {
  const names = new Set(images.keys())
  const missing: Array<string> = []
  const out = html.replace(/<img\b[^>]*>/g, (tag) =>
    tag.replace(/(\ssrc=")([^"]*)(")/, (whole, pre: string, src: string, post: string) => {
      const name = imageRef(src, page, names)
      const sha = name === null ? undefined : images.get(name)
      if (sha !== undefined) return `${pre}${url(sha)}${post}`
      if (!/^([A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(src) && !missing.includes(src)) missing.push(src)
      return whole
    }),
  )
  return { html: out, missing }
}
