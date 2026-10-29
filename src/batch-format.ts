import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { assertSafeJson, isRecord } from "./conversation-format"
import { safeMindPath, sha256 } from "./mind-package-format"

export const MAX_BATCH_BYTES = 128 * 1024 * 1024
export const MAX_BATCH_ITEMS = 200
const MAX_FILES = 4096
const MAX_MANIFEST = 8 * 1024 * 1024
export const batchKinds = ["classic", "mind-history", "agentic", "mind", "character", "library", "studio-image", "studio-audio"] as const
export type BatchKind = typeof batchKinds[number]
export interface BatchSelection { kind: BatchKind; id: string; title: string }
export interface BatchFile { path: string; object: string; bytes: number }
export interface BatchItem extends BatchSelection { filename: string; packaging: "json" | "zip"; files: BatchFile[] }
export interface BatchManifest { format: "venice-sync-batch"; version: 1; exportedAt: string; items: BatchItem[] }
export interface BatchPackage { manifest: BatchManifest; objects: Record<string, Uint8Array> }
export interface PreparedBatchItem { selection: BatchSelection; filename: string; packaging: "json" | "zip"; files: Record<string, Uint8Array> }
export const batchKey = (item: Pick<BatchSelection, "kind" | "id">) => JSON.stringify([item.kind, item.id])

export function canonicalJson(value: unknown): Uint8Array {
  const normalize = (entry: unknown, depth: number): unknown => {
    if (depth > 80) throw new Error("Export metadata is too deeply nested.")
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry
    if (typeof entry === "number" && Number.isFinite(entry)) return entry
    if (Array.isArray(entry)) return entry.map((item) => normalize(item === undefined ? null : item, depth + 1))
    if (isRecord(entry)) return Object.fromEntries(Object.keys(entry).sort().filter((key) => entry[key] !== undefined).map((key) => [key, normalize(entry[key], depth + 1)]))
    throw new Error("Export metadata is not portable JSON.")
  }
  return strToU8(JSON.stringify(normalize(value, 0)))
}

function portableSelection(value: unknown): BatchSelection {
  if (!isRecord(value) || !isBatchKind(value.kind) || typeof value.id !== "string" || !value.id || value.id.length > 500 ||
      typeof value.title !== "string" || value.title.length > 2000) throw new Error("Invalid batch item identity/title.")
  return { kind: value.kind, id: value.id, title: value.title }
}
function isBatchKind(value: unknown): value is BatchKind { return batchKinds.some(kind => kind === value) }
function filename(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200 || /[/\\]/.test(value) || value === "." || value === ".." ||
      [...value].some(char => char.charCodeAt(0) < 32)) throw new Error("Unsafe batch download filename.")
  return value
}
export function validateBatchManifest(input: unknown): BatchManifest {
  if (!isRecord(input) || input.format !== "venice-sync-batch" || input.version !== 1 || typeof input.exportedAt !== "string" ||
      !Number.isFinite(Date.parse(input.exportedAt)) || !Array.isArray(input.items) || !input.items.length || input.items.length > MAX_BATCH_ITEMS) {
    throw new Error("Select a Venice Sync batch v1 archive (1-200 items).")
  }
  const seen = new Set<string>()
  let count = 0, logicalBytes = 0
  const items = input.items.map((entry: unknown): BatchItem => {
    const selection = portableSelection(entry)
    if (!isRecord(entry) || !["json", "zip"].includes(String(entry.packaging)) || !Array.isArray(entry.files) || !entry.files.length) throw new Error("Invalid batch item files.")
    const key = batchKey(selection)
    if (seen.has(key)) throw new Error("Duplicate batch selection.")
    seen.add(key)
    const paths = new Set<string>()
    const files = entry.files.map((file: unknown): BatchFile => {
      if (!isRecord(file) || typeof file.path !== "string" || typeof file.object !== "string" || !/^[a-f0-9]{64}$/.test(file.object) ||
          typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_BATCH_BYTES) throw new Error("Invalid batch object reference.")
      safeMindPath(file.path)
      if (paths.has(file.path)) throw new Error("Duplicate batch item path.")
      paths.add(file.path); count++; logicalBytes += file.bytes
      return { path: file.path, object: file.object, bytes: file.bytes }
    })
    if (count > MAX_FILES || logicalBytes > MAX_BATCH_BYTES) throw new Error("Batch logical content exceeds 128 MiB or 4096 files. Export in smaller batches.")
    if (entry.packaging === "json" && (files.length !== 1 || files[0].path !== "export.json")) throw new Error("Invalid batch JSON item layout.")
    if (entry.packaging === "zip" && !paths.has("manifest.json")) throw new Error("Batch package is missing its original manifest.")
    const name = filename(entry.filename)
    if (!name.endsWith(`.${entry.packaging}`)) throw new Error("Batch filename and packaging disagree.")
    return { ...selection, filename: name, packaging: entry.packaging === "json" ? "json" : "zip", files }
  })
  return { format: "venice-sync-batch", version: 1, exportedAt: input.exportedAt, items }
}

