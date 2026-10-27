import nacl from "tweetnacl"
import { Typeson } from "typeson"
import { builtin } from "typeson-registry"
import {
  isRecord, prepareConversationImport, validateConversationFile,
  type ConversationFile,
} from "./conversation-format"
import { requestResult, transactionComplete, withExistingDatabase } from "./indexeddb"

export const CLASSIC_DATABASE = "venice-db-encrypted"
const stores = ["conversations", "messages", "messageIds", "_encryptionSettings"]
const serializer = new Typeson().register(builtin)

export interface ConversationSummary {
  id: string
  name: string
  modelId: string
  messages: number
  updatedAt: number
}

function veniceClerk(): unknown {
  if (window.location.origin !== "https://venice.ai") {
    throw new Error("Conversation transfer is available only on https://venice.ai, not in the local preview.")
  }
  const page = typeof unsafeWindow === "undefined" ? window : unsafeWindow
  return Reflect.get(page, "Clerk")
}

export function currentVeniceOwner(): string {
  const clerk = veniceClerk()
  if (!isRecord(clerk) || !isRecord(clerk.user) || typeof clerk.user.id !== "string" || !clerk.user.id) {
    throw new Error("Sign in to Venice and wait for the page to finish loading, then refresh conversations.")
  }
  return clerk.user.id
}

export async function waitForVeniceOwner(): Promise<string> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const clerk = veniceClerk()
    if (isRecord(clerk) && isRecord(clerk.user) && typeof clerk.user.id === "string" && clerk.user.id) return currentVeniceOwner()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return currentVeniceOwner()
}

function encryptionKey(): Uint8Array {
  const value = localStorage.getItem("encryptionKey") ?? sessionStorage.getItem("encryptionKey")
  const parts = value?.split(",")
  if (!parts || parts.length !== 32 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
    throw new Error("Venice's existing encryption key is unavailable or invalid. No key was created or changed.")
  }
  return Uint8Array.from(parts.map(Number))
}

function bytes(value: unknown): Uint8Array {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== "[object Uint8Array]") {
    throw new Error("Unsupported Venice encrypted-data encoding.")
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function decrypt(value: unknown, key: Uint8Array): unknown {
  const data = bytes(value)
  const plaintext = nacl.secretbox.open(data.subarray(24), data.subarray(0, 24), key)
  if (!plaintext) throw new Error("Could not decrypt Venice data with its current key. No data was changed.")
  return serializer.parseSync(new TextDecoder("utf-8", { fatal: true }).decode(plaintext))
}

function decodeRow(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Unsupported Venice database row.")
  let result = value
  for (let depth = 0; "__encryptedData" in result; depth += 1) {
    if (depth >= 10) throw new Error("Unsupported nested Venice encryption.")
    const decrypted = decrypt(result.__encryptedData, encryptionKey())
    if (!isRecord(decrypted)) throw new Error("Decrypted Venice row is not an object.")
    const indexed = { ...result }
    delete indexed.__encryptedData
    result = { ...indexed, ...decrypted }
  }
  return result
}

async function withClassic<T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const info = (await indexedDB.databases()).find((entry) => entry.name === CLASSIC_DATABASE)
  if (!info?.version) throw new Error("Venice's Classic database is unavailable. Open Classic chat first.")
  if (info.version !== 310) throw new Error("Unsupported Venice Classic schema version. Import/export is disabled to protect your data.")
  return withExistingDatabase(CLASSIC_DATABASE, info.version, async (database) => {
    if (stores.some((name) => !database.objectStoreNames.contains(name))) {
      throw new Error("Venice's Classic database schema is incomplete.")
    }
    const transaction = database.transaction(stores, "readonly")
    for (const name of stores.slice(0, 3)) {
      if (transaction.objectStore(name).keyPath !== "id") throw new Error("Unsupported Venice primary key.")
    }
    return operation(database)
  })
}

