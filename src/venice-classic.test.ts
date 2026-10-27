// @vitest-environment node
import { readFileSync } from "node:fs"
import path from "node:path"
import { IDBFactory } from "fake-indexeddb"
import nacl from "tweetnacl"
import { Typeson } from "typeson"
import { builtin } from "typeson-registry"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseConversationFile, type ConversationFile } from "./conversation-format"
import { requestResult, transactionComplete } from "./indexeddb"
import { CLASSIC_DATABASE, exportClassicConversation, importClassicConversation, listClassicConversations, waitForVeniceOwner } from "./venice-classic"

const key = new Uint8Array(32).fill(7)
const serializer = new Typeson().register(builtin)
let factory: IDBFactory
let database: IDBDatabase
let file: ConversationFile

function seal(value: unknown) {
  const nonce = new Uint8Array(24)
  const cipher = nacl.secretbox(new TextEncoder().encode(serializer.stringifySync(value)), nonce, key)
  const result = new Uint8Array(24 + cipher.length)
  result.set(nonce)
  result.set(cipher, 24)
  return result
}

beforeEach(async () => {
  factory = new IDBFactory()
  vi.stubGlobal("indexedDB", factory)
  for (const name of ["localStorage", "sessionStorage"]) {
    const values = new Map<string, string>()
    vi.stubGlobal(name, {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
  }
  localStorage.setItem("encryptionKey", key.join(","))
  file = parseConversationFile(readFileSync(path.resolve("scripts", "fixtures", "classic-conversation.json"), "utf8"))
  const detection = seal([1, 2, 3, 4, 5])
  database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(CLASSIC_DATABASE, 310)
    request.onupgradeneeded = () => {
      for (const name of ["conversations", "messages", "messageIds"]) {
        const store = request.result.createObjectStore(name, { keyPath: "id" })
        store.createIndex(name === "conversations" ? "ownerId" : "conversationId", name === "conversations" ? "ownerId" : "conversationId")
      }
      request.result.createObjectStore("_encryptionSettings", { keyPath: "id" }).add({
        id: 1, settings: { conversations: "NON_INDEXED_FIELDS", messages: "NON_INDEXED_FIELDS" },
        keyChangeDetection: detection,
      })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
})

afterEach(() => {
  database?.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function counts() {
  const names = ["conversations", "messages", "messageIds"]
  const transaction = database.transaction(names, "readonly")
  const [values] = await Promise.all([
    Promise.all(names.map((name) => requestResult(transaction.objectStore(name).count()))),
    transactionComplete(transaction),
  ])
  return values
}

describe("Venice Classic native storage adapter", () => {
  it("imports encrypted rows plus native message IDs and exports losslessly", async () => {
    const id = await importClassicConversation("owner", file)
    expect(id).not.toBe(file.conversation.id)
    expect(await counts()).toEqual([1, 2, 2])
    const exported = await exportClassicConversation("owner", id)
    expect(exported.messages.map((entry) => ({ content: entry.content, role: entry.role, created: entry.createdAtUnixTimestamp })))
      .toEqual(file.messages.map((entry) => ({ content: entry.content, role: entry.role, created: entry.createdAtUnixTimestamp })))
    expect(exported.conversation.ownerId).toBeUndefined()
    expect(exported.messages.every((entry) => entry.conversationId === id)).toBe(true)
    expect(await listClassicConversations("owner")).toEqual([{
      id, name: file.conversation.name, modelId: file.conversation.modelId, messages: 2,
      updatedAt: exported.conversation.updatedAtUnixTimestamp,
    }])
    const transaction = database.transaction("messages", "readonly")
    const [rows] = await Promise.all([
      requestResult<unknown[]>(transaction.objectStore("messages").getAll()),
      transactionComplete(transaction),
    ])
    expect(JSON.stringify(rows)).not.toContain("Synthetic")
    await importClassicConversation("owner", exported)
    expect(await counts()).toEqual([2, 4, 4])
  })

  it("filters by owner and refuses exporting another account's chat", async () => {
    const id = await importClassicConversation("owner", file)
    expect(await listClassicConversations("other")).toEqual([])
    await expect(exportClassicConversation("other", id)).rejects.toThrow("not owned")
  })

  it("round trips native text messages with default image settings and unset fields", async () => {
    for (const message of file.messages) {
      message.imageSettings = { width: 1024, height: 1024, maskMedia: undefined }
      message.attachments = []
      message.fileName = undefined
      message.videoPath = undefined
      message.audioPath = undefined
    }
    const id = await importClassicConversation("owner", file)
    const exported = parseConversationFile(JSON.stringify(await exportClassicConversation("owner", id)))
    expect(exported.messages.map((message) => message.imageSettings)).toEqual([
      { width: 1024, height: 1024 }, { width: 1024, height: 1024 },
    ])
    const copyId = await importClassicConversation("owner", exported)
    const copy = parseConversationFile(JSON.stringify(await exportClassicConversation("owner", copyId)))
    expect(copy.messages.map((message) => message.imageSettings))
      .toEqual(exported.messages.map((message) => message.imageSettings))
    expect(await counts()).toEqual([2, 4, 4])
  })

  it("rejects missing/wrong keys and unsupported policy without writing", async () => {
    localStorage.removeItem("encryptionKey")
    await expect(importClassicConversation("owner", file)).rejects.toThrow("unavailable")
    localStorage.setItem("encryptionKey", new Uint8Array(32).fill(9).join(","))
    await expect(importClassicConversation("owner", file)).rejects.toThrow("decrypt")
    expect(await counts()).toEqual([0, 0, 0])
    localStorage.setItem("encryptionKey", key.join(","))
    const transaction = database.transaction("_encryptionSettings", "readwrite")
    transaction.objectStore("_encryptionSettings").put({ id: 1, settings: {} })
    await transactionComplete(transaction)
    await expect(importClassicConversation("owner", file)).rejects.toThrow("policy")
    expect(await counts()).toEqual([0, 0, 0])
  })

  it("rolls back every store on a new-ID collision rather than overwriting", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001")
    await expect(importClassicConversation("owner", file)).rejects.toThrow()
    expect(await counts()).toEqual([0, 0, 0])
  })

  it("does not create an absent database or upgrade an unknown version", async () => {
    const empty = new IDBFactory()
    vi.stubGlobal("indexedDB", empty)
    await expect(listClassicConversations("owner")).rejects.toThrow("unavailable")
    expect(await empty.databases()).toEqual([])
    vi.stubGlobal("indexedDB", factory)
    vi.spyOn(factory, "databases").mockResolvedValue([{ name: CLASSIC_DATABASE, version: 320 }])
    await expect(importClassicConversation("owner", file)).rejects.toThrow("schema version")
    expect(await counts()).toEqual([0, 0, 0])
  })

  it("waits for native account startup and reports signed-out state", async () => {
    vi.stubGlobal("window", { location: { origin: "https://venice.ai" } })
    const clerk: { loaded: boolean; user?: { id: string } } = { loaded: true }
    vi.stubGlobal("unsafeWindow", { Clerk: clerk })
    const waiting = waitForVeniceOwner()
    clerk.loaded = true
    clerk.user = { id: "owner" }
    expect(await waiting).toBe("owner")
    clerk.user = undefined
    vi.useFakeTimers()
    const rejection = expect(waitForVeniceOwner()).rejects.toThrow("Sign in")
    await vi.advanceTimersByTimeAsync(10_000)
    await rejection
  })
})
