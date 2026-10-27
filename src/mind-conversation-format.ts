import { assertSafeJson, isRecord, MAX_CONVERSATION_BYTES, text, timestamp } from "./conversation-format"
import type { MindAvatarReference } from "./mind-avatars"

export interface MindConversation extends Record<string, unknown> {
  id: string
  name: string
  type: "chat"
  mindId?: string
  remoteMindId?: string
  createdAtUnixTimestamp: number
  updatedAtUnixTimestamp: number
}

export interface MindMessage extends Record<string, unknown> {
  id: string
  mind_conversation_id: string
  role: "user" | "assistant" | "system" | "developer"
  status: "completed" | "failed" | "cancelled"
  created_at_unix_timestamp: number
  updated_at_unix_timestamp: number
  output_items: Record<string, unknown>[]
}

type StructuredFormat = "venice-sync-mind-conversation" | "venice-sync-agentic-conversation"

export interface StructuredConversationFile<F extends StructuredFormat = StructuredFormat> {
  format: F
  version: 1
  exportedAt: string
  conversation: MindConversation
  messages: MindMessage[]
}

export type MindConversationFile = StructuredConversationFile<"venice-sync-mind-conversation">
export type AgenticConversationFile = StructuredConversationFile<"venice-sync-agentic-conversation">

export interface MindTarget { kind: "local" | "remote"; id: string; name: string; avatar?: MindAvatarReference }

function identifier(value: unknown, field: string): string {
  const id = text(value, field)
  if (id.length > 100) throw new Error(`${field} exceeds Venice's 100-character limit.`)
  return id
}

function terminalStatus(value: unknown): void {
  if (value !== undefined && !["completed", "failed", "cancelled"].includes(String(value))) {
    throw new Error("Active or incomplete messages cannot be transferred. Finish generation first.")
  }
}

function validateStructuredConversation<F extends StructuredFormat>(value: unknown, format: F): StructuredConversationFile<F> {
  const kind = format === "venice-sync-mind-conversation" ? "Mind" : "Agentic"
  assertSafeJson(value)
  if (!isRecord(value) || value.format !== format || value.version !== 1) {
    throw new Error(`Select a Venice Sync ${kind} conversation v1 export, not another archive type.`)
  }
  const source = value.conversation
  if (isRecord(source) && source.studioProjectId) throw new Error("Studio-linked conversations are not supported by this importer.")
  if (!isRecord(source) || source.type !== "chat" || !Array.isArray(value.messages)) {
    throw new Error("Only ordinary chat histories are supported, not builder/preview conversations.")
  }
  const rejectInternalFields = (document: Record<string, unknown>) => {
    if (["_rev", "_meta", "_deleted", "_attachments"].some((key) => key in document)) {
      throw new Error("Import a portable conversation export, not raw RxDB records.")
    }
  }
  rejectInternalFields(source)
  if (typeof source.name !== "string") throw new Error("Conversation name must be a string.")
  for (const field of ["mindId", "remoteMindId"]) {
    if (source[field] !== undefined && typeof source[field] !== "string") throw new Error("Invalid Mind association.")
  }
  const local = typeof source.mindId === "string" && source.mindId.length > 0
  const remote = typeof source.remoteMindId === "string" && source.remoteMindId.length > 0
  if (kind === "Mind" ? local === remote : local || remote) {
    throw new Error(kind === "Mind" ? "A Mind history must reference exactly one local or remote Mind. Agentic chats are separate." :
      "Agentic history must not reference a Mind. Import Mind histories with their own format.")
  }
  const conversation: MindConversation = {
    ...source, id: identifier(source.id, "conversation.id"), name: source.name, type: "chat",
    ...(local ? { mindId: identifier(source.mindId, "conversation.mindId") } : {}),
    ...(remote ? { remoteMindId: identifier(source.remoteMindId, "conversation.remoteMindId") } : {}),
    createdAtUnixTimestamp: timestamp(source.createdAtUnixTimestamp, "conversation.createdAtUnixTimestamp"),
    updatedAtUnixTimestamp: timestamp(source.updatedAtUnixTimestamp, "conversation.updatedAtUnixTimestamp"),
  }
  const identities = new Set<string>()
  const addIdentity = (value: unknown, field: string) => {
    const id = identifier(value, field)
    if (identities.has(id)) throw new Error("Duplicate message/item/content IDs are not allowed.")
    identities.add(id)
    return id
  }
  const messages = value.messages.map((entry: unknown): MindMessage => {
    if (!isRecord(entry) || entry.mind_conversation_id !== conversation.id) throw new Error("Message belongs to another conversation.")
    rejectInternalFields(entry)
    if (!["user", "assistant", "system", "developer"].includes(String(entry.role))) throw new Error("Unsupported message role.")
    if (!["completed", "failed", "cancelled"].includes(String(entry.status))) throw new Error("Finish generation before transferring its history.")
    if (!Array.isArray(entry.output_items)) throw new Error("Messages must preserve their structured output_items.")
    const id = addIdentity(entry.id, "message.id")
    if (entry.turn_id !== undefined) identifier(entry.turn_id, "message.turn_id")
    const output_items = entry.output_items.map((item: unknown) => {
      if (!isRecord(item) || !["message", "reasoning"].includes(String(item.type)) || !Array.isArray(item.content)) {
        throw new Error(`${kind} v1 supports text and reasoning only. Tool execution, attachments and media are not dropped; this history is rejected.`)
      }
      addIdentity(item.id, "item.id")
      terminalStatus(item.status)
      if (item.container_id || (Array.isArray(item.container_path) && item.container_path.length)) {
        throw new Error("Nested sub-agent/tool execution histories are not supported yet.")
      }
      const content = item.content.map((part: unknown) => {
        if (!isRecord(part) || !["output_text", "refusal"].includes(String(part.type))) throw new Error("Conversation attachments and media are not supported yet.")
        addIdentity(part.id, "content.id")
        terminalStatus(part.status)
        if (part.type === "output_text" ? typeof part.text !== "string" : typeof part.refusal !== "string") throw new Error("Missing text/refusal content.")
        return { ...part }
      })
      return { ...item, content }
    })
    return {
      ...entry, id, mind_conversation_id: conversation.id,
      role: entry.role === "user" ? "user" : entry.role === "assistant" ? "assistant" : entry.role === "system" ? "system" : "developer",
      status: entry.status === "completed" ? "completed" : entry.status === "failed" ? "failed" : "cancelled",
      created_at_unix_timestamp: timestamp(entry.created_at_unix_timestamp, "message.created_at_unix_timestamp"),
      updated_at_unix_timestamp: timestamp(entry.updated_at_unix_timestamp, "message.updated_at_unix_timestamp"), output_items,
    }
  })
  for (const entry of messages) {
    for (const item of entry.output_items) {
      const parts: unknown[] = Array.isArray(item.content) ? item.content : []
      for (const node of [item, ...parts]) {
        if (!isRecord(node)) throw new Error("Invalid structured Mind output.")
        for (const field of ["response_id", "item_id"]) {
          if (node[field] !== undefined && (typeof node[field] !== "string" || !identities.has(node[field]))) {
            throw new Error(`Mind ${field} references data missing from the archive.`)
          }
        }
      }
    }
  }
  return { format, version: 1, exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : new Date().toISOString(), conversation, messages }
}

