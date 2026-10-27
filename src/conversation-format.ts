export const MAX_CONVERSATION_BYTES = 8 * 1024 * 1024

export interface ClassicConversation extends Record<string, unknown> {
  id: string
  name: string
  modelId: string
  createdAtUnixTimestamp: number
  updatedAtUnixTimestamp: number
}

export interface ClassicMessage extends Record<string, unknown> {
  id: string
  conversationId: string
  role: "user" | "assistant" | "system"
  content: string
  modelType: "text"
  createdAtUnixTimestamp: number
  updatedAtUnixTimestamp: number
  parentMessageId: string | null
}

export interface ConversationFile {
  format: "venice-sync-classic"
  version: 1
  exportedAt: string
  conversation: ClassicConversation
  messages: ClassicMessage[]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function assertSafeJson(value: unknown): void {
  if (!value || typeof value !== "object") return
  for (const [key, entry] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor", "$types", "__encryptedData"].includes(key)) {
      throw new Error("Unsupported or unsafe fields in conversation JSON.")
    }
    assertSafeJson(entry)
  }
}

export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string.`)
  return value
}

export function timestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative millisecond timestamp.`)
  }
  return value
}

export function validateConversationFile(value: unknown): ConversationFile {
  if (!isRecord(value)) throw new Error("Expected a conversation JSON object.")
  assertSafeJson(value)
  if (value.format !== undefined && (value.format !== "venice-sync-classic" || value.version !== 1)) {
    throw new Error("Unsupported conversation format or version.")
  }
  const c = value.conversation
  if (!isRecord(c) || !Array.isArray(value.messages)) {
    throw new Error("Expected a native Classic conversation and messages array; Agent/Minds exports are not supported.")
  }
  if (c.characterId || c.publicCharacterId || c.mindId || c.remoteMindId) {
    throw new Error("Character and Agent/Minds conversations are not supported yet.")
  }
  if ((c.type !== undefined && c.type !== "text") ||
      (c.conversationType !== undefined && c.conversationType !== "text")) {
    throw new Error("Only Classic text conversations are supported.")
  }
  const conversation: ClassicConversation = {
    ...c,
    id: text(c.id, "conversation.id"),
    name: text(c.name, "conversation.name"),
    modelId: text(c.modelId, "conversation.modelId"),
    createdAtUnixTimestamp: timestamp(c.createdAtUnixTimestamp, "conversation.createdAtUnixTimestamp"),
    updatedAtUnixTimestamp: timestamp(c.updatedAtUnixTimestamp, "conversation.updatedAtUnixTimestamp"),
  }
  const ids = new Set<string>()
  const messages = value.messages.map((entry: unknown, index): ClassicMessage => {
    if (!isRecord(entry)) throw new Error(`Message ${index + 1} must be an object.`)
    const id = text(entry.id, "message.id")
    if (ids.has(id)) throw new Error("Duplicate message IDs are not allowed.")
    ids.add(id)
    if (entry.conversationId !== conversation.id) throw new Error("Message belongs to a different conversation.")
    if (!["user", "assistant", "system"].includes(String(entry.role))) throw new Error("Unsupported message role.")
    if (typeof entry.content !== "string") throw new Error("Only string message content is supported.")
    const imageSettings = isRecord(entry.imageSettings) ? entry.imageSettings : undefined
    const hasImageMedia = imageSettings &&
      ["maskMedia", "doodleMedia", "doodleSourceMedia"].some((field) => imageSettings[field])
    if (entry.modelType !== "text" || entry.isFile || entry.fileType || entry.fileName ||
        entry.contentBinary || entry.videoPath || entry.audioPath || hasImageMedia ||
        (entry.attachments !== undefined && (!Array.isArray(entry.attachments) || entry.attachments.length > 0))) {
      throw new Error("Only plain text messages without attachments or media are supported.")
    }
    if (entry.parentMessageId !== undefined && entry.parentMessageId !== null) {
      throw new Error("Edited or branched messages are not supported yet.")
    }
    return {
      ...entry, id, conversationId: conversation.id,
      role: entry.role === "user" ? "user" : entry.role === "assistant" ? "assistant" : "system",
      content: entry.content, modelType: "text",
      createdAtUnixTimestamp: timestamp(entry.createdAtUnixTimestamp, "message.createdAtUnixTimestamp"),
      updatedAtUnixTimestamp: timestamp(entry.updatedAtUnixTimestamp, "message.updatedAtUnixTimestamp"),
      parentMessageId: entry.parentMessageId ?? null,
    }
  })
  return {
    format: "venice-sync-classic", version: 1,
    exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : new Date().toISOString(),
    conversation, messages,
  }
}

export function parseConversationFile(json: string): ConversationFile {
  if (new TextEncoder().encode(json).byteLength > MAX_CONVERSATION_BYTES) throw new Error("Conversation JSON exceeds 8 MiB.")
  let value: unknown
  try { value = JSON.parse(json) }
  catch { throw new Error("Invalid JSON. Select a Venice Sync or native Classic conversation export.") }
  return validateConversationFile(value)
}

export function prepareConversationImport(file: ConversationFile, ownerId: string, createId: () => string = () => crypto.randomUUID()) {
  const validated = validateConversationFile(file)
  const id = createId()
  const ids = new Map(validated.messages.map((entry) => [entry.id, createId()]))
  const conversation = {
    ...validated.conversation, id, ownerId, folderId: null, isTemporary: false, expirationMode: "permanent",
    sessionId: undefined, expirationTimestamp: undefined,
    updatedAtUnixTimestamp: Date.now(),
  }
  const messages = validated.messages.map((entry) => {
    const mapped = ids.get(entry.id)
    const parent = entry.parentMessageId === null ? null : ids.get(entry.parentMessageId)
    if (!mapped || parent === undefined) throw new Error("Could not remap message graph.")
    return { ...entry, id: mapped, ownerId, conversationId: id, parentMessageId: parent }
  })
  return { conversation, messages }
}
