import { unsnappy } from "./snappy.ts"

// A LevelDB database read whole (HE-49), for Chrome's `Local Storage/leveldb`: its write-ahead logs (`*.log`) and its
// tables (`*.ldb`/`*.sst`), newest value per key by sequence number, deletions applied. Reading only, of a copy of the
// folder (the source browser may be running), so no manifest is needed: every entry carries its own sequence number.
// https://github.com/google/leveldb/blob/main/doc/{log_format,table_format}.md. No I/O here.

/** The decoded entries of one file, as internal-key bytes mapped to a value (null is a deletion) and a sequence number. */
export interface KeyValue {
  readonly key: Uint8Array
  readonly value: Uint8Array | null
  readonly seq: number
}

const u32 = (b: Uint8Array, at: number) => ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16)) + (b[at + 3] ?? 0) * 0x1000000

/** A varint at `at`: its value and the position after it, or null when it runs off the end. */
const varint = (b: Uint8Array, at: number): readonly [number, number] | null => {
  let v = 0
  let mul = 1
  for (let i = at; i < b.length && i < at + 10; i++) {
    const x = b[i] ?? 0
    v += (x & 0x7f) * mul
    if (x < 0x80) return [v, i + 1]
    mul *= 0x80
  }
  return null
}

// ---- write-ahead log (*.log): 32 KiB blocks of records, a batch's entries spread across fragments ----

const LOG_BLOCK = 32768
const LOG_HEADER = 7

/** Reassembles a `*.log` file's record payloads (each a write batch). */
const logRecords = (b: Uint8Array): Array<Uint8Array> => {
  const out: Array<Uint8Array> = []
  let at = 0
  let partial: Array<Uint8Array> = []
  while (at + LOG_HEADER <= b.length) {
    const inBlock = LOG_BLOCK - (at % LOG_BLOCK)
    if (inBlock < LOG_HEADER) {
      at += inBlock
      continue
    }
    const len = (b[at + 4] ?? 0) | ((b[at + 5] ?? 0) << 8)
    const type = b[at + 6] ?? 0
    const start = at + LOG_HEADER
    if (start + len > b.length) break
    const payload = b.subarray(start, start + len)
    at = start + len
    if (type === 1) out.push(payload)
    else if (type === 2) partial = [payload]
    else if (type === 3) partial.push(payload)
    else if (type === 4) {
      partial.push(payload)
      const whole = new Uint8Array(partial.reduce((n, p) => n + p.length, 0))
      let o = 0
      for (const p of partial) {
        whole.set(p, o)
        o += p.length
      }
      out.push(whole)
      partial = []
    }
  }
  return out
}

/** The entries of one write batch (`seq(8) count(4)` then `type key [value]` records). */
const batchEntries = (b: Uint8Array): Array<KeyValue> => {
  const out: Array<KeyValue> = []
  const seq0 = u32(b, 0) + u32(b, 4) * 0x100000000
  const count = u32(b, 8)
  let at = 12
  for (let n = 0; n < count && at < b.length; n++) {
    const type = b[at++] ?? 0
    const k = varint(b, at)
    if (k === null) break
    const key = b.subarray(k[1], k[1] + k[0])
    at = k[1] + k[0]
    if (type === 1) {
      const v = varint(b, at)
      if (v === null) break
      out.push({ key, value: b.subarray(v[1], v[1] + v[0]), seq: seq0 + n })
      at = v[1] + v[0]
    } else {
      out.push({ key, value: null, seq: seq0 + n })
    }
  }
  return out
}

/** A `*.log` file's entries. */
export const readLog = (b: Uint8Array): Array<KeyValue> => logRecords(b).flatMap(batchEntries)

// ---- table (*.ldb / *.sst) ----

const FOOTER = 48
// The table footer's magic, `0xdb4775248b80fb57`, split into its low and high 32-bit halves (a 64-bit literal would
// lose precision as a JS number).
const MAGIC_LO = 0x8b80fb57
const MAGIC_HI = 0xdb477524

/** A block handle (two varints: offset and size) at `at`. */
const handle = (b: Uint8Array, at: number): readonly [number, number, number] | null => {
  const off = varint(b, at)
  if (off === null) return null
  const size = varint(b, off[1])
  if (size === null) return null
  return [off[0], size[0], size[1]]
}