export function validateMindConversation(value: unknown): MindConversationFile {
  return validateStructuredConversation(value, "venice-sync-mind-conversation")
}

export function validateAgenticConversation(value: unknown): AgenticConversationFile {
  return validateStructuredConversation(value, "venice-sync-agentic-conversation")
}

function parseStructuredConversation<F extends StructuredFormat>(json: string, format: F): StructuredConversationFile<F> {
  if (new TextEncoder().encode(json).byteLength > MAX_CONVERSATION_BYTES) throw new Error("Conversation JSON exceeds 8 MiB.")
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error("Invalid structured conversation JSON.") }
  return validateStructuredConversation(value, format)
}

export function parseMindConversation(json: string): MindConversationFile {
  return parseStructuredConversation(json, "venice-sync-mind-conversation")
}

export function parseAgenticConversation(json: string): AgenticConversationFile {
  return parseStructuredConversation(json, "venice-sync-agentic-conversation")
}

function prepareStructuredImport(data: StructuredConversationFile, ownerId: string, target: MindTarget | undefined, createId: () => string) {
  const id = createId()
  const ids = new Map<string, string>()
  const mapped = (source: string) => {
    let result = ids.get(source)
    if (!result) { result = createId(); ids.set(source, result) }
    return result
  }
  const messages = data.messages.map((entry) => {
    const output_items = entry.output_items.map((item) => {
      const content = Array.isArray(item.content) ? item.content.map((part: unknown) => {
        if (!isRecord(part)) throw new Error("Invalid Mind content.")
        return {
          ...part, id: mapped(String(part.id)),
          ...(typeof part.item_id === "string" ? { item_id: mapped(part.item_id) } : {}),
          ...(typeof part.response_id === "string" ? { response_id: mapped(part.response_id) } : {}),
        }
      }) : []
      return { ...item, id: mapped(String(item.id)), ...(typeof item.response_id === "string" ? { response_id: mapped(item.response_id) } : {}), ...(typeof item.item_id === "string" ? { item_id: mapped(item.item_id) } : {}), content }
    })
    return { ...entry, id: mapped(entry.id), mind_conversation_id: id, owner_id: ownerId, ...(typeof entry.turn_id === "string" ? { turn_id: mapped(entry.turn_id) } : {}), output_items }
  })
  const conversation: Record<string, unknown> = {
    ...data.conversation, id, ownerId, type: "chat", updatedAtUnixTimestamp: Date.now(),
    ...(target?.kind === "local" ? { mindId: target.id } : target?.kind === "remote" ? { remoteMindId: target.id } : {}),
  }
  delete conversation.folderId
  if (target?.kind !== "remote") delete conversation.remoteMindId
  if (target?.kind !== "local") delete conversation.mindId
  return { id, conversation, messages }
}

export function prepareMindImport(file: MindConversationFile, ownerId: string, target: MindTarget, createId: () => string = () => crypto.randomUUID()) {
  return prepareStructuredImport(validateMindConversation(file), ownerId, target, createId)
}

export function prepareAgenticImport(file: AgenticConversationFile, ownerId: string, createId: () => string = () => crypto.randomUUID()) {
  return prepareStructuredImport(validateAgenticConversation(file), ownerId, undefined, createId)
}