export async function buildBatch(items: AsyncIterable<PreparedBatchItem>, options: {
  signal?: AbortSignal; onProgress?: (completed: number) => void; exportedAt?: string
} = {}): Promise<BatchPackage> {
  const objects: Record<string, Uint8Array> = {}, records: BatchItem[] = []
  let logicalBytes = 0, fileCount = 0
  for await (const item of items) {
    options.signal?.throwIfAborted()
    if (records.length >= MAX_BATCH_ITEMS) throw new Error("Batch exceeds 200 items.")
    const files: BatchFile[] = []
    for (const [path, bytes] of Object.entries(item.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      options.signal?.throwIfAborted()
      logicalBytes += bytes.length
      if (++fileCount > MAX_FILES || logicalBytes > MAX_BATCH_BYTES) throw new Error("Batch exceeds 128 MiB or 4096 files. Export in smaller batches.")
      safeMindPath(path)
      const object = await sha256(bytes)
      if (!objects[object]) objects[object] = bytes
      files.push({ path, object, bytes: bytes.length })
    }
    records.push({ ...item.selection, filename: item.filename, packaging: item.packaging, files })
    options.onProgress?.(records.length)
  }
  options.signal?.throwIfAborted()
  const manifest = validateBatchManifest({ format: "venice-sync-batch", version: 1, exportedAt: options.exportedAt ?? new Date().toISOString(), items: records })
  if (canonicalJson(manifest).length > MAX_MANIFEST) throw new Error("Batch manifest exceeds 8 MiB.")
  return { manifest, objects }
}

export async function validateBatchPackage(input: BatchPackage, signal?: AbortSignal): Promise<BatchPackage> {
  const manifest = validateBatchManifest(input.manifest), expected = new Map<string, number>()
  if (canonicalJson(manifest).length > MAX_MANIFEST) throw new Error("Batch manifest exceeds 8 MiB.")
  for (const item of manifest.items) for (const file of item.files) {
    if (expected.has(file.object) && expected.get(file.object) !== file.bytes) throw new Error("Conflicting batch object sizes.")
    expected.set(file.object, file.bytes)
  }
  if (!isRecord(input.objects) || Object.keys(input.objects).length !== expected.size || Object.keys(input.objects).some(hash => !expected.has(hash))) throw new Error("Unexpected or missing batch objects.")
  let total = canonicalJson(manifest).length
  for (const [hash, size] of expected) {
    signal?.throwIfAborted()
    const bytes = input.objects[hash]
    if (!(bytes instanceof Uint8Array) || bytes.length !== size || await sha256(bytes) !== hash) throw new Error("Batch object size/checksum mismatch.")
    total += size
    if (total > MAX_BATCH_BYTES) throw new Error("Expanded batch exceeds 128 MiB.")
  }
  return { manifest, objects: input.objects }
}
export async function encodeBatch(input: BatchPackage, signal?: AbortSignal): Promise<Uint8Array> {
  const pkg = await validateBatchPackage(input, signal)
  const entries = Object.fromEntries(Object.entries(pkg.objects).map(([hash, bytes]) => [`objects/${hash}`, bytes]))
  signal?.throwIfAborted()
  const zip = zipSync({ "manifest.json": canonicalJson(pkg.manifest), ...entries }, { level: 0, mtime: new Date(1980, 0, 1) })
  if (zip.length > MAX_BATCH_BYTES) throw new Error("Batch ZIP exceeds 128 MiB. Export in smaller batches.")
  return zip
}
export async function decodeBatch(bytes: Uint8Array): Promise<BatchPackage> {
  if (bytes.length > MAX_BATCH_BYTES) throw new Error("Batch ZIP exceeds 128 MiB.")
  const seen = new Set<string>()
  let total = 0
  const entries = unzipSync(bytes, { filter(entry) {
    if (seen.has(entry.name) || seen.size > MAX_FILES || (entry.name !== "manifest.json" && !/^objects\/[a-f0-9]{64}$/.test(entry.name))) throw new Error("Unsafe, duplicate or excessive batch ZIP entries.")
    seen.add(entry.name); total += entry.originalSize
    if (entry.originalSize < 0 || total > MAX_BATCH_BYTES || (entry.name === "manifest.json" && entry.originalSize > MAX_MANIFEST)) throw new Error("Batch exceeds extraction limits.")
    return true
  } })
  if (!entries["manifest.json"]) throw new Error("Missing batch manifest.")
  const manifest: unknown = JSON.parse(strFromU8(entries["manifest.json"]))
  assertSafeJson(manifest)
  delete entries["manifest.json"]
  const objects = Object.fromEntries(Object.entries(entries).map(([path, bytes]) => [path.slice("objects/".length), bytes]))
  return validateBatchPackage({ manifest: validateBatchManifest(manifest), objects })
}
export function reconstructBatchItem(pkg: BatchPackage, item: BatchItem): Uint8Array {
  const files = Object.fromEntries(item.files.map(file => {
    const bytes = pkg.objects[file.object]
    if (!bytes || bytes.length !== file.bytes) throw new Error("Missing original batch object.")
    return [file.path, bytes]
  }))
  const bytes = item.packaging === "json" ? files["export.json"] : zipSync(files, { level: 0, mtime: new Date(1980, 0, 1) })
  if (bytes.length > MAX_BATCH_BYTES) throw new Error("Reconstructed archive exceeds 128 MiB.")
  return bytes
}