/**
 * A block's entries as stored: each key (prefix-compressed against the one before: `shared non_shared value_len`) and
 * its value, nothing interpreted. The last 4 bytes are the restart count, after the restart offsets.
 */
const rawEntries = (block: Uint8Array): Array<{ readonly key: Uint8Array; readonly value: Uint8Array }> => {
  const out: Array<{ readonly key: Uint8Array; readonly value: Uint8Array }> = []
  const restartCount = u32(block, block.length - 4)
  const end = block.length - 4 - restartCount * 4
  let at = 0
  let last = new Uint8Array(0)
  while (at < end) {
    const shared = varint(block, at)
    if (shared === null) break
    const nonShared = varint(block, shared[1])
    if (nonShared === null) break
    const valueLen = varint(block, nonShared[1])
    if (valueLen === null) break
    let p = valueLen[1]
    const key = new Uint8Array(shared[0] + nonShared[0])
    key.set(last.subarray(0, shared[0]), 0)
    key.set(block.subarray(p, p + nonShared[0]), shared[0])
    p += nonShared[0]
    out.push({ key, value: block.subarray(p, p + valueLen[0]) })
    p += valueLen[0]
    last = key
    at = p
  }
  return out
}

/**
 * A data block's entries: each key is an internal key, the user key then 8 bytes `type(1) seq(7)`; type 0 is a
 * deletion. (An index block's keys are internal keys too, but only separators: its values are read as they are.)
 */
const blockEntries = (block: Uint8Array): Array<KeyValue> =>
  rawEntries(block).flatMap(({ key, value }) => {
    const trailer = key.length - 8
    if (trailer < 0) return []
    const tag = key[trailer] ?? 0
    const seq =
      (key[trailer + 1] ?? 0) +
      (key[trailer + 2] ?? 0) * 0x100 +
      (key[trailer + 3] ?? 0) * 0x10000 +
      (key[trailer + 4] ?? 0) * 0x1000000 +
      (key[trailer + 5] ?? 0) * 0x100000000
    return [{ key: key.subarray(0, trailer), value: tag === 0 ? null : value, seq }]
  })

/** A block at `handle`, its trailer's compression byte applied (0 none, 1 Snappy). */
const readBlock = (b: Uint8Array, off: number, size: number): Uint8Array | null => {
  if (off + size > b.length) return null
  const raw = b.subarray(off, off + size)
  const compression = b[off + size] ?? 0
  return compression === 1 ? unsnappy(raw) : raw
}

/** A `*.ldb`/`*.sst` table's entries (its index points at every data block). */
export const readTable = (b: Uint8Array): Array<KeyValue> => {
  if (b.length < FOOTER) return []
  const footer = b.subarray(b.length - FOOTER)
  if (u32(footer, FOOTER - 8) !== MAGIC_LO || u32(footer, FOOTER - 4) !== MAGIC_HI) return []
  // The footer's two handles are the metaindex then the index; skip the metaindex.
  const meta = handle(footer, 0)
  if (meta === null) return []
  const index = handle(footer, meta[2])
  if (index === null) return []
  const indexBlock = readBlock(b, index[0], index[1])
  if (indexBlock === null) return []
  const out: Array<KeyValue> = []
  // Every index entry points at a data block, whatever its separator key's type (the last key of a block, kept as it
  // is when it can't be shortened, may be a deletion).
  for (const e of rawEntries(indexBlock)) {
    const h = handle(e.value, 0)
    if (h === null) continue
    const data = readBlock(b, h[0], h[1])
    if (data !== null) out.push(...blockEntries(data))
  }
  return out
}

/** The newest value per key across a set of files' entries, deletions left out, as Latin-1-keyed bytes. */
export const latest = (files: ReadonlyArray<ReadonlyArray<KeyValue>>): Map<string, Uint8Array> => {
  const best = new Map<string, { value: Uint8Array | null; seq: number }>()
  for (const file of files) {
    for (const e of file) {
      let s = ""
      for (let i = 0; i < e.key.length; i += 0x8000) s += String.fromCharCode(...e.key.subarray(i, i + 0x8000))
      const had = best.get(s)
      if (had === undefined || e.seq >= had.seq) best.set(s, { value: e.value, seq: e.seq })
    }
  }
  const out = new Map<string, Uint8Array>()
  for (const [k, v] of best) if (v.value !== null) out.set(k, v.value)
  return out
}
