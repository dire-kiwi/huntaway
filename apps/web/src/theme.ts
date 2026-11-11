/**
 * The theme's tint (HA-397): a colour the user picks, whose hue the board's surfaces, lines, text and accent take on,
 * as a browser's themes do from a base colour. Each of index.css's colours keeps its own lightness, so contrast stays as
 * the stock theme has it whatever colour is picked: the tint gives only a hue and how strong it is. Status colours keep
 * theirs. Each profile has its own (its `tint`, set in its settings), and the board shows the active profile's; with
 * none, the stock theme shows as it is.
 */

const KEY = "ia.tint"

/** The picker's colour while no tint is set: the stock theme's accent. */
export const DEFAULT_TINT = "#7c7cf8"

/** index.css's `@theme` colours that the tint changes, with their stock values. */
const STOCK = {
  bg: "#0b0b0e",
  panel: "#111116",
  "panel-2": "#16161d",
  raised: "#1c1c25",
  line: "#24242e",
  "line-strong": "#33333f",
  fg: "#e6e6ec",
  muted: "#9a9aab",
  faint: "#6b6b7b",
  accent: "#7c7cf8",
  "accent-strong": "#6366f1",
} as const

type Token = keyof typeof STOCK
const TOKENS: ReadonlyArray<Token> = ["bg", "panel", "panel-2", "raised", "line", "line-strong", "fg", "muted", "faint", "accent", "accent-strong"]
const ACCENTS: ReadonlySet<Token> = new Set<Token>(["accent", "accent-strong"])
/** How much more coloured than the stock theme's the surfaces get from a tint as strong as its accent. */
const SURFACE_GAIN = 2.5

export const isHex = (s: unknown): s is string => typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s)

// sRGB and OKLCH (https://bottosson.github.io/posts/oklab/), for hues that look the same at every lightness.
type Lch = { l: number; c: number; h: number }
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const fromLinear = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)

export function hexToOklch(hex: string): Lch {
  const n = Number.parseInt(hex.slice(1), 16)
  const [r, g, b] = [toLinear((n >> 16) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 }
}

/** Linear sRGB of `lch`, out of [0, 1] when it's outside sRGB. */
function oklchToLinear({ l: L, c, h }: Lch): number[] {
  const A = c * Math.cos((h * Math.PI) / 180)
  const B = c * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

/** `lch` as a hex colour, with less chroma (same lightness and hue) where sRGB can't show it. */
export function oklchToHex(lch: Lch): string {
  const inGamut = (c: number) => oklchToLinear({ ...lch, c }).every((v) => v >= -1e-4 && v <= 1 + 1e-4)
  let c = lch.c
  if (!inGamut(c)) {
    let lo = 0
    for (let i = 0; i < 20; i++) {
      const mid = (lo + c) / 2
      if (inGamut(mid)) lo = mid
      else c = mid
    }
    c = lo
  }
  return (
    "#" +
    oklchToLinear({ ...lch, c })
      .map((v) => Math.round(Math.min(1, Math.max(0, fromLinear(v))) * 255))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  )
}

/** The theme's colours (index.css's `--color-*` names without the prefix) for tint `hex`. */
export function tintColors(hex: string): Record<Token, string> {
  const tint = hexToOklch(hex)
  const accent = hexToOklch(STOCK.accent)
  const strength = Math.min(tint.c / accent.c, 1)
  const colors: Record<Token, string> = { ...STOCK }
  for (const token of TOKENS) {
    const stock = hexToOklch(STOCK[token])
    // The accents take the tint's own chroma (the stronger one a little more, as the stock pair has), the rest a
    // multiple of the stock theme's slight colour.
    const c = ACCENTS.has(token) ? tint.c * (stock.c / accent.c) : stock.c * SURFACE_GAIN * strength
    colors[token] = oklchToHex({ l: stock.l, c, h: tint.h })
  }
  return colors
}

/** Puts tint `hex`'s colours on the page's root (or takes them off, for null), over index.css's. */
export function applyTint(hex: string | null, root: HTMLElement = document.documentElement) {
  const colors = hex ? tintColors(hex) : null
  for (const token of TOKENS) {
    if (colors) root.style.setProperty(`--color-${token}`, colors[token])
    else root.style.removeProperty(`--color-${token}`)
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", colors?.bg ?? STOCK.bg)
}

/**
 * The tint of the profile named `name`, whose profiles on every host the board merges: the first of them that has one,
 * the board's own host's first. undefined while there's no such profile (the board is loading).
 */
export function profileTint(
  profiles: ReadonlyArray<{ name: string; host_id: string; tint?: string | null }>,
  name: string | undefined,
  localHostId: string | null,
) {
  const named = profiles.filter((p) => p.name === name)
  if (!named.length) return undefined
  named.sort((a, b) => Number(b.host_id === localHostId) - Number(a.host_id === localHostId))
  const tint = named.find((p) => isHex(p.tint))?.tint
  return tint ? tint.toLowerCase() : null
}

/** The active profile's tint, and one the profile form shows while it's picked (undefined for none). */
let shown: string | null = null
let preview: string | null | undefined

const show = () => applyTint(preview !== undefined ? preview : shown)

/** The tint shown last, kept in this browser so the board opens with it before its profiles have loaded. */
function cachedTint(): string | null {
  try {
    const v = localStorage.getItem(KEY)
    return isHex(v) ? v.toLowerCase() : null
  } catch {
    return null
  }
}

/** Shows the active profile's tint (null for the stock theme). */
export function showProfileTint(hex: string | null) {
  shown = isHex(hex) ? hex.toLowerCase() : null
  try {
    if (shown) localStorage.setItem(KEY, shown)
    else localStorage.removeItem(KEY)
  } catch {
    // Without storage, the board opens with the stock theme until its profiles load.
  }
  show()
}

/** Shows `hex` instead while a tint is being picked (null for the stock theme), until it's called with undefined. */
export function previewTint(hex: string | null | undefined) {
  preview = hex === undefined ? undefined : isHex(hex) ? hex.toLowerCase() : null
  show()
}

/** Shows the tint the board had last, before its profiles load. */
export function setUpTint() {
  shown = cachedTint()
  show()
}
