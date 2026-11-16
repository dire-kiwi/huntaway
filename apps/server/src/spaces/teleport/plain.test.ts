import { assert, describe, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import { CATALOG, chromiumProfiles, firefoxProfiles } from "./browsers.ts"
import { manifestValue, signInEntries, tar } from "./bundle.ts"
import type { CookieRow } from "./bundle.ts"
import { storageItems, storageOrigins } from "./chromiumStorage.ts"
import type { StorageFile } from "./chromiumStorage.ts"
import { latest, readLog, readTable } from "./leveldb.ts"
import { approvedSites, askInput, checkSites, pickProfile } from "./request.ts"
import type { Candidate } from "./request.ts"
import { hostKeyInSite, isIdentityProvider, looksSignedIn, normalizeHost, originHost, registrableDomain } from "./sites.ts"
import { unsnappy } from "./snappy.ts"
import { headerRefusal, importRequest, manifestRequest, parseImport, parseManifest, parseWipe, unframe, wipeRequest } from "./wire.ts"

// Teleport's pure parts (HE-49): the gRPC-Web/protobuf messages, the tar bundle, the Snappy and LevelDB readers that
// read a Chromium localStorage folder, and the site-grouping rules.

const dec = new TextDecoder()
const encodeJson = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown))
const jsonBytes = (value: unknown): Uint8Array => new TextEncoder().encode(Option.getOrElse(encodeJson(value), () => "null"))

/** A write batch with one or more `type=1 key value` records, as a `.log` file. */
const logFile = (records: ReadonlyArray<ReadonlyArray<number>>): Uint8Array => {
  const batch = [0, 0, 0, 0, 0, 0, 0, 0, records.length, 0, 0, 0, ...records.flat()]
  return Uint8Array.from([0, 0, 0, 0, batch.length & 0xff, (batch.length >> 8) & 0xff, 1, ...batch])
}
/** A put record (`type=1 keylen key vallen value`). */
const putRecord = (key: string, value: string): Array<number> => {
  const k = new TextEncoder().encode(key)
  const v = new TextEncoder().encode(value)
  return [1, k.length, ...k, v.length, ...v]
}

/** Reads one length-delimited field (a message) at `no` from a protobuf message; for checking what we wrote. */
const fieldBytes = (b: Uint8Array): Map<number, Array<Uint8Array | number>> => {
  const out = new Map<number, Array<Uint8Array | number>>()
  let i = 0
  const varint = () => {
    let v = 0
    let s = 1
    for (;;) {
      const x = b[i++] ?? 0
      v += (x & 0x7f) * s
      if (x < 0x80) return v
      s *= 0x80
    }
  }
  const add = (n: number, v: Uint8Array | number) => out.set(n, [...(out.get(n) ?? []), v])
  while (i < b.length) {
    const k = varint()
    const no = Math.floor(k / 8)
    if (k % 8 === 0) add(no, varint())
    else if (k % 8 === 2) {
      const len = varint()
      add(no, b.subarray(i, i + len))
      i += len
    } else break
  }
  return out
}

