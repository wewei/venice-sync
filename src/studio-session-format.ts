import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { assertSafeJson, isRecord, text, timestamp } from "./conversation-format"
import { libraryKind, MAX_LIBRARY_FILE } from "./library-format"
import { sha256 } from "./mind-package-format"

export const MAX_STUDIO_ZIP = 128 * 1024 * 1024
const MAX_METADATA = 8 * 1024 * 1024
export type StudioKind = "image" | "audio"
export interface StudioFile { id: string; path: string; mimeType: string; size: number; sha256: string }
export interface StudioManifest {
  format: "venice-sync-studio-session"
  version: 1
  exportedAt: string
  kind: StudioKind
  session: Record<string, unknown>
  turns: Record<string, unknown>[]
  media: Record<string, unknown>[]
  files: StudioFile[]
}
export interface StudioPackage { manifest: StudioManifest; files: Record<string, Uint8Array> }

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export function studioId(value: unknown): string {
  const id = text(value, "Studio ID")
  if (!uuidPattern.test(id)) throw new Error("Unsupported Studio ID; UUID required.")
  return id
}
function record(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Unsupported Studio fields. Active jobs, account fields and unknown references cannot be transferred.")
  }
  studioId(value.id)
  timestamp(value.createdAtUnixTimestamp, "createdAtUnixTimestamp")
  return value
}
function privateFields(value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite numbers are not supported in Studio archives.")
  if (typeof value !== "object" || value === null) return
  for (const [key, entry] of Object.entries(value)) {
    if (key.startsWith("_") || ["ownerId", "owner_id", "token", "authorization", "encryptionKey"].includes(key)) {
      throw new Error("Studio archive contains private account or database fields.")
    }
    privateFields(entry)
  }
}
export function studioFilePath(sessionId: string, id: string, mimeType: string, path: unknown): string {
  studioId(sessionId); studioId(id)
  if (typeof path !== "string" || !path.startsWith(`media/${sessionId}/${id}.`)) throw new Error("Foreign Studio media path.")
  const extension = path.slice(`media/${sessionId}/${id}.`.length)
  const extensions: Record<string, string[]> = {
    "image/png": ["png"], "image/jpeg": ["jpg", "jpeg"], "image/webp": ["webp"],
    "image/gif": ["gif"], "image/avif": ["avif"], "image/bmp": ["bmp"],
    "audio/mpeg": ["mp3"], "audio/wav": ["wav"], "audio/x-wav": ["wav"], "audio/ogg": ["ogg"],
    "audio/mp4": ["m4a", "mp4"], "audio/flac": ["flac"], "audio/webm": ["webm"], "audio/aac": ["aac"],
  }
  if (!extensions[mimeType]?.includes(extension)) throw new Error("Unsupported Studio file extension/MIME.")
  return path
}
function audioSettings(value: unknown): void {
  if (value === undefined) return
  if (!isRecord(value) || Object.entries(value).some(([key, item]) => ![
    "durationSeconds", "forceInstrumental", "genreStyle", "languageCode", "lyricsOptimizer", "musicSubcategory", "speed", "loudness", "pitch",
    "loop", "enableSubtitle", "voice", "sourceAudio", "removeBackgroundNoise", "seed",
  ].includes(key) || (item !== null && !["string", "number", "boolean"].includes(typeof item)))) throw new Error("Unsupported Studio audio settings or source-audio attachment.")
  if (value.sourceAudio != null || (typeof value.voice === "string" && value.voice.startsWith("vv_"))) {
    throw new Error("Source-audio attachments and account-bound cloned voices are not portable yet.")
  }
}
function subtitles(value: unknown): void {
  if (value === undefined || value === null) return
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "sentences") || !Array.isArray(value.sentences)) throw new Error("Unsupported Studio subtitle format.")
  const span = (value: unknown, sentence: boolean) => {
    if (!isRecord(value) || Object.keys(value).some((key) => !["text", "start_time", "end_time", ...(sentence ? ["words"] : [])].includes(key)) ||
        typeof value.text !== "string" || typeof value.start_time !== "number" || typeof value.end_time !== "number" ||
        value.start_time < 0 || value.end_time < value.start_time) throw new Error("Unsupported Studio subtitle span.")
    return value
  }
  for (const item of value.sentences) {
    const sentence = span(item, true)
    if (sentence.words !== undefined) {
      if (!Array.isArray(sentence.words)) throw new Error("Invalid Studio subtitle words.")
      sentence.words.forEach((word: unknown) => span(word, false))
    }
  }
}
export function validateStudioManifest(value: unknown): StudioManifest {
  assertSafeJson(value); privateFields(value)
  if (!isRecord(value) || value.format !== "venice-sync-studio-session" || value.version !== 1 || !["image", "audio"].includes(String(value.kind))) {
    throw new Error("Select a classic Studio image/audio session v1 ZIP. Beta projects and video sessions are not supported.")
  }
  const kind: StudioKind = value.kind === "audio" ? "audio" : "image", audio = kind === "audio"
  const session = record(value.session, ["id", "type", "createdAtUnixTimestamp", "updatedAtUnixTimestamp", "name", audio ? "selectedAudioId" : "selectedImageId"])
  const sessionId = studioId(session.id)
  timestamp(session.updatedAtUnixTimestamp, "updatedAtUnixTimestamp")
  if (!(audio ? ["audio-generate"] : ["generate", "edit"]).includes(String(session.type)) || typeof session.name !== "string") throw new Error("Unsupported Studio session type/name.")
  if (!Array.isArray(value.turns) || !Array.isArray(value.media) || !Array.isArray(value.files) ||
      value.turns.length > 10000 || value.media.length > 2048 || value.files.length > 2048) throw new Error("Invalid Studio collections or too many records.")
  const ids = new Set([sessionId]), turnIds = new Set<string>(), mediaIds = new Set<string>()
  const unique = (row: Record<string, unknown>) => {
    const id = studioId(row.id)
    if (ids.has(id)) throw new Error("Duplicate Studio identifiers.")
    ids.add(id)
    if (row.sessionId !== sessionId) throw new Error("Foreign Studio session reference.")
    return id
  }
  const turns = value.turns.map((entry: unknown) => {
    const row = record(entry, ["id", "sessionId", "createdAtUnixTimestamp", "prompt", ...(audio ? ["effectivePrompt", "lyricsPrompt", "settings"] : ["mode", "input"])])
    turnIds.add(unique(row))
    if (typeof row.prompt !== "string" || (row.mode !== undefined && row.mode !== "edit")) throw new Error("Unsupported Studio turn prompt/mode.")
    if (audio) {
      audioSettings(row.settings)
      for (const key of ["effectivePrompt", "lyricsPrompt"]) if (row[key] !== undefined && typeof row[key] !== "string") throw new Error("Invalid Studio audio prompt.")
    }
    return row
  })
  const media = value.media.map((entry: unknown) => {
    const row = record(entry, ["id", "turnId", "sessionId", "createdAtUnixTimestamp", "mimeType", "fileName", "modelId", "modelName", "prompt",
      ...(audio ? ["effectivePrompt", "lyricsPrompt", "coverAssetPath", "audioSettings", "subtitle", "durationSeconds"] :
        ["imageSettings", "mediaRole", "source", "inputIndex", "enhancedPrompt", "isPromptEnhanced"])])
    mediaIds.add(unique(row))
    if (!turnIds.has(String(row.turnId)) || (!audio && !["input", "output"].includes(String(row.mediaRole))) ||
        typeof row.mimeType !== "string" || libraryKind(row.mimeType) !== kind) throw new Error("Foreign or unsupported Studio media.")
    studioFilePath(sessionId, studioId(row.id), row.mimeType, row.fileName)
    for (const key of ["modelId", "modelName", "prompt", "enhancedPrompt", "effectivePrompt", "lyricsPrompt"]) {
      if (row[key] !== undefined && typeof row[key] !== "string") throw new Error(`Invalid Studio ${key}.`)
    }
    if (row.imageSettings !== undefined && (!isRecord(row.imageSettings) ||
        Object.entries(row.imageSettings).some(([key, item]) => ![
          "aspectRatio", "batchCount", "cfgScale", "height", "isCustomSeed", "negativePrompt", "seed", "steps", "stylePreset", "width", "format",
          "isAdultContent", "isAdultModelContentViolation", "isBlurred", "isContentViolation",
        ].includes(key) || (item !== null && !["string", "number", "boolean"].includes(typeof item))))) throw new Error("Unsupported Studio image settings.")
    if (row.source !== undefined && !["image", "edit", "remove-bg"].includes(String(row.source))) throw new Error("Unsupported Studio media source.")
    if (row.inputIndex !== undefined && (typeof row.inputIndex !== "number" || !Number.isSafeInteger(row.inputIndex) || row.inputIndex < 0)) throw new Error("Invalid Studio input index.")
    if (row.isPromptEnhanced !== undefined && typeof row.isPromptEnhanced !== "boolean") throw new Error("Invalid Studio prompt flag.")
    if (audio) {
      audioSettings(row.audioSettings); subtitles(row.subtitle)
      if (row.coverAssetPath != null && row.coverAssetPath !== "" && row.coverAssetPath !== "/images/VeniceKeys_circle_blue.svg") {
        throw new Error("Custom or remote Studio audio covers are not portable yet. No incomplete export was created.")
      }
      if (row.durationSeconds !== undefined && (typeof row.durationSeconds !== "number" || row.durationSeconds <= 0)) throw new Error("Invalid Studio audio duration.")
    }
    return row
  })
  for (const turn of turns) {
    if (!media.some((row) => row.turnId === turn.id && (audio || row.mediaRole === "output"))) throw new Error("Studio turn has no completed output. Finish generation before exporting.")
    if (turn.input !== undefined) {
      const input = turn.input
      if (!isRecord(input) || Object.keys(input).some((key) => !["id", "fileName", "mimeType"].includes(key))) throw new Error("Unsupported Studio input reference.")
      const target = media.find((row) => row.id === input.id)
      if (!target || target.fileName !== input.fileName || target.mimeType !== input.mimeType) throw new Error("Missing or foreign Studio input media.")
    }
  }
  const selection = session[audio ? "selectedAudioId" : "selectedImageId"]
  if (selection !== undefined && selection !== null && !mediaIds.has(String(selection))) throw new Error("Missing selected Studio media.")
  const fileIds = new Set<string>()
  let total = 0
  const files = value.files.map((entry: unknown): StudioFile => {
    if (!isRecord(entry)) throw new Error("Invalid Studio file manifest.")
    const id = studioId(entry.id), target = media.find((row) => row.id === id)
    if (!target || fileIds.has(id) || entry.path !== target.fileName || entry.mimeType !== target.mimeType ||
        typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > MAX_LIBRARY_FILE ||
        typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid Studio file relationship, size or checksum.")
    fileIds.add(id); total += entry.size
    return { id, path: String(entry.path), mimeType: String(entry.mimeType), size: entry.size, sha256: entry.sha256 }
  })
  if (fileIds.size !== mediaIds.size || total > MAX_STUDIO_ZIP) throw new Error("Missing Studio originals or archive exceeds 128 MiB.")
  const manifest: StudioManifest = { format: "venice-sync-studio-session", version: 1, exportedAt: text(value.exportedAt, "exportedAt"), kind, session, turns, media, files }
  if (strToU8(JSON.stringify(manifest)).length > MAX_METADATA) throw new Error("Studio metadata exceeds 8 MiB.")
  return manifest
}
export async function validateStudioPackage(input: StudioPackage): Promise<StudioPackage> {
  const manifest = validateStudioManifest(input.manifest), expected = new Set(manifest.files.map((file) => file.path))
  if (Object.keys(input.files).length !== expected.size || Object.keys(input.files).some((key) => !expected.has(key))) throw new Error("Unexpected or missing Studio files.")
  for (const file of manifest.files) {
    const bytes = input.files[file.path]
    if (!(bytes instanceof Uint8Array) || bytes.length !== file.size || await sha256(bytes) !== file.sha256) throw new Error("Studio original size/checksum mismatch.")
  }
  return { manifest, files: input.files }
}
export async function encodeStudioPackage(input: StudioPackage): Promise<Uint8Array> {
  const pkg = await validateStudioPackage(input)
  const archive = zipSync({ "manifest.json": strToU8(JSON.stringify(pkg.manifest)), ...pkg.files }, { level: 0 })
  if (archive.length > MAX_STUDIO_ZIP) throw new Error("Studio ZIP exceeds 128 MiB.")
  return archive
}
export async function decodeStudioPackage(bytes: Uint8Array): Promise<StudioPackage> {
  if (bytes.length > MAX_STUDIO_ZIP) throw new Error("Studio ZIP exceeds 128 MiB.")
  const seen = new Set<string>()
  let total = 0
  const entries = unzipSync(bytes, { filter(entry) {
    if (seen.has(entry.name) || seen.size >= 2049 || entry.originalSize < 0 ||
        entry.originalSize > (entry.name === "manifest.json" ? MAX_METADATA : MAX_LIBRARY_FILE) ||
        (entry.name !== "manifest.json" && !/^media\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.[a-z0-9]+$/i.test(entry.name))) throw new Error("Unsafe or excessive Studio ZIP entry.")
    seen.add(entry.name); total += entry.originalSize
    if (total > MAX_STUDIO_ZIP) throw new Error("Studio ZIP exceeds extraction limits.")
    return true
  } })
  if (!entries["manifest.json"]) throw new Error("Missing Studio manifest.")
  const manifest = validateStudioManifest(JSON.parse(strFromU8(entries["manifest.json"])))
  delete entries["manifest.json"]
  return validateStudioPackage({ manifest, files: entries })
}
