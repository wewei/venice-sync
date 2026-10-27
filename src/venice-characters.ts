import { isRecord } from "./conversation-format"
import { parseCharacterFile, portableCharacter, prepareCharacterImport, validateCharacterFile, type CharacterFile } from "./character-format"
import { loadNativeModule } from "./native-runtime"
import { currentVeniceOwner, waitForVeniceOwner } from "./venice-classic"

interface CharacterTable {
  name: string
  where(field: string): { equals(value: string): { toArray(): Promise<unknown[]> } }
  get(id: string): Promise<unknown>
  add(value: Record<string, unknown>): Promise<unknown>
  delete(id: string): Promise<void>
}
interface CharacterApi {
  table: CharacterTable
  hydrate(value: Record<string, unknown>): Promise<unknown>
  storePhoto(value: Record<string, unknown>): Promise<unknown>
  cleanupPhoto(value: Record<string, unknown>): Promise<void>
  parse(json: string): unknown
}
function isTable(value: unknown): value is CharacterTable {
  return isRecord(value) && value.name === "characters" &&
    ["where", "get", "add", "delete"].every((key) => typeof value[key] === "function")
}

async function characterApi(): Promise<CharacterApi> {
  const [repository, media, format] = await Promise.all([loadNativeModule(342219), loadNativeModule(951225), loadNativeModule(488857)])
  if (!isRecord(repository) || !isRecord(repository.db) || repository.db.name !== "venice-db-encrypted" ||
      repository.db.verno !== 31 || !isTable(repository.db.characters) || !isRecord(media) ||
      typeof media.C !== "function" || typeof media.W !== "function" || typeof media.n !== "function" ||
      !isRecord(format) || typeof format.D !== "function") {
    throw new Error("Unsupported native Character repository/photo format. Open Venice Characters and retry.")
  }
  const hydrate = media.C, storePhoto = media.W, cleanupPhoto = media.n, parse = format.D
  return {
    table: repository.db.characters,
    hydrate: async (value) => hydrate(value),
    storePhoto: async (value) => storePhoto(value),
    cleanupPhoto: async (value) => cleanupPhoto(value),
    parse: (json) => parse(json),
  }
}

function nativeValidated(api: CharacterApi, file: CharacterFile): CharacterFile {
  const result = api.parse(JSON.stringify(file))
  if (!isRecord(result) || result.success !== true || !isRecord(result.data)) {
    throw new Error(`Character validation failed: ${isRecord(result) && typeof result.error === "string" ? result.error : "native parser rejected this file"}`)
  }
  return validateCharacterFile(result.data)
}

async function ownedCharacter(api: CharacterApi, owner: string, id: string): Promise<Record<string, unknown>> {
  const record = await api.table.get(id)
  if (!isRecord(record) || record.ownerId !== owner) throw new Error("This Character is missing or belongs to another account.")
  return record
}

async function characterPhotoFiles(owner: string, id: string, remove: boolean): Promise<boolean> {
  if (!/^[\w-]+$/.test(owner) || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Unsafe generated Character photo namespace.")
  let directory: FileSystemDirectoryHandle
  try {
    const root = await navigator.storage.getDirectory()
    const media = await root.getDirectoryHandle("media")
    directory = await media.getDirectoryHandle(`character-photos-${owner}`)
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return false
    throw error
  }
  let found = false
  for await (const [name, entry] of directory.entries()) {
    if (entry.kind === "file" && name.startsWith(`${id}__`)) {
      found = true
      if (remove) await directory.removeEntry(name)
    }
  }
  return found
}

async function portableExport(api: CharacterApi, source: Record<string, unknown>): Promise<CharacterFile> {
  const hydrated = await api.hydrate(source)
  if (!isRecord(hydrated)) throw new Error("Native Character hydration failed.")
  if (source.photoMedia && (typeof hydrated.photo !== "string" || !hydrated.photo)) {
    throw new Error("The referenced Character portrait is missing. No incomplete export was created.")
  }
  const file = validateCharacterFile({ character: portableCharacter(hydrated), exportedAt: new Date().toISOString(), schemaVersion: "1" })
  return nativeValidated(api, file)
}

export async function listCharacters() {
  const owner = await waitForVeniceOwner(), api = await characterApi()
  const rows = await api.table.where("ownerId").equals(owner).toArray()
  return rows.map((row) => {
    if (!isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string") throw new Error("Invalid Character metadata.")
    return { id: row.id, name: row.name, description: typeof row.description === "string" ? row.description : "", hasPhoto: !!row.photoMedia || !!row.photo }
  })
}

export async function loadCharacterPortrait(id: string): Promise<string> {
  const owner = await waitForVeniceOwner(), api = await characterApi()
  const source = await ownedCharacter(api, owner, id)
  const hydrated = await api.hydrate(source)
  if (!isRecord(hydrated) || typeof hydrated.photo !== "string" || !hydrated.photo) throw new Error("Character portrait file is missing.")
  const photo = validateCharacterFile({ character: portableCharacter(hydrated), schemaVersion: "1" }).character.photo
  if (typeof photo !== "string") throw new Error("Invalid Character portrait.")
  return photo
}

export async function exportCharacter(id: string): Promise<CharacterFile> {
  const owner = await waitForVeniceOwner(), api = await characterApi()
  const source = await ownedCharacter(api, owner, id)
  const file = await portableExport(api, source)
  const current = await ownedCharacter(api, owner, id)
  if (JSON.stringify(current) !== JSON.stringify(source)) throw new Error("Character changed while exporting. Finish editing and retry.")
  return parseCharacterFile(JSON.stringify(file))
}

export async function importCharacter(input: CharacterFile): Promise<string> {
  const owner = await waitForVeniceOwner(), api = await characterApi()
  const file = nativeValidated(api, parseCharacterFile(JSON.stringify(input)))
  const prepared = prepareCharacterImport(file, owner)
  if (await api.table.get(prepared.id)) throw new Error("Generated Character ID already exists. Nothing was overwritten.")
  if (file.character.photo && await characterPhotoFiles(owner, prepared.id, false)) throw new Error("Generated Character photo namespace already exists. Nothing was overwritten.")
  let normalized: Record<string, unknown> | undefined
  try {
    if (currentVeniceOwner() !== owner) throw new Error("The signed-in account changed. Refresh and retry.")
    const result = await api.storePhoto(prepared)
    if (!isRecord(result) || !isRecord(result.character) || result.character.id !== prepared.id || result.character.ownerId !== owner) {
      throw new Error("Native Character photo preparation returned an invalid result.")
    }
    normalized = result.character
    if (file.character.photo && (typeof normalized.photoMedia !== "string" ||
        !normalized.photoMedia.startsWith(`opfs-media:character-photos-${owner}|${prepared.id}__`))) {
      throw new Error("Character portrait could not be stored. No incomplete Character was imported.")
    }
    if (currentVeniceOwner() !== owner) throw new Error("The signed-in account changed during import.")
    await api.table.add(normalized)
  } catch (error) {
    const failures: unknown[] = [error]
    if (normalized) try { await api.cleanupPhoto(normalized) } catch (cleanupError) { failures.push(cleanupError) }
    if (file.character.photo) try { await characterPhotoFiles(owner, prepared.id, true) } catch (cleanupError) { failures.push(cleanupError) }
    if (failures.length > 1) throw new AggregateError(failures, "Character import failed and cleanup is incomplete. Do not retry until resolved.", { cause: error })
    throw error
  }
  return prepared.id
}
