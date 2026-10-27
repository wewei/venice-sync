import { isRecord } from "./conversation-format"
import { currentMindOwner, documentData, getNativeCollections } from "./native-rxdb"
import { loadNativeModule } from "./native-runtime"
import { currentVeniceOwner, waitForVeniceOwner } from "./venice-classic"
import { browserLibraryFiles, type LibraryFiles } from "./library-files"
import { inspectLibraryMedia } from "./library-media"
import {
  libraryKind, MAX_LIBRARY_FILE, validateLibraryManifest, validateLibraryPackage,
  type LibraryKind, type LibraryManifest, type LibraryPackage, type LibrarySource,
} from "./library-format"
import { sha256 } from "./mind-package-format"

interface Query { toArray(): Promise<unknown[]> }
interface NativeTable {
  name: string
  get(id: string): Promise<unknown>
  add(value: Record<string, unknown>): Promise<unknown>
  toArray(): Promise<unknown[]>
  where(field: string): { equals(value: string): Query; anyOf(values: string[]): Query }
}
interface LibraryApi {
  tables: Record<string, NativeTable>
  location(conversationId: string, id: string, mimeType: string): string
  commit(conversation: Record<string, unknown>, message: Record<string, unknown>, projection: Record<string, unknown>): Promise<void>
}
export interface LibraryAsset {
  key: string; id: string; source: Exclude<LibrarySource, "file">; filename: string; title: string
  kind: LibraryKind; mimeType: string; createdAt: number; path: string
  metadata: Record<string, unknown>; originalSource?: LibraryManifest["asset"]["source"]; unavailableReason?: string
}

function isTable(value: unknown): value is NativeTable {
  return isRecord(value) && typeof value.name === "string" && ["get", "add", "where", "toArray"].every((key) => typeof value[key] === "function")
}
async function libraryApi(): Promise<LibraryApi> {
  const [repository, media] = await Promise.all([loadNativeModule(342219), loadNativeModule(516029)])
  if (!isRecord(repository) || !isRecord(repository.db) || repository.db.name !== "venice-db-encrypted" || repository.db.verno !== 31 ||
      typeof repository.db.transaction !== "function" || !isRecord(media) || typeof media.resolveMediaLocationParams !== "function") {
    throw new Error("Unsupported native Library repository/file layout.")
  }
  const transaction = repository.db.transaction.bind(repository.db), db = repository.db, resolve = media.resolveMediaLocationParams
  const tables: Record<string, NativeTable> = {}
  for (const name of ["conversations", "messages", "messageIds", "messageImages", "studioImageTurnMedia", "studioAudioTurnMedia"]) {
    if (!isTable(db[name])) throw new Error(`Native Library table ${name} is unavailable.`)
    tables[name] = db[name]
  }
  return {
    tables,
    location(conversationId, id, mimeType) {
      const location: unknown = resolve({ conversationId, id, mimeType })
      if (!isRecord(location) || typeof location.filePath !== "string" || typeof location.fileName !== "string") throw new Error("Invalid native media location.")
      return `${location.filePath}/${location.fileName}`
    },
    async commit(conversation, message, projection) {
      await transaction("rw", [tables.conversations, tables.messages, tables.messageIds], async () => {
        await tables.conversations.add(conversation)
        await tables.messages.add(message)
        await tables.messageIds.add(projection)
      })
    },
  }
}

function portableMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (key, entry: unknown) =>
    key.startsWith("_") || ["ownerId", "owner_id", "contentBinary", "veniceSyncLibrary"].includes(key) ? undefined : entry))
}

