import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { assertSafeJson, isRecord, text } from "./conversation-format"
import { sha256 } from "./mind-package-format"

export const MAX_LIBRARY_FILE = 100 * 1024 * 1024
export const MAX_LIBRARY_ZIP = 128 * 1024 * 1024
export type LibraryKind = "image" | "video" | "audio"
export type LibrarySource = "chat" | "studio-image" | "studio-audio" | "mind" | "discover" | "file"
export interface LibraryManifest {
  format: "venice-sync-library-asset"
  version: 1
  exportedAt: string
  asset: {
    filename: string; mimeType: string; kind: LibraryKind; bytes: number; sha256: string
    source: { type: LibrarySource; id: string; metadata: Record<string, unknown> }
  }
}
export interface LibraryPackage { manifest: LibraryManifest; bytes: Uint8Array }

export function libraryKind(mimeType: string): LibraryKind {
  if (/^image\/(?:png|jpeg|webp|gif|avif|bmp)$/.test(mimeType)) return "image"
  if (/^video\/(?:mp4|webm|quicktime)$/.test(mimeType)) return "video"
  if (/^audio\/(?:mpeg|wav|x-wav|ogg|mp4|flac|webm|aac)$/.test(mimeType)) return "audio"
  throw new Error("Unsupported Library media format. Use a self-contained image, video or audio file.")
}

export function validateLibraryManifest(value: unknown): LibraryManifest {
  assertSafeJson(value)
  if (!isRecord(value) || value.format !== "venice-sync-library-asset" || value.version !== 1 || !isRecord(value.asset)) {
    throw new Error("Select a Venice Sync Library asset v1 ZIP, not a Mind/project archive.")
  }
  const asset = value.asset, source = asset.source
  if (typeof asset.filename !== "string" || !asset.filename || asset.filename.length > 255 ||
      /[/\\]/.test(asset.filename) || [...asset.filename].some((char) => char.charCodeAt(0) < 32)) throw new Error("Invalid Library filename.")
  if (typeof asset.mimeType !== "string" || libraryKind(asset.mimeType) !== asset.kind) throw new Error("Library media type does not match the manifest.")
  if (typeof asset.bytes !== "number" || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > MAX_LIBRARY_FILE ||
      typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("Invalid Library size/checksum (100 MiB file limit).")
  if (!isRecord(source) || !["chat", "studio-image", "studio-audio", "mind", "discover", "file"].includes(String(source.type)) ||
      typeof source.id !== "string" || !isRecord(source.metadata)) throw new Error("Invalid Library source metadata.")
  const type: LibrarySource = source.type === "chat" ? "chat" : source.type === "studio-image" ? "studio-image" :
    source.type === "studio-audio" ? "studio-audio" : source.type === "mind" ? "mind" : source.type === "discover" ? "discover" : "file"
  return {
    format: "venice-sync-library-asset", version: 1, exportedAt: text(value.exportedAt, "exportedAt"),
    asset: { filename: asset.filename, mimeType: asset.mimeType, kind: libraryKind(asset.mimeType),
      bytes: asset.bytes, sha256: asset.sha256, source: { type, id: source.id, metadata: source.metadata } },
  }
}

export async function validateLibraryPackage(pkg: LibraryPackage): Promise<LibraryPackage> {
  const manifest = validateLibraryManifest(pkg.manifest)
  if (pkg.bytes.length !== manifest.asset.bytes || await sha256(pkg.bytes) !== manifest.asset.sha256) throw new Error("Library file size/checksum mismatch.")
  return { manifest, bytes: pkg.bytes }
}

export async function encodeLibraryPackage(pkg: LibraryPackage): Promise<Uint8Array> {
  const verified = await validateLibraryPackage(pkg), manifest = strToU8(JSON.stringify(verified.manifest, null, 2))
  if (manifest.length > 8 * 1024 * 1024) throw new Error("Library metadata exceeds 8 MiB.")
  const bytes = zipSync({ "manifest.json": manifest, "asset.bin": verified.bytes }, { level: 0 })
  if (bytes.length > MAX_LIBRARY_ZIP) throw new Error("Library ZIP exceeds 128 MiB.")
  return bytes
}

export async function decodeLibraryPackage(bytes: Uint8Array): Promise<LibraryPackage> {
  if (bytes.length > MAX_LIBRARY_ZIP) throw new Error("Library ZIP exceeds 128 MiB.")
  const seen = new Set<string>()
  const entries = unzipSync(bytes, { filter: (entry) => {
    if (!["manifest.json", "asset.bin"].includes(entry.name) || seen.has(entry.name)) throw new Error("Unexpected or duplicate file in Library ZIP.")
    seen.add(entry.name)
    if (entry.originalSize > (entry.name === "manifest.json" ? 8 * 1024 * 1024 : MAX_LIBRARY_FILE)) throw new Error("Library ZIP exceeds extraction limits.")
    return true
  } })
  if (!entries["manifest.json"] || !entries["asset.bin"]) throw new Error("Incomplete Library ZIP.")
  return validateLibraryPackage({ manifest: validateLibraryManifest(JSON.parse(strFromU8(entries["manifest.json"]))), bytes: entries["asset.bin"] })
}

export async function rawLibraryPackage(file: File): Promise<LibraryPackage> {
  if (!file.size || file.size > MAX_LIBRARY_FILE) throw new Error("Library files must be nonempty and at most 100 MiB.")
  const bytes = new Uint8Array(await file.arrayBuffer())
  return validateLibraryPackage({
    manifest: { format: "venice-sync-library-asset", version: 1, exportedAt: new Date().toISOString(),
      asset: { filename: file.name, mimeType: file.type, kind: libraryKind(file.type), bytes: bytes.length, sha256: await sha256(bytes),
        source: { type: "file", id: "", metadata: {} } } },
    bytes,
  })
}
