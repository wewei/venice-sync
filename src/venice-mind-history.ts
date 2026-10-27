import {
  prepareAgenticImport, prepareMindImport, validateAgenticConversation, validateMindConversation,
  type AgenticConversationFile, type MindConversationFile, type MindTarget,
} from "./mind-conversation-format"
import { currentMindOwner, documentData, getMindCollections, type MindCollections } from "./native-rxdb"
import { mindAvatarReference, type MindAvatarReference } from "./mind-avatars"

export interface MindHistorySummary {
  id: string; name: string; messages: number; mind: string; kind: "mind" | "agentic"; updatedAt: number
  mindId?: string; remoteMindId?: string; avatar?: MindAvatarReference
}

async function authenticatedCollections() {
  const owner = await currentMindOwner()
  const collections = await getMindCollections()
  return { collections, owner }
}

function portable(document: Record<string, unknown>, ownerField: string): Record<string, unknown> {
  const result = { ...document }
  for (const key of ["_rev", "_meta", "_deleted", "_attachments", ownerField]) delete result[key]
  return result
}

async function targets(collections: MindCollections, owner: string): Promise<MindTarget[]> {
  const local = await collections.minds.find({ selector: { ownerId: owner } }).exec()
  const histories = await collections.conversations.find({ selector: { ownerId: owner, type: "chat" } }).exec()
  const result: MindTarget[] = local.map((document) => {
    const data = documentData(document)
    if (typeof data.id !== "string" || typeof data.name !== "string") throw new Error("Invalid native Mind definition metadata.")
    const avatar = mindAvatarReference(data.avatarImage)
    return { kind: "local", id: data.id, name: data.name || "Untitled Mind", ...(avatar ? { avatar } : {}) }
  })
  const seen = new Set<string>()
  for (const document of histories) {
    const data = documentData(document)
    if (typeof data.remoteMindId !== "string" || !data.remoteMindId || seen.has(data.remoteMindId)) continue
    seen.add(data.remoteMindId)
    result.push({ kind: "remote", id: data.remoteMindId, name: `Remote Mind ${data.remoteMindId}` })
  }
  return result
}

export async function listMindHistory(): Promise<{ conversations: MindHistorySummary[]; targets: MindTarget[] }> {
  const { collections, owner } = await authenticatedCollections()
  const destinations = await targets(collections, owner)
  const docs = await collections.conversations.find({ selector: { ownerId: owner, type: "chat" } }).exec()
  const conversations: MindHistorySummary[] = []
  for (const document of docs) {
    const data = documentData(document)
    if (typeof data.id !== "string" || typeof data.name !== "string") throw new Error("Invalid Mind conversation metadata.")
    const messages = await collections.messages.find({ selector: { owner_id: owner, mind_conversation_id: data.id } }).exec()
    const destination = destinations.find((entry) => entry.kind === (data.mindId ? "local" : "remote") && entry.id === (data.mindId || data.remoteMindId))
    const kind = data.mindId || data.remoteMindId ? "mind" : "agentic"
    conversations.push({ id: data.id, name: data.name || "Untitled conversation", messages: messages.length,
      mind: kind === "agentic" ? "Agentic" : destination?.name ?? "Mind reference unavailable",
      kind, updatedAt: typeof data.updatedAtUnixTimestamp === "number" ? data.updatedAtUnixTimestamp : 0,
      ...(typeof data.mindId === "string" && data.mindId ? { mindId: data.mindId, ...(destination?.avatar ? { avatar: destination.avatar } : {}) } : {}),
      ...(typeof data.remoteMindId === "string" && data.remoteMindId ? { remoteMindId: data.remoteMindId } : {}),
    })
  }
  return { conversations, targets: destinations }
}

async function exportNativeHistory(id: string) {
  const { collections, owner } = await authenticatedCollections()
  const doc = await collections.conversations.findOne(id).exec()
  if (!doc) throw new Error("Conversation is missing.")
  const conversation = documentData(doc)
  if (conversation.ownerId !== owner) throw new Error("This conversation belongs to another account.")
  const docs = await collections.messages.find({ selector: { mind_conversation_id: id } }).exec()
  const messages = docs.map(documentData)
  if (messages.some((entry) => entry.owner_id !== owner)) throw new Error("Conversation history contains records from another account.")
  messages.sort((a, b) => Number(a.created_at_unix_timestamp) - Number(b.created_at_unix_timestamp))
  return {
    version: 1, exportedAt: new Date().toISOString(),
    conversation: portable(conversation, "ownerId"), messages: messages.map((entry) => portable(entry, "owner_id")),
  }
}

export async function exportMindHistory(id: string): Promise<MindConversationFile> {
  return validateMindConversation({ ...await exportNativeHistory(id), format: "venice-sync-mind-conversation" })
}

export async function exportAgenticHistory(id: string): Promise<AgenticConversationFile> {
  return validateAgenticConversation({ ...await exportNativeHistory(id), format: "venice-sync-agentic-conversation" })
}

export async function importMindHistory(file: MindConversationFile, target: MindTarget): Promise<string> {
  const { collections, owner } = await authenticatedCollections()
  const available = await targets(collections, owner)
  if (!available.some((entry) => entry.kind === target.kind && entry.id === target.id)) {
    throw new Error("The destination Mind is unavailable to this account. Open/create it in Venice and refresh first.")
  }
  const prepared = prepareMindImport(file, owner, target)
  return commitHistory(collections, owner, prepared)
}

export async function importAgenticHistory(file: AgenticConversationFile): Promise<string> {
  const { collections, owner } = await authenticatedCollections()
  return commitHistory(collections, owner, prepareAgenticImport(file, owner))
}

async function commitHistory(collections: MindCollections, owner: string, prepared: ReturnType<typeof prepareMindImport>): Promise<string> {
  const allIds = [prepared.id, ...prepared.messages.map((entry) => entry.id)]
  if (new Set(allIds).size !== allIds.length) throw new Error("Could not generate unique IDs. No data was imported.")
  if (await collections.conversations.findOne(prepared.id).exec() ||
      (await Promise.all(prepared.messages.map((entry) => collections.messages.findOne(entry.id).exec()))).some(Boolean)) {
    throw new Error("Generated IDs conflict with existing data. Nothing was overwritten.")
  }
  try {
    // Publish the conversation only after its messages succeed; RxDB has no cross-collection transaction.
    const result = await collections.messages.bulkInsert(prepared.messages)
    if (result.error.length || result.success.length !== prepared.messages.length) throw new Error("Some conversation messages could not be imported.")
    await collections.conversations.insert(prepared.conversation)
  } catch (error) {
    try {
      const ids = new Set(prepared.messages.map((entry) => entry.id))
      const created = await collections.messages.find({ selector: { owner_id: owner, mind_conversation_id: prepared.id } }).exec()
      const removeIds = created.map(documentData).map((entry) => entry.id).filter((id): id is string => typeof id === "string" && ids.has(id))
      const rollback = await collections.messages.bulkRemove(removeIds)
      if (rollback.error.length) throw new Error("Native message cleanup was incomplete.", { cause: error })
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Conversation import failed and some new message records could not be rolled back. Do not retry until this is resolved.", { cause: rollbackError })
    }
    throw error
  }
  return prepared.id
}
