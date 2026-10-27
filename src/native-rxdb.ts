import { isRecord } from "./conversation-format"
import { waitForVeniceOwner } from "./venice-classic"
import { loadNativeModule, nativeVenicePage } from "./native-runtime"

export interface NativeDocument {
  toJSON(): unknown
}

export interface NativeCollection {
  name: string
  closed: boolean
  database: { name: string }
  schema: { version: number; jsonSchema?: Record<string, unknown> }
  find(query: { selector: Record<string, unknown> }): { exec(): Promise<NativeDocument[]> }
  findOne(id: string): { exec(): Promise<NativeDocument | null> }
  insert(value: Record<string, unknown>): Promise<NativeDocument>
  bulkInsert(values: Record<string, unknown>[]): Promise<{ success: NativeDocument[]; error: unknown[] }>
  bulkRemove(ids: string[]): Promise<{ success: NativeDocument[]; error: unknown[] }>
}

export interface MindCollections {
  minds: NativeCollection
  conversations: NativeCollection
  messages: NativeCollection
}

let registryPromise: Promise<unknown[]> | undefined

function isCollection(value: unknown): value is NativeCollection {
  return isRecord(value) && typeof value.name === "string" && value.closed === false &&
    isRecord(value.database) && value.database.name === "venice-rx-db-encrypted" &&
    isRecord(value.schema) && typeof value.schema.version === "number" &&
    ["find", "findOne", "insert", "bulkInsert", "bulkRemove"].every((key) => typeof value[key] === "function")
}

async function readRegistry(): Promise<unknown[]> {
  const core = await loadNativeModule(947217)
  if (!isRecord(core) || !isRecord(core.OPEN_COLLECTIONS) || typeof core.OPEN_COLLECTIONS.values !== "function") {
    throw new Error("Venice's public RxDB registry is unavailable.")
  }
  return [core.OPEN_COLLECTIONS]
}

export async function getNativeCollections(versions: Record<string, number | readonly number[]>): Promise<Record<string, NativeCollection>> {
  registryPromise ??= readRegistry().catch((error: unknown) => {
    registryPromise = undefined
    throw error
  })
  const [registry] = await registryPromise
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!isRecord(registry) || typeof registry.values !== "function") throw new Error("Native RxDB registry changed.")
    const values: unknown = registry.values()
    if (!isRecord(values) || typeof values.next !== "function") throw new Error("Invalid native collection registry.")
    const entries: unknown[] = []
    let next: unknown = values.next()
    while (isRecord(next) && next.done !== true) { entries.push(next.value); next = values.next() }
    const active = entries.filter(isCollection)
    const supported = (name: string, version: number) => typeof versions[name] === "number" ?
      versions[name] === version : versions[name]?.includes(version)
    const selected = Object.keys(versions).map((name) => active.filter((entry) => entry.name === name && supported(name, entry.schema.version)))
    if (selected.every((entries) => entries.length === 1) &&
        selected.every(([entry]) => entry.database === selected[0][0].database)) {
      return Object.fromEntries(selected.map(([entry]) => [entry.name, entry]))
    }
    if (active.some((entry) => entry.name in versions && !supported(entry.name, entry.schema.version)) ||
        selected.some((entries) => entries.length > 1)) {
      throw new Error("Unsupported or ambiguous native Mind schema. Transfer is disabled to protect your data.")
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Venice's Mind database is not ready. Wait for Venice to load and refresh.")
}

export async function getMindCollections(): Promise<MindCollections> {
  const result = await getNativeCollections({ minds: 25, mindConversations: [4, 5], mindMessages: 25 })
  return { minds: result.minds, conversations: result.mindConversations, messages: result.mindMessages }
}
export function documentData(document: NativeDocument): Record<string, unknown> {
  const value = document.toJSON()
  if (!isRecord(value)) throw new Error("Venice returned an invalid Mind record.")
  return value
}

export async function currentMindOwner(): Promise<string> {
  const page = nativeVenicePage()
  const expectedAccount = await waitForVeniceOwner()
  const deadline = Date.now() + 10_000
  let clerk: unknown
  while (Date.now() < deadline) {
    clerk = Reflect.get(page, "Clerk")
    if (isRecord(clerk) && isRecord(clerk.user) && clerk.user.id === expectedAccount &&
        isRecord(clerk.session) && typeof clerk.session.getToken === "function") break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!isRecord(clerk) || !isRecord(clerk.user) || clerk.user.id !== expectedAccount ||
      !isRecord(clerk.session) || typeof clerk.session.getToken !== "function") {
    throw new Error("Sign in to Venice and wait for it to finish loading before using Mind transfer.")
  }
  const account = clerk.user.id
  const token: unknown = await clerk.session.getToken()
  if (typeof token !== "string" || !token) throw new Error("Venice sign-in credentials are unavailable.")
  const response = await page.fetch("https://outerface.venice.ai/api/user/session", {
    credentials: "include",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  })
  if (!response.ok) throw new Error(`Venice account verification failed (HTTP ${response.status}).`)
  const data: unknown = await response.json()
  if (!isRecord(data) || typeof data.token !== "string") throw new Error("Venice returned an invalid account response.")
  const encoded = data.token.split(".")[1]
  if (!encoded) throw new Error("Venice returned an invalid account profile.")
  let profile: unknown
  try { profile = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))) }
  catch { throw new Error("Venice returned an invalid account profile.") }
  if (!isRecord(profile) || typeof profile.userId !== "string" || !profile.userId ||
      profile.userId === "user_anon_1234568910" || clerk.user.id !== account) {
    throw new Error("The current Venice account could not be verified. No data was changed.")
  }
  // Credentials remain in memory and go only to Venice's own account endpoint.
  return profile.userId
}