export async function listClassicConversations(ownerId: string): Promise<ConversationSummary[]> {
  return withClassic(async (database) => {
    const transaction = database.transaction(["conversations", "messages"], "readonly")
    const done = transactionComplete(transaction)
    const rows = requestResult<unknown[]>(transaction.objectStore("conversations").index("ownerId").getAll(ownerId))
    const summaries = rows.then((values) => Promise.all(values.map(async (value) => {
      const row = decodeRow(value)
      if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.modelId !== "string" ||
          typeof row.updatedAtUnixTimestamp !== "number") throw new Error("Unsupported Classic conversation metadata.")
      const count = requestResult(transaction.objectStore("messages").index("conversationId").count(row.id))
      return { id: row.id, name: row.name, modelId: row.modelId, updatedAt: row.updatedAtUnixTimestamp, messages: await count }
    })))
    const [result] = await Promise.all([summaries, done])
    return result.sort((a, b) => b.updatedAt - a.updatedAt)
  })
}

export async function exportClassicConversation(ownerId: string, id: string): Promise<ConversationFile> {
  return withClassic(async (database) => {
    const transaction = database.transaction(["conversations", "messages"], "readonly")
    const done = transactionComplete(transaction)
    const [conversation, messages] = await Promise.all([
      requestResult<unknown>(transaction.objectStore("conversations").get(id)),
      requestResult<unknown[]>(transaction.objectStore("messages").index("conversationId").getAll(id)),
      done,
    ])
    const row = decodeRow(conversation)
    if (row.ownerId !== ownerId) throw new Error("This conversation is not owned by the current Venice account.")
    const file = validateConversationFile({ conversation: row, messages: messages.map(decodeRow) })
    delete file.conversation.ownerId
    for (const message of file.messages) delete message.ownerId
    file.messages.sort((a, b) => a.updatedAtUnixTimestamp - b.updatedAtUnixTimestamp)
    return file
  })
}

function encodeRow(store: IDBObjectStore, row: Record<string, unknown>, key: Uint8Array): Record<string, unknown> {
  const nonce = crypto.getRandomValues(new Uint8Array(24))
  const encrypted = nacl.secretbox(new TextEncoder().encode(serializer.stringifySync(row)), nonce, key)
  const payload = new Uint8Array(nonce.length + encrypted.length)
  payload.set(nonce)
  payload.set(encrypted, nonce.length)
  const indexed = new Set(["id", ...Array.from(store.indexNames).flatMap((name) => {
    const path = store.index(name).keyPath
    return typeof path === "string" ? [path] : path
  })])
  return { ...Object.fromEntries(Object.entries(row).filter(([field]) => indexed.has(field))), __encryptedData: payload }
}

export async function importClassicConversation(ownerId: string, file: ConversationFile): Promise<string> {
  const prepared = prepareConversationImport(file, ownerId)
  const key = encryptionKey()
  return withClassic((database) => new Promise<string>((resolve, reject) => {
    const transaction = database.transaction(stores, "readwrite")
    let failure: unknown
    const done = transactionComplete(transaction)
    done.then(() => resolve(prepared.conversation.id), (error: unknown) => reject(failure ?? error))
    const metadata = transaction.objectStore("_encryptionSettings").getAll()
    metadata.onsuccess = () => {
      try {
        if (!nacl.verify(key, encryptionKey())) throw new Error("Venice encryption key changed during import.")
        const values: unknown[] = metadata.result
        const settings = values.at(-1)
        if (!isRecord(settings) || !isRecord(settings.settings) ||
            settings.settings.conversations !== "NON_INDEXED_FIELDS" ||
            settings.settings.messages !== "NON_INDEXED_FIELDS" || settings.settings.messageIds !== undefined) {
          throw new Error("Unsupported Venice encryption policy. No data was imported.")
        }
        const detection = decrypt(settings.keyChangeDetection, key)
        if (JSON.stringify(detection) !== "[1,2,3,4,5]") throw new Error("Venice encryption key verification failed.")
        transaction.objectStore("conversations").add(encodeRow(transaction.objectStore("conversations"), prepared.conversation, key))
        for (const message of prepared.messages) {
          transaction.objectStore("messages").add(encodeRow(transaction.objectStore("messages"), message, key))
          transaction.objectStore("messageIds").add({
            id: message.id, conversationId: message.conversationId, role: message.role,
            parentMessageId: message.parentMessageId,
            createdAtUnixTimestamp: message.createdAtUnixTimestamp,
            updatedAtUnixTimestamp: message.updatedAtUnixTimestamp,
          })
        }
      } catch (error) {
        failure = error
        transaction.abort()
      }
    }
  }))
}