/** Frames a message as a gRPC-Web data frame (what spacesd sends back), so `unframe` has something to read. */
const frame = (message: Uint8Array): Uint8Array => {
  const n = message.length
  const out = new Uint8Array(5 + n)
  out.set([0, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
  out.set(message, 5)
  return out
}

const bytesAt = (m: Map<number, Array<Uint8Array | number>>, no: number): Uint8Array => {
  const v = m.get(no)?.[0]
  return v instanceof Uint8Array ? v : new Uint8Array()
}
const intAt = (m: Map<number, Array<Uint8Array | number>>, no: number): number => {
  const v = m.get(no)?.[0]
  return typeof v === "number" ? v : -1
}

describe("wire", () => {
  it("writes a GetManifest request with the app and session scope", () => {
    const body = manifestRequest("chrome")
    const fields = fieldBytes(body.subarray(5))
    assert.strictEqual(dec.decode(bytesAt(fields, 1)), "chrome")
    assert.strictEqual(intAt(fields, 2), 1)
  })

  it("writes an ImportSession chunk, data last, commit fields only on the last", () => {
    const data = Uint8Array.from([1, 2, 3, 4])
    const mid = fieldBytes(importRequest({ importId: "imp", app: "chrome", offset: 0, data, commit: null }).subarray(5))
    assert.strictEqual(dec.decode(bytesAt(mid, 1)), "imp")
    assert.deepStrictEqual([...bytesAt(mid, 5)], [1, 2, 3, 4])
    assert.isUndefined(mid.get(6))
    const last = fieldBytes(importRequest({ importId: "imp", app: "chrome", offset: 4, data, commit: { sha256: "ab", expiresAtMs: 0 } }).subarray(5))
    assert.strictEqual(intAt(last, 6), 1)
    assert.strictEqual(dec.decode(bytesAt(last, 7)), "ab")
  })

  it("writes a WipeImport request with the import id", () => {
    const fields = fieldBytes(wipeRequest("imp-1").subarray(5))
    assert.strictEqual(dec.decode(bytesAt(fields, 1)), "imp-1")
  })

  it("reads a GetManifest response", () => {
    // supported=1, bundle_version=1, supported_apps=["chrome","firefox"]
    const msg = Uint8Array.from([8, 1, 40, 1, 58, 6, 99, 104, 114, 111, 109, 101, 58, 7, 102, 105, 114, 101, 102, 111, 120])
    const m = parseManifest(msg)
    assert.isNotNull(m)
    assert.isTrue(m?.supported)
    assert.strictEqual(m?.bundleVersion, 1)
    assert.deepStrictEqual(m?.supportedApps, ["chrome", "firefox"])
  })

  it("reads an ImportSession response with its result on the last chunk", () => {
    // received_bytes=10 (field1), result{ imported=["cookies"] } (field3)
    const result = Uint8Array.from([10, 7, 99, 111, 111, 107, 105, 101, 115])
    const msg = Uint8Array.from([8, 10, 26, result.length, ...result])
    const a = parseImport(msg)
    assert.strictEqual(a?.receivedBytes, 10)
    assert.deepStrictEqual(a?.result?.imported, ["cookies"])
  })

  it("unframes a data frame and reports a trailer refusal", () => {
    const ok = unframe(frame(Uint8Array.from([8, 1])))
    assert.isTrue("message" in ok)
    const trailer = new TextEncoder().encode("grpc-status: 5\r\ngrpc-message: not%20found\r\n")
    const refused = unframe(Uint8Array.from([0x80, 0, 0, 0, trailer.length, ...trailer]))
    assert.deepStrictEqual(refused, { refused: "5: not found" })
  })

  it("reads a header refusal", () => {
    assert.isNull(headerRefusal({ "grpc-status": "0" }))
    assert.strictEqual(headerRefusal({ "grpc-status": "7", "grpc-message": "denied" }), "7: denied")
  })

  it("reads a WipeImport response", () => {
    // wiped_import_ids=["imp"] (field1), cookie_rows_removed=3 (field4)
    const msg = Uint8Array.from([10, 3, 105, 109, 112, 32, 3])
    const w = parseWipe(msg)
    assert.deepStrictEqual(w?.wiped, ["imp"])
    assert.strictEqual(w?.cookieRowsRemoved, 3)
  })
})

describe("bundle / tar", () => {
  const cookie: CookieRow = {
    host_key: ".github.com",
    name: "sess",
    value: Uint8Array.from([1, 2, 3]),
    path: "/",
    expires_utc: 0,
    is_secure: true,
    is_httponly: true,
    samesite: 1,
  }

  it("builds a tar whose first entry is manifest.json and whose entries match the manifest", () => {
    const parts = signInEntries("chrome", [cookie], [{ origin: "https://github.com", key: "k", value: "v" }]).map((e) => ({
      path: e.path,
      mode: e.mode,
      bytes: jsonBytes(e.value),
    }))
    const manifest = {
      path: "manifest.json",
      mode: 0o644,
      bytes: jsonBytes(
        manifestValue(
          "chrome",
          parts,
          parts.map(() => "x"),
        ),
      ),
    }
    const archive = tar([manifest, ...parts])
    // First tar entry's name is manifest.json.
    assert.strictEqual(dec.decode(archive.subarray(0, 100)).replace(/\0.*$/u, ""), "manifest.json")
    // The archive is a whole number of 512-byte blocks and ends with two empty ones.
    assert.strictEqual(archive.length % 512, 0)
    assert.isTrue(archive.subarray(archive.length - 1024).every((b) => b === 0))
    // cookies.json holds the base64 value.
    const joined = dec.decode(archive)
    assert.include(joined, "cookies.json")
    assert.include(joined, "AQID") // base64 of [1,2,3]
  })

  it("names the tabs file by provider", () => {
    assert.strictEqual(signInEntries("chrome", [], [])[0]?.path, "tabs.json")
    assert.strictEqual(signInEntries("firefox", [], [])[0]?.path, "firefox/tabs.json")
  })
})

describe("snappy", () => {
  it("decompresses a literal followed by a copy", () => {
    // Want "abcabc": preamble len 6, literal "abc", copy offset 3 len 3 (2-byte offset form).
    const compressed = Uint8Array.from([0x06, 0x08, 0x61, 0x62, 0x63, 0x0a, 0x03, 0x00])
    assert.strictEqual(dec.decode(unsnappy(compressed) ?? new Uint8Array()), "abcabc")
  })

  it("returns null on garbage", () => {
    assert.isNull(unsnappy(Uint8Array.from([0xff, 0xff, 0xff])))
  })
})

describe("leveldb log", () => {
  it("reads a batch's puts and keeps the newest value by sequence", () => {
    const map = latest([readLog(logFile([putRecord("a", "one"), putRecord("a", "two")]))])
    assert.strictEqual(dec.decode(map.get("a") ?? new Uint8Array()), "two")
  })
})

/** A LevelDB block: entries (no prefix sharing), one restart at 0, the restart count. */
const block = (entries: ReadonlyArray<readonly [ReadonlyArray<number>, ReadonlyArray<number>]>): Array<number> => [
  ...entries.flatMap(([k, v]) => [0, k.length, v.length, ...k, ...v]),
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
]
/** An internal key: the user key, then `type` and sequence number 7. */
const internal = (user: string, type: number): Array<number> => [...new TextEncoder().encode(user), type, 7, 0, 0, 0, 0, 0, 0]
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]

/** A table with one data block holding `user`=`value`, whose index separator is that key with type `indexType`. */
const table = (user: string, value: string, indexType: number): Uint8Array => {
  const data = block([[internal(user, 1), [...new TextEncoder().encode(value)]]])
  const index = block([[internal(user, indexType), [0, data.length]]])
  const meta = block([])
  const trailer = [0, 0, 0, 0, 0]
  const indexAt = data.length + trailer.length
  const metaAt = indexAt + index.length + trailer.length
  const handles = [metaAt, meta.length, indexAt, index.length]
  const footer = [...handles, ...Array.from({ length: 40 - handles.length }, () => 0), ...le32(0x8b80fb57), ...le32(0xdb477524)]
  return Uint8Array.from([...data, ...trailer, ...index, ...trailer, ...meta, ...trailer, ...footer])
}

describe("leveldb table", () => {
  it("reads a data block whatever its index separator's type, a deletion included", () => {
    for (const type of [1, 0]) {
      const map = latest([readTable(table("k", "v", type))])
      assert.strictEqual(dec.decode(map.get("k") ?? new Uint8Array()), "v", `index key type ${type}`)
    }
  })
})

describe("chromium localStorage", () => {
  // A localStorage leveldb entry: key `_<origin>\0<fmt><key>`, value `<fmt><value>` (fmt 1 = Latin-1).
  it("lists origins and reads items of the chosen origins", () => {
    const files: ReadonlyArray<StorageFile> = [
      {
        name: "000003.log",
        bytes: logFile([
          putRecord("META:https://github.com", "\u0000meta"),
          putRecord("_https://github.com\u0000\u0001theme", "\u0001dark"),
          putRecord("_https://other.com\u0000\u0001x", "\u0001y"),
        ]),
      },
    ]
    assert.includeMembers([...storageOrigins(files)], ["https://github.com", "https://other.com"])
    const items = storageItems(files, new Set(["https://github.com"]))
    assert.deepStrictEqual([...items], [{ origin: "https://github.com", key: "theme", value: "dark" }])
  })
})

describe("sites", () => {
  it("finds the registrable domain", () => {
    assert.strictEqual(registrableDomain("api.github.com"), "github.com")
    assert.strictEqual(registrableDomain("www.example.co.uk"), "example.co.uk")
    assert.strictEqual(registrableDomain("github.com"), "github.com")
  })
  it("matches a host_key to its site and not a look-alike", () => {
    assert.isTrue(hostKeyInSite(".github.com", "github.com"))
    assert.isTrue(hostKeyInSite("api.github.com", "github.com"))
    assert.isFalse(hostKeyInSite("evilgithub.com", "github.com"))
    assert.isFalse(hostKeyInSite("github.com.evil.example", "github.com"))
  })
  it("knows identity providers", () => {
    assert.isTrue(isIdentityProvider("accounts.google.com"))
    assert.isTrue(isIdentityProvider("my-tenant.okta.com"))
    assert.isFalse(isIdentityProvider("github.com"))
  })
  it("guesses a sign-in from cookie names", () => {
    assert.isTrue(looksSignedIn(["__Host-session"]))
    assert.isTrue(looksSignedIn(["auth_token"]))
    assert.isFalse(looksSignedIn(["theme", "locale"]))
  })
  it("normalizes a host and reads an origin's host", () => {
    assert.strictEqual(normalizeHost(".GitHub.com"), "github.com")
    assert.strictEqual(originHost("https://github.com:443"), "github.com")
    assert.strictEqual(originHost("not a url"), "")
  })
})

/** A site as a profile lists it. */
const site = (s: string, cookies: number, identity = false) => ({
  site: s,
  cookie_count: cookies,
  storage_count: 0,
  signed_in: true,
  identity_provider: identity,
})

describe("space_request_sign_ins", () => {
  const work: Candidate = {
    browser: "google-chrome",
    browserLabel: "Google Chrome",
    profile: "Profile 1",
    profileLabel: "Work",
    sites: [site("github.com", 3)],
  }
  const me: Candidate = {
    browser: "chromium",
    browserLabel: "Chromium",
    profile: "Default",
    profileLabel: "Me",
    sites: [site("github.com", 9), site("google.com", 4, true), site("figma.com", 1)],
  }

  it("takes only registrable domains", () => {
    assert.deepStrictEqual(checkSites(["GitHub.com", "com", "api.github.com", "github.com", "co.uk", "bbc.co.uk", " "]), {
      valid: ["github.com", "bbc.co.uk"],
      invalid: ["com", "api.github.com", "co.uk"],
    })
  })

  it("picks the profile holding most of the sites, and offers only those, identity providers unticked", () => {
    const wanted = ["github.com", "google.com", "nothere.com"]
    const picked = pickProfile([work, me], wanted)
    assert.strictEqual(picked?.profile, "Default")
    assert.isNull(pickProfile([work], ["nothere.com"]))
    const input = askInput({ id: "s1", name: "Signed" }, me, wanted)
    assert.deepStrictEqual(input.sites, ["github.com"])
    assert.deepStrictEqual(
      input.offered.map((o) => o.site),
      ["github.com", "google.com"],
    )
    assert.deepStrictEqual(input.not_found, ["nothere.com"])
  })

  it("sends back only what was offered and left ticked", () => {
    const offered = ["github.com", "google.com"]
    assert.deepStrictEqual(approvedSites({ sites: ["google.com", "evil.com", "GitHub.com"] }, offered), ["google.com", "github.com"])
    assert.deepStrictEqual(approvedSites({ sites: [] }, offered), [])
    assert.deepStrictEqual(approvedSites("garbage", offered), [])
  })
})

describe("browsers", () => {
  it("looks each Chromium-family browser's Safe Storage secret up under its own name", () => {
    const keyrings = Object.fromEntries(CATALOG.map((b) => [b.key, b.keyring]))
    assert.strictEqual(keyrings["google-chrome"], "chrome")
    assert.strictEqual(keyrings["chromium"], "chromium")
    assert.strictEqual(keyrings["firefox"], null)
    const named = CATALOG.filter((b) => b.kind === "chromium").map((b) => b.keyring)
    assert.strictEqual(new Set(named).size, named.length, "no two browsers share a keyring name")
  })

  it("reads Chromium profiles from Local State, Default first", () => {
    const ls = dec.decode(jsonBytes({ profile: { info_cache: { "Profile 1": { name: "Work" }, Default: { name: "Me" } } } }))
    assert.deepStrictEqual(chromiumProfiles(ls), [
      { id: "Default", label: "Me" },
      { id: "Profile 1", label: "Work" },
    ])
    assert.deepStrictEqual(chromiumProfiles(null), [{ id: "Default", label: "Default" }])
  })
  it("reads Firefox profiles from profiles.ini", () => {
    const ini = "[Profile0]\nName=default\nIsRelative=1\nPath=abcd.default\n\n[Profile1]\nName=dev\nPath=/abs/dev\n"
    assert.deepStrictEqual(firefoxProfiles(ini), [
      { id: "abcd.default", label: "default" },
      { id: "/abs/dev", label: "dev" },
    ])
  })
})
