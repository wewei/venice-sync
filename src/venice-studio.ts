import { isRecord } from "./conversation-format"
import { browserLibraryFiles, type LibraryFiles } from "./library-files"
import { inspectLibraryMedia } from "./library-media"
import { sha256 } from "./mind-package-format"
import { loadNativeModule } from "./native-runtime"
import { currentVeniceOwner, waitForVeniceOwner } from "./venice-classic"
import { studioId, validateStudioManifest, validateStudioPackage, type StudioKind, type StudioManifest, type StudioPackage } from "./studio-session-format"

interface StudioTable {
  name: string
  get(id: string): Promise<unknown>
  add(value: Record<string, unknown>): Promise<unknown>
  where(field: string): { equals(value: string): { toArray(): Promise<unknown[]> } }
}
interface StudioApi {
  sessions: StudioTable; turns: StudioTable; media: StudioTable
  commit(session: Record<string, unknown>, turns: Record<string, unknown>[], media: Record<string, unknown>[]): Promise<void>
}
export interface StudioSession { id: string; kind: StudioKind; name: string; type: string; updatedAt: number }
function isStudioTable(value: unknown, name: string): value is StudioTable {
  return isRecord(value) && value.name === name && typeof value.get === "function" && typeof value.add === "function" && typeof value.where === "function"
}
async function studioApi(kind: StudioKind): Promise<StudioApi> {
  const repository = await loadNativeModule(342219)
  if (!isRecord(repository) || !isRecord(repository.db) || repository.db.name !== "venice-db-encrypted" ||
      repository.db.verno !== 31 || typeof repository.db.transaction !== "function") throw new Error("Unsupported native Studio repository.")
  const transaction = repository.db.transaction.bind(repository.db), db = repository.db
  const table = (name: string): StudioTable => {
    const value = db[name]
    if (!isStudioTable(value, name)) throw new Error(`Native Studio table ${name} is unavailable.`)
    return value
  }
  const prefix = kind === "image" ? "studioImage" : "studioAudio"
  const sessions = table(`${prefix}Sessions`), turns = table(`${prefix}Turns`), media = table(`${prefix}TurnMedia`)
  return { sessions, turns, media, async commit(session, turnRows, mediaRows) {
    await transaction("rw", [sessions, turns, media], async () => {
      for (const row of turnRows) await turns.add(row)
      for (const row of mediaRows) await media.add(row)
      await sessions.add(session)
    })
  } }
}
function rows(values: unknown[], owner: string): Record<string, unknown>[] {
  return values.map((value) => {
    if (!isRecord(value) || value.ownerId !== owner) throw new Error("Studio records have missing or foreign account ownership.")
    return value
  })
}
function portable(value: Record<string, unknown>): Record<string, unknown> {
  const row = { ...value }; delete row.ownerId
  return row
}
async function snapshot(api: StudioApi, owner: string, id: string) {
  const session = await api.sessions.get(studioId(id))
  if (!isRecord(session) || session.ownerId !== owner) throw new Error("Studio session is missing or belongs to another account.")
  const [turns, media] = await Promise.all([
    api.turns.where("sessionId").equals(id).toArray(), api.media.where("sessionId").equals(id).toArray(),
  ])
  return { session: portable(session), turns: rows(turns, owner).map(portable), media: rows(media, owner).map(portable) }
}
export async function listStudioSessions(): Promise<StudioSession[]> {
  const owner = await waitForVeniceOwner()
  const groups = await Promise.all((["image", "audio"] as const).map(async (kind) => {
    const api = await studioApi(kind)
    return rows(await api.sessions.where("ownerId").equals(owner).toArray(), owner).map((row): StudioSession => ({
      id: studioId(row.id), kind, name: typeof row.name === "string" && row.name ? row.name : `Untitled ${kind} session`,
      type: String(row.type), updatedAt: typeof row.updatedAtUnixTimestamp === "number" ? row.updatedAtUnixTimestamp : 0,
    }))
  }))
  if (currentVeniceOwner() !== owner) throw new Error("The account changed while reading Studio sessions.")
  return groups.flat().sort((a, b) => b.updatedAt - a.updatedAt)
}
export async function exportStudioSession(id: string, files: LibraryFiles = browserLibraryFiles(), kind: StudioKind = "image"): Promise<StudioPackage> {
  const owner = await waitForVeniceOwner(), api = await studioApi(kind), source = await snapshot(api, owner, id)
  const descriptors = source.media.map((row) => ({ id: row.id, path: row.fileName, mimeType: row.mimeType, size: 1, sha256: "0".repeat(64) }))
  const manifest = validateStudioManifest({ format: "venice-sync-studio-session", version: 1, exportedAt: new Date().toISOString(), kind, ...source, files: descriptors })
  const content: Record<string, Uint8Array> = {}
  let total = 0
  for (const descriptor of manifest.files) {
    const blob = await files.read(descriptor.path)
    total += blob.size
    if (total > 128 * 1024 * 1024) throw new Error("Studio originals exceed 128 MiB.")
    const bytes = new Uint8Array(await blob.arrayBuffer())
    descriptor.size = bytes.length; descriptor.sha256 = await sha256(bytes); content[descriptor.path] = bytes
  }
  if (currentVeniceOwner() !== owner || JSON.stringify(await snapshot(api, owner, id)) !== JSON.stringify(source)) throw new Error("Studio session/account changed during export. Finish editing or generation and retry.")
  return validateStudioPackage({ manifest, files: content })
}
export function prepareStudioImport(manifest: StudioManifest, owner: string, generate: () => string = () => crypto.randomUUID()) {
  const ids = new Map<string, string>(), paths = new Map<string, string>(), all = [manifest.session, ...manifest.turns, ...manifest.media]
  for (const row of all) ids.set(studioId(row.id), studioId(generate()))
  if (new Set(ids.values()).size !== ids.size || [...ids.values()].some((id) => ids.has(id))) throw new Error("Generated Studio IDs collide.")
  const sessionId = ids.get(String(manifest.session.id))!
  for (const file of manifest.files) paths.set(file.path, `media/${sessionId}/${ids.get(file.id)}.${file.path.split(".").at(-1)}`)
  const own = (row: Record<string, unknown>): Record<string, unknown> => {
    const value = structuredClone(row)
    for (const key of ["id", "sessionId", "turnId", "selectedImageId", "selectedAudioId"]) {
      if (typeof value[key] === "string") value[key] = ids.get(value[key]) ?? value[key]
    }
    if (typeof value.fileName === "string") value.fileName = paths.get(value.fileName)
    if (isRecord(value.input)) value.input = { ...value.input, id: ids.get(String(value.input.id)), fileName: paths.get(String(value.input.fileName)) }
    return { ...value, ownerId: owner }
  }
  const session: Record<string, unknown> = { ...own(manifest.session), updatedAtUnixTimestamp: Date.now() }
  return { sessionId, session,
    turns: manifest.turns.map(own), media: manifest.media.map(own), paths }
}
export async function importStudioSession(input: StudioPackage, files: LibraryFiles = browserLibraryFiles()): Promise<string> {
  const pkg = await validateStudioPackage(input), owner = await waitForVeniceOwner(), api = await studioApi(pkg.manifest.kind)
  const prepared = prepareStudioImport(pkg.manifest, owner)
  for (const row of [prepared.session, ...prepared.turns, ...prepared.media]) {
    for (const table of [api.sessions, api.turns, api.media]) {
      if (await table.get(String(row.id))) throw new Error("Generated Studio ID already exists. Nothing was overwritten.")
    }
  }
  if (await files.containerExists(prepared.sessionId)) throw new Error("Generated Studio file namespace already exists.")
  const originals: { path: string; blob: Blob; thumbnail?: Blob; id: string }[] = []
  for (const descriptor of pkg.manifest.files) {
    const blob = new Blob([Uint8Array.from(pkg.files[descriptor.path]).buffer], { type: descriptor.mimeType })
    const inspected = await inspectLibraryMedia(blob, pkg.manifest.kind), path = prepared.paths.get(descriptor.path)!
    originals.push({ path, blob, thumbnail: inspected.thumbnail, id: path.split("/").at(-1)!.split(".")[0] })
  }
  try {
    for (const file of originals) {
      await files.write(file.path, file.blob)
      if (file.thumbnail) await files.write(`thumbnails/${prepared.sessionId}_${file.id}_thumb.jpg`, file.thumbnail)
    }
    if (currentVeniceOwner() !== owner) throw new Error("The signed-in account changed during Studio import.")
    await api.commit(prepared.session, prepared.turns, prepared.media)
  } catch (error) {
    try { await files.remove(prepared.sessionId) }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Studio import failed and generated-file cleanup is incomplete. Do not retry until resolved.", { cause: cleanupError }) }
    throw error
  }
  return prepared.sessionId
}