function descriptor(api: LibraryApi, source: LibraryAsset["source"], row: Record<string, unknown>): LibraryAsset {
  if (typeof row.id !== "string") throw new Error("Invalid Library asset identifier.")
  const data = isRecord(row.data) ? row.data : row
  const nativeFallback = source === "studio-audio" || row.modelType === "music" ? "audio/mpeg" :
    row.modelType === "video" || data.mediaType === "generatedVideo" ? "video/mp4" : "image/webp"
  const mimeType = typeof data.mimeType === "string" && data.mimeType ? data.mimeType :
    typeof row.fileType === "string" && row.fileType ? row.fileType : nativeFallback
  let kind: LibraryKind, unavailableReason: string | undefined
  try { kind = libraryKind(mimeType) }
  catch (error) {
    kind = libraryKind(nativeFallback)
    unavailableReason = error instanceof Error ? error.message : String(error)
  }
  const prior = row.veniceSyncLibrary === undefined ? undefined : validateLibraryManifest(row.veniceSyncLibrary)
  const location = unavailableReason ? "" : api.location(String(row.sessionId ?? row.mindConversationId ?? row.conversationId ?? ""), row.id, mimeType)
  const file = prior?.asset.filename ?? (typeof row.fileName === "string" ? row.fileName :
    typeof row.filename === "string" ? row.filename : location.split("/").at(-1) || row.id)
  const filename = file.split(/[\\/]/).at(-1) || row.id
  const prompt = row.enhancedPrompt || row.prompt || row.content || row.title
  return {
    key: `${source}:${row.id}`, source, id: row.id, kind, mimeType, filename,
    title: prior ? prior.asset.filename : typeof prompt === "string" && prompt.trim() ? prompt : filename,
    createdAt: typeof row.createdAtUnixTimestamp === "number" ? row.createdAtUnixTimestamp : 0,
    path: source === "discover" ? `discover/generations/${location.split("/").at(-1)}` : location,
    metadata: portableMetadata(row), ...(prior ? { originalSource: prior.asset.source } : {}), ...(unavailableReason ? { unavailableReason } : {}),
  }
}

function rows(values: unknown[]): Record<string, unknown>[] {
  return values.map((value) => { if (!isRecord(value)) throw new Error("Invalid native Library row."); return value })
}

export async function listLibraryAssets(): Promise<LibraryAsset[]> {
  const owner = await waitForVeniceOwner(), api = await libraryApi()
  const internalOwner = await currentMindOwner()
  const collections = await getNativeCollections({ mindMedia: 6, discoverGenerations: 9 })
  const conversations = rows(await api.tables.conversations.where("ownerId").equals(owner).toArray()).filter((row) => row.isTemporary !== true)
  const ids = conversations.map((row) => String(row.id))
  const chat = ids.length ? rows(await api.tables.messages.where("conversationId").anyOf(ids).toArray())
    .filter((row) => row.role === "assistant" && !row.isPlaceholder && ["image", "enhance-image", "inpaint-image", "video", "music"].includes(String(row.modelType))) : []
  const studioImages = rows(await api.tables.studioImageTurnMedia.where("ownerId").equals(owner).toArray()).filter((row) => row.mediaRole !== "input")
  const studioAudio = rows(await api.tables.studioAudioTurnMedia.where("ownerId").equals(owner).toArray())
  const mind = (await collections.mindMedia.find({ selector: { ownerId: internalOwner } }).exec()).map(documentData)
    .filter((row) => isRecord(row.data) && ["generatedImage", "generatedVideo"].includes(String(row.data.mediaType)))
  const discover = (await collections.discoverGenerations.find({ selector: { ownerId: internalOwner, status: "completed" } }).exec()).map(documentData)
    .filter((row) => isRecord(row.data) && ["generatedImage", "generatedVideo"].includes(String(row.data.mediaType)))
  const groups: [LibraryAsset["source"], Record<string, unknown>[]][] = [
    ["chat", chat], ["studio-image", studioImages], ["studio-audio", studioAudio], ["mind", mind], ["discover", discover],
  ]
  if (currentVeniceOwner() !== owner) throw new Error("The account changed while reading Library assets.")
  return groups.flatMap(([source, records]) => records.map((row) => descriptor(api, source, row))).sort((a, b) => b.createdAt - a.createdAt)
}

