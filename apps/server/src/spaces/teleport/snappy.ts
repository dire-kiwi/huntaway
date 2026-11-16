// Snappy's raw format, decompressed (HE-49): LevelDB's table blocks (Chrome's localStorage) and Firefox's localStorage
// values are compressed with it. https://github.com/google/snappy/blob/main/format_description.txt. No I/O here.

/** `b` decompressed, or null when it isn't valid Snappy. */
export const unsnappy = (b: Uint8Array): Uint8Array | null => {
  let i = 0
  let length = 0
  let shift = 0
  for (;;) {
    const x = b[i++]
    if (x === undefined || shift > 28) return null
    length += (x & 0x7f) * 2 ** shift
    shift += 7
    if (x < 0x80) break
  }
  const out = new Uint8Array(length)
  let o = 0
  while (i < b.length) {
    const tag = b[i++] ?? 0
    const kind = tag & 3
    if (kind === 0) {
      let len = tag >>> 2
      if (len >= 60) {
        const extra = len - 59
        len = 0
        for (let k = 0; k < extra; k++) len += (b[i + k] ?? 0) * 2 ** (8 * k)
        i += extra
      }
      len += 1
      if (i + len > b.length || o + len > length) return null
      out.set(b.subarray(i, i + len), o)
      i += len
      o += len
      continue
    }
    let len: number
    let offset: number
    if (kind === 1) {
      len = ((tag >>> 2) & 7) + 4
      offset = ((tag >>> 5) << 8) | (b[i] ?? 0)
      i += 1
    } else if (kind === 2) {
      len = (tag >>> 2) + 1
      offset = (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8)
      i += 2
    } else {
      len = (tag >>> 2) + 1
      offset = ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16)) + (b[i + 3] ?? 0) * 0x1000000
      i += 4
    }
    if (offset === 0 || offset > o || o + len > length) return null
    // A copy may overlap what it writes (a run), so byte by byte.
    for (let k = 0; k < len; k++) out[o + k] = out[o - offset + k] ?? 0
    o += len
  }
  return o === length ? out : null
}
