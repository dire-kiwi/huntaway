import { latest, readLog, readTable } from "./leveldb.ts"
import type { StorageItem } from "./bundle.ts"

// Chrome's localStorage, read from its `Local Storage/leveldb` folder (HE-49). The database (`leveldb.ts`) keys each
// value `"_" + origin + "\0" + key`, with `META:` rows for each origin and a `VERSION` row left aside. The key after the
// NUL and the value each start with a format byte: 0 means UTF-16LE, 1 means Latin-1 (one byte a character). Only the
// origins asked for are kept. No I/O here: it takes each file's bytes.

/** A file of the leveldb folder, named so logs and tables are told apart. */
export interface StorageFile {
  readonly name: string
  readonly bytes: Uint8Array
}

const u16le = new TextDecoder("utf-16le")

/** A stored string: format byte then UTF-16LE or Latin-1. Null when empty. */
const decodeString = (b: Uint8Array): string | null => {
  if (b.length === 0) return null
  const body = b.subarray(1)
  if (b[0] === 0) return u16le.decode(body)
  let s = ""
  for (const c of body) s += String.fromCharCode(c)
  return s
}

/** The origins a leveldb folder holds localStorage for (its `META:` rows and the origins of its value rows), each once. */
export const storageOrigins = (files: ReadonlyArray<StorageFile>): ReadonlyArray<string> => {
  const map = readFolder(files)
  const origins = new Set<string>()
  for (const latinKey of map.keys()) {
    if (latinKey.startsWith("META:")) origins.add(latinKey.slice("META:".length))
    else if (latinKey.startsWith("_")) {
      const nul = latinKey.indexOf("\0")
      if (nul > 1) origins.add(latinKey.slice(1, nul))
    }
  }
  return [...origins]
}

/** The localStorage items of the given origins. */
export const storageItems = (files: ReadonlyArray<StorageFile>, origins: ReadonlySet<string>): ReadonlyArray<StorageItem> => {
  const map = readFolder(files)
  const out: Array<StorageItem> = []
  for (const [latinKey, valueBytes] of map) {
    if (!latinKey.startsWith("_")) continue
    const nul = latinKey.indexOf("\0")
    if (nul < 0) continue
    const origin = latinKey.slice(1, nul)
    if (!origins.has(origin)) continue
    // The script key is the bytes after the NUL, as stored (format byte and all).
    const keyBytes = Uint8Array.from(latinKey.slice(nul + 1), (c) => c.charCodeAt(0) & 0xff)
    const key = decodeString(keyBytes)
    const value = decodeString(valueBytes)
    if (key !== null && value !== null) out.push({ origin, key, value })
  }
  return out
}

const readFolder = (files: ReadonlyArray<StorageFile>): Map<string, Uint8Array> =>
  latest(files.map((f) => (f.name.endsWith(".log") ? readLog(f.bytes) : f.name.endsWith(".ldb") || f.name.endsWith(".sst") ? readTable(f.bytes) : [])))