export async function readLibraryAsset(asset: LibraryAsset, files: LibraryFiles = browserLibraryFiles()): Promise<Blob> {
  if (asset.unavailableReason) throw new Error(asset.unavailableReason)
  let blob: Blob
  try { blob = await files.read(asset.path) }
  catch (error) {
    if (asset.source !== "chat" || asset.kind !== "image") throw new Error("The referenced Library original is missing or unreadable. No incomplete export was created.", { cause: error })
    const api = await libraryApi(), legacy = await api.tables.messageImages.get(asset.id)
    const binary = isRecord(legacy) ? legacy.contentBinary : undefined
    if (ArrayBuffer.isView(binary)) blob = new Blob([Uint8Array.from(new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength)).buffer])
    else if (isArrayBuffer(binary)) blob = new Blob([binary])
    else throw new Error("Neither the referenced Library original nor its legacy embedded image is available.", { cause: error })
  }
  if (!blob.size || blob.size > MAX_LIBRARY_FILE) throw new Error("Library originals must be nonempty and at most 100 MiB.")
  return new Blob([blob], { type: asset.mimeType })
}
function isArrayBuffer(value: unknown): value is ArrayBuffer { return Object.prototype.toString.call(value) === "[object ArrayBuffer]" }

export async function exportLibraryAsset(key: string, files: LibraryFiles = browserLibraryFiles()): Promise<LibraryPackage> {
  const asset = (await listLibraryAssets()).find((entry) => entry.key === key)
  if (!asset) throw new Error("This Library asset is no longer available to the current account.")
  const blob = await readLibraryAsset(asset, files), bytes = new Uint8Array(await blob.arrayBuffer())
  const current = (await listLibraryAssets()).find((entry) => entry.key === key)
  if (!current || JSON.stringify(current.metadata) !== JSON.stringify(asset.metadata) || current.path !== asset.path) throw new Error("Library metadata changed during export. Retry after editing finishes.")
  return validateLibraryPackage({
    manifest: { format: "venice-sync-library-asset", version: 1, exportedAt: new Date().toISOString(),
      asset: { filename: asset.filename, kind: asset.kind, mimeType: asset.mimeType, bytes: bytes.length, sha256: await sha256(bytes),
        source: asset.originalSource ?? { type: asset.source, id: asset.id, metadata: asset.metadata } } },
    bytes,
  })
}

export async function importLibraryAsset(input: LibraryPackage, files: LibraryFiles = browserLibraryFiles()): Promise<string> {
  const pkg = await validateLibraryPackage(input), owner = await waitForVeniceOwner(), api = await libraryApi()
  const id = crypto.randomUUID(), conversationId = crypto.randomUUID()
  if (id === conversationId || await api.tables.messages.get(id) || await api.tables.messageIds.get(id) ||
      await api.tables.conversations.get(conversationId) || await files.containerExists(conversationId)) throw new Error("Generated Library identifiers/namespace already exist. Nothing was overwritten.")
  const { asset } = pkg.manifest
  const blob = new Blob([Uint8Array.from(pkg.bytes).buffer], { type: asset.mimeType })
  const inspected = await inspectLibraryMedia(blob, asset.kind)
  const path = api.location(conversationId, id, asset.mimeType), now = Date.now()
  const modelType = asset.kind === "image" ? "image" : asset.kind === "video" ? "video" : "music"
  const conversation = { id: conversationId, ownerId: owner, name: `Library import: ${asset.filename}`,
    type: modelType, modelId: "venice-sync-import", createdAtUnixTimestamp: now, updatedAtUnixTimestamp: now, isTemporary: false, expirationMode: "permanent", folderId: null }
  const message = {
    id, conversationId, ownerId: owner, role: "assistant", content: asset.filename, modelType, modelId: "venice-sync-import",
    modelName: "Imported Library asset", createdAtUnixTimestamp: now, updatedAtUnixTimestamp: now, parentMessageId: null,
    fileType: asset.mimeType, fileName: path.replace(/^media\//, ""), isPlaceholder: false, isErrored: false,
    ...(asset.kind === "audio" ? { musicContentType: "audio", musicTitle: asset.filename } : {}),
    veniceSyncLibrary: pkg.manifest,
  }
  try {
    await files.write(path, blob)
    if (inspected.thumbnail) await files.write(`thumbnails/${conversationId}_${id}_thumb500.jpg`, inspected.thumbnail)
    if (currentVeniceOwner() !== owner) throw new Error("The account changed during Library import.")
    await api.commit(conversation, message, {
      id, conversationId, role: "assistant", parentMessageId: null, createdAtUnixTimestamp: now, updatedAtUnixTimestamp: now,
    })
  } catch (error) {
    try { await files.remove(conversationId) }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Library import failed and generated-file cleanup is incomplete. Do not retry until resolved.", { cause: cleanupError }) }
    throw error
  }
  return id
}
