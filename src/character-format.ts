import { assertSafeJson, isRecord, MAX_CONVERSATION_BYTES } from "./conversation-format"

export interface CharacterFile {
  character: Record<string, unknown> & { name: string; description: string; instructions: string }
  exportedAt: string
  schemaVersion: "1"
}
export const MAX_CHARACTER_BYTES = MAX_CONVERSATION_BYTES

export function validateCharacterFile(value: unknown): CharacterFile {
  assertSafeJson(value)
  if (!isRecord(value)) throw new Error("Expected a Venice Character JSON export.")
  if (value.schemaVersion !== undefined && value.schemaVersion !== "1") throw new Error("Unsupported Character schema version.")
  const source = "character" in value ? value.character : value
  if (!isRecord(source) || typeof source.name !== "string" || !source.name.trim() ||
      typeof source.description !== "string" || typeof source.instructions !== "string" || !isRecord(source.textSettings)) {
    throw new Error("Expected a Character definition with name, description, instructions and textSettings.")
  }
  if (source.photoMedia !== undefined || Object.keys(source).some((key) => key.startsWith("_"))) throw new Error("Use a portable Character JSON export, not raw database/photo references.")
  if (source.photo !== undefined && (typeof source.photo !== "string" ||
      (source.photo !== "" && !/^data:image\/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/.test(source.photo)))) {
    throw new Error("Character portraits must be embedded PNG/JPEG/WebP/GIF/AVIF data, not external URLs or active image formats.")
  }
  if (source.context !== undefined && !Array.isArray(source.context)) throw new Error("Invalid Character context documents.")
  return {
    character: { ...source, name: source.name, description: source.description, instructions: source.instructions },
    exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : new Date().toISOString(),
    schemaVersion: "1",
  }
}

export function parseCharacterFile(json: string): CharacterFile {
  if (new TextEncoder().encode(json).byteLength > MAX_CHARACTER_BYTES) throw new Error("Character JSON exceeds 8 MiB.")
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error("Invalid Character JSON. Select a native Venice Character export.") }
  return validateCharacterFile(value)
}

export function portableCharacter(source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...source }
  for (const key of ["ownerId", "publicId", "sourceId", "photoMedia", "remoteId", "isPublic", "isApiVisible"]) delete result[key]
  return result
}

export function prepareCharacterImport(file: CharacterFile, ownerId: string, id: string = crypto.randomUUID()): Record<string, unknown> & { id: string; ownerId: string } {
  const source = validateCharacterFile(file)
  return {
    ...portableCharacter(source.character), id, ownerId, isPublic: false, isApiVisible: false, isImported: true,
    createdAtUnixTimestamp: Date.now(), updatedAtUnixTimestamp: Date.now(), lastUsed: Date.now(),
  }
}
