// The speech models a host can download for dictation (HE-89): a few from T3 Code's catalog, which is
// `@handy-computer/models` (transcribe.cpp's GGUF builds on Hugging Face, each pinned to a revision with its size and
// SHA-256). To add one, copy its entry from there; the file is downloaded from
// `https://huggingface.co/<id>/resolve/<revision>/<filename>`.

export interface CatalogModel {
  readonly id: string
  readonly revision: string
  readonly name: string
  readonly description: string
  readonly filename: string
  readonly size: number
  readonly sha256: string
  readonly languages: ReadonlyArray<string>
  readonly recommended: boolean
}

const WHISPER_LANGUAGES =
  "af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu haw ha he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my ne nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk ur uz vi yi yo zh".split(
    " ",
  )

/** In the order Settings lists them: the recommended first. */
export const CATALOG: ReadonlyArray<CatalogModel> = [
  {
    id: "handy-computer/parakeet-unified-en-0.6b-gguf",
    revision: "7e948f21b7bdbac698d3318db9d350f1096f3b6c",
    name: "Parakeet Unified English 0.6B",
    description: "The best all-round choice for English",
    filename: "parakeet-unified-en-0.6b-Q8_0.gguf",
    size: 731_357_568,
    sha256: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
    languages: ["en"],
    recommended: true,
  },
  {
    id: "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
    revision: "6d44e540bc31b0de1dbe174a3cea87f53a7f22fb",
    name: "Nemotron Streaming 3.5",
    description: "Fast and accurate in many languages",
    filename: "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
    size: 751_094_240,
    sha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c",
    languages: "en es fr it pt nl de tr ru ar hi ja ko vi uk pl sv cs nb da bg fi hr sk zh hu ro et".split(" "),
    recommended: true,
  },
  {
    id: "handy-computer/canary-180m-flash-gguf",
    revision: "46b86384d1db59108d6e060a0fc00924cb58499f",
    name: "Canary 180M Flash",
    description: "Small and fast, on any hardware: English, German, Spanish and French",
    filename: "canary-180m-flash-Q8_0.gguf",
    size: 218_447_648,
    sha256: "f942ab746040b531a29ab78ca3afc8dc9564efd8e4c942b5541e53644be9c408",
    languages: ["en", "de", "es", "fr"],
    recommended: false,
  },
  {
    id: "handy-computer/whisper-small-gguf",
    revision: "c0214bd34be9296695486f838e0142f900803159",
    name: "Whisper Small",
    description: "The most languages, in a small model; slower than the others",
    filename: "whisper-small-Q8_0.gguf",
    size: 269_751_136,
    sha256: "9b9c8811bbcc82a7766f0fb0925614bdacb0923b2cc630daeac17108b655b860",
    languages: WHISPER_LANGUAGES,
    recommended: false,
  },
  {
    id: "handy-computer/moonshine-base-gguf",
    revision: "3ef112378a8cf46ac8b278d9bfa2d15c846704b8",
    name: "Moonshine Base",
    description: "The smallest download, for English",
    filename: "moonshine-base-Q8_0.gguf",
    size: 77_476_480,
    sha256: "7f0027dfd857d310b63a85ef57cadf183da712cc374f85a648f8bc18aaa2efc8",
    languages: ["en"],
    recommended: false,
  },
]

/** Where a model is downloaded from. */
export const modelUrl = (m: Pick<CatalogModel, "id" | "revision" | "filename">) => `https://huggingface.co/${m.id}/resolve/${m.revision}/${m.filename}`
