export type StorageRead<T> =
  | { status: "success"; data: T }
  | { status: "error"; message: string }

export interface LocalStorageInfo {
  entries: { key: string; bytes: number }[]
  bytes: number
}

export interface DatabaseInfo {
  name: string
  version: number
  stores: StorageRead<{ name: string; records: number }[]>
}

export interface StorageOverview {
  origin: string
  readAt: string
  localStorage: StorageRead<LocalStorageInfo>
  indexedDB: StorageRead<DatabaseInfo[]>
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function readLocalStorage(): StorageRead<LocalStorageInfo> {
  try {
    const storage = window.localStorage
    const entries: LocalStorageInfo["entries"] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key === null) throw new Error("localStorage changed while reading. Refresh to retry.")
      const value = storage.getItem(key)
      if (value === null) throw new Error("localStorage changed while reading. Refresh to retry.")
      entries.push({ key, bytes: 2 * (key.length + value.length) })
    }
    entries.sort((a, b) => a.key.localeCompare(b.key))
    return {
      status: "success",
      data: { entries, bytes: entries.reduce((total, entry) => total + entry.bytes, 0) },
    }
  } catch (error) {
    return { status: "error", message: message(error) }
  }
}

function readDatabase(
  name: string,
  version: number,
): Promise<StorageRead<{ name: string; records: number }[]>> {
  return withExistingDatabase(name, version, async (database) => {
    const names = Array.from(database.objectStoreNames).sort()
    if (names.length === 0) return []
    const transaction = database.transaction(names, "readonly")
    const done = transactionComplete(transaction)
    const counts = names.map(async (storeName) => ({
      name: storeName,
      records: await requestResult(transaction.objectStore(storeName).count()),
    }))
    const [data] = await Promise.all([Promise.all(counts), done])
    return data
  }).then(
    (data) => ({ status: "success", data }),
    (error: unknown) => ({ status: "error", message: message(error) }),
  )
}

async function readIndexedDB(): Promise<StorageRead<DatabaseInfo[]>> {
  try {
    const factory = window.indexedDB
    if (!factory || typeof factory.databases !== "function") {
      throw new Error("IndexedDB database enumeration is unavailable in this browser.")
    }
    const databases = await factory.databases()
    const data = await Promise.all(databases.map(async ({ name, version }) => {
      if (typeof name !== "string" || version === undefined) {
        throw new Error("Database metadata is incomplete. Refresh to retry.")
      }
      return { name, version, stores: await readDatabase(name, version) }
    }))
    data.sort((a, b) => a.name.localeCompare(b.name))
    return { status: "success", data }
  } catch (error) {
    return { status: "error", message: message(error) }
  }
}

export async function readStorageOverview(): Promise<StorageOverview> {
  const localStorage = readLocalStorage()
  const indexedDB = await readIndexedDB()
  return { origin: window.location.origin, readAt: new Date().toISOString(), localStorage, indexedDB }
}
import { requestResult, transactionComplete, withExistingDatabase } from "./indexeddb"
