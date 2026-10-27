import Ajv from "ajv"
import { isRecord } from "./conversation-format"
import { currentMindOwner, documentData, getNativeCollections, type NativeCollection } from "./native-rxdb"
import {
  mindFileKey, portableMindRecord, sha256, validateMindPackage,
  type MindEditorHistory, type MindFileScope, type MindPackage, type MindPackageManifest,
} from "./mind-package-format"
import { browserMindFiles, type MindFiles } from "./mind-package-storage"
import { mindAvatarReference } from "./mind-avatars"

export const PACKAGE_SCHEMAS = { minds: 25, mindConversations: [4, 5], mindMessages: 25, mindAttachments: 0, mindMedia: 6 }
type Collections = Record<string, NativeCollection>
export interface MindPackageOptions { assistant: boolean; preview: boolean }

function stripRemote(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRemote)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "remoteMediaId").map(([key, entry]) => [key, stripRemote(entry)]))
}

function definitionData(value: Record<string, unknown>): Record<string, unknown> {
  const result = portableMindRecord(value)
  for (const key of ["remoteId", "remoteDraftDirty", "privacyLevel", "usesCredits"]) delete result[key]
  const clean = stripRemote(result)
  if (!isRecord(clean)) throw new Error("Invalid Mind definition.")
  return clean
}

export async function listMindDefinitions() {
  const owner = await currentMindOwner(), collections = await getNativeCollections(PACKAGE_SCHEMAS)
  const docs = await collections.minds.find({ selector: { ownerId: owner } }).exec()
  return docs.map(documentData).map((definition) => {
    if (typeof definition.id !== "string" || typeof definition.name !== "string" || !isRecord(definition.assets)) throw new Error("Invalid Mind metadata.")
    const avatar = mindAvatarReference(definition.avatarImage)
    return { id: definition.id, name: definition.name || "Untitled Mind", assets: Object.keys(definition.assets).length, published: typeof definition.remoteId === "string", ...(avatar ? { avatar } : {}) }
  })
}

export async function loadMindAvatar(mindId: string, avatar: { id: string; mimeType: string }): Promise<string> {
  if (!/^[\w-]{1,100}$/.test(mindId) || !/^[\w-]{1,100}$/.test(avatar.id) || !avatar.mimeType.startsWith("image/")) {
    throw new Error("Unsupported local Mind avatar reference.")
  }
  const tree = await browserMindFiles().readTree(`minds/${mindId}/avatar_images`)
  const original = Object.entries(tree).find(([name]) => name === avatar.id || name.startsWith(`${avatar.id}.`))
  if (!original) throw new Error("The referenced avatar file is missing.")
  return URL.createObjectURL(new Blob([Uint8Array.from(original[1]).buffer], { type: avatar.mimeType }))
}

async function loadHistory(collections: Collections, owner: string, mindId: string, kind: "assistant" | "preview"): Promise<MindEditorHistory | undefined> {
  const id = `mind-${kind === "assistant" ? "maker" : "preview"}-conv:${mindId}`
  const record = await collections.mindConversations.findOne(id).exec()
  const messages = await collections.mindMessages.find({ selector: { mind_conversation_id: id } }).exec()
  const attachments = await collections.mindAttachments.find({ selector: { mindConversationId: id } }).exec()
  const media = await collections.mindMedia.find({ selector: { mindConversationId: id } }).exec()
  if (!record) {
    if (messages.length || attachments.length || media.length) throw new Error("Editor history has orphaned records; repair it before exporting.")
    return undefined
  }
  const conversation = documentData(record)
  if (conversation.ownerId !== owner) throw new Error("Editor history belongs to another account.")
  const values = (docs: typeof messages, field: string) => docs.map(documentData).map((row) => {
    if (row[field] !== owner) throw new Error("Editor history contains foreign account data.")
    return portableMindRecord(row)
  })
  return { conversation: portableMindRecord(conversation), messages: values(messages, "owner_id"), attachments: values(attachments, "ownerId"), media: values(media, "ownerId") }
}

function ensureResources(pkg: MindPackage): void {
  const def = pkg.manifest.definition
  const has = (scope: MindFileScope, directory: string, id: string) => pkg.manifest.files.some((file) =>
    file.scope === scope && file.path.startsWith(directory) &&
    (file.path.slice(directory.length) === id || file.path.slice(directory.length).startsWith(`${id}.`)))
  for (const [field, directory] of [["avatarImage", "avatar_images/"], ["coverImage", "cover_images/"]] as const) {
    const ref = def[field]
    if (isRecord(ref) && ref.id && !has("mind", directory, String(ref.id))) throw new Error(`Missing referenced ${field} file.`)
  }
  if (!isRecord(def.assets)) throw new Error("Invalid assets.")
  for (const id of Object.keys(def.assets)) if (!has("mind", "assets/", id)) throw new Error("Missing a Mind reference asset file.")
  for (const scope of ["assistant", "preview"] as const) {
    const history = pkg.manifest[scope]
    if (!history) continue
    const available = new Set([...Object.keys(def.assets), ...history.attachments.map((entry) => String(entry.id)), ...history.media.map((entry) => String(entry.id)),
      ...[def.avatarImage, def.coverImage].filter(isRecord).map((entry) => String(entry.id))])
    for (const row of history.attachments) {
      if (!has(scope, "attachments/", String(row.id))) throw new Error("Missing an editor attachment file.")
    }
    for (const row of history.media) {
      if (!isRecord(row.data)) throw new Error("Invalid editor media.")
      if (row.data.mediaType === "url" && !row.data.materialized) {
        throw new Error("External-only editor media cannot be backed up completely. Materialize or remove it first.")
      }
      if (!has(scope, "", String(row.id))) throw new Error("Missing an editor media file.")
    }
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return
      if (isRecord(value)) {
        for (const [field, entry] of Object.entries(value)) {
          const ids = field.endsWith("media_id") && typeof entry === "string" ? [entry] :
            field.endsWith("media_ids") && Array.isArray(entry) ? entry : []
          if (ids.some((id) => typeof id !== "string" || !available.has(id))) {
            throw new Error("Editor output references an unavailable media resource.")
          }
        }
      }
      for (const entry of Object.values(value)) visit(entry)
    }
    visit(history.messages)
  }
}

export async function exportMindPackage(id: string, options: MindPackageOptions, files: MindFiles = browserMindFiles()): Promise<MindPackage> {
  const owner = await currentMindOwner(), collections = await getNativeCollections(PACKAGE_SCHEMAS)
  const document = await collections.minds.findOne(id).exec()
  if (!document) throw new Error("Mind definition is missing.")
  const source = documentData(document)
  if (source.ownerId !== owner) throw new Error("This Mind belongs to another account.")
  const assistant = options.assistant ? await loadHistory(collections, owner, id, "assistant") : undefined
  const preview = options.preview ? await loadHistory(collections, owner, id, "preview") : undefined
  const manifest: MindPackageManifest = {
    format: "venice-sync-mind", version: 1, exportedAt: new Date().toISOString(),
    definition: definitionData(source), ...(assistant ? { assistant } : {}), ...(preview ? { preview } : {}), files: [],
  }
  const data: Record<string, Uint8Array> = {}
  const scopes: [MindFileScope, string][] = [["mind", `minds/${id}`]]
  if (assistant) scopes.push(["assistant", `media/${String(assistant.conversation.id)}`])
  if (preview) scopes.push(["preview", `media/${String(preview.conversation.id)}`])
  for (const [scope, path] of scopes) {
    const references: string[] = []
    if (scope === "mind") {
      for (const [field, directory] of [["avatarImage", "avatar_images"], ["coverImage", "cover_images"]] as const) {
        const image = manifest.definition[field]
        if (isRecord(image) && typeof image.id === "string" && image.id) references.push(`${directory}/${image.id}`)
      }
      if (isRecord(manifest.definition.assets)) references.push(...Object.keys(manifest.definition.assets).map((id) => `assets/${id}`))
    } else {
      const history = manifest[scope]
      if (!history) throw new Error("Missing editor history.")
      references.push(...history.attachments.map((entry) => `attachments/${String(entry.id)}`), ...history.media.map((entry) => String(entry.id)))
    }
    for (const [relative, bytes] of Object.entries(await files.readTree(path))) {
      // Venice generates thumbnail caches beside originals; only archive referenced resources.
      if (!references.some((reference) => relative === reference || relative.startsWith(`${reference}.`))) continue
      manifest.files.push({ scope, path: relative, size: bytes.length, sha256: await sha256(bytes) })
      data[mindFileKey(scope, relative)] = bytes
    }
  }
  // Detect changes while collecting files, rather than producing a misleading snapshot.
  const current = await collections.minds.findOne(id).exec()
  if (!current || JSON.stringify(documentData(current)) !== JSON.stringify(source)) throw new Error("Mind changed during export. Retry after editing finishes.")
  for (const [kind, original] of [["assistant", assistant], ["preview", preview]] as const) {
    if (original && JSON.stringify(await loadHistory(collections, owner, id, kind)) !== JSON.stringify(original)) {
      throw new Error("Editor history changed during export. Stop generation and retry.")
    }
  }
  const pkg = await validateMindPackage({ manifest, files: data })
  ensureResources(pkg)
  return pkg
}

function validateNative(collection: NativeCollection, rows: Record<string, unknown>[]): void {
  const original = collection.schema.jsonSchema
  if (!original) throw new Error("Venice's native validation schema is unavailable.")
  const schema = JSON.parse(JSON.stringify(original)) as Record<string, unknown>
  if (isRecord(schema.properties)) {
    for (const key of ["_rev", "_meta", "_deleted", "_attachments"]) delete schema.properties[key]
  }
  if (Array.isArray(schema.required)) schema.required = schema.required.filter((key) => !String(key).startsWith("_"))
  delete schema.$id
  const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: false })
  const validate = ajv.compile(schema)
  for (const row of rows) if (!validate(row)) throw new Error(`Mind package does not match Venice's ${collection.name} schema (${validate.errors?.[0]?.instancePath || "record"}).`)
}

export function prepareMindPackage(pkg: MindPackage, owner: string, options: MindPackageOptions, createId: () => string = () => crypto.randomUUID()) {
  const id = createId()
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Could not generate a safe import ID.")
  const map = new Map<string, string>([[String(pkg.manifest.definition.id), id]])
  const generated = new Set([id])
  const allocate = (old: string) => {
    if (map.has(old)) return
    const next = createId()
    if (!/^[a-f0-9-]{36}$/.test(next) || generated.has(next)) throw new Error("Generated import IDs are not unique.")
    generated.add(next); map.set(old, next)
  }
  const histories = (["assistant", "preview"] as const).filter((kind) => options[kind] && pkg.manifest[kind])
  for (const kind of histories) {
    const history = pkg.manifest[kind]
    if (!history) throw new Error("Missing selected history.")
    map.set(String(history.conversation.id), `mind-${kind === "assistant" ? "maker" : "preview"}-conv:${id}`)
    const collect = (value: unknown) => {
      if (!value || typeof value !== "object") return
      if (isRecord(value)) {
        for (const key of ["id", "turn_id", "call_id", "server_function_call_id"]) if (typeof value[key] === "string") allocate(value[key])
      }
      for (const entry of Object.values(value)) collect(entry)
    }
    collect([history.messages, history.media, history.attachments])
  }
  const remap = (value: unknown): unknown => {
    if (typeof value === "string") return map.get(value) ?? value
    if (Array.isArray(value)) return value.map(remap)
    if (!isRecord(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, remap(entry)]))
  }
  const record = (value: Record<string, unknown>, ownerField: string) => {
    const result = remap(value)
    if (!isRecord(result)) throw new Error("Invalid remapped record.")
    return { ...result, [ownerField]: owner }
  }
  const definition = record(definitionData(pkg.manifest.definition), "ownerId")
  definition.createdAtUnixTimestamp = Date.now()
  definition.updatedAtUnixTimestamp = Date.now()
  const rows: Record<string, Record<string, unknown>[]> = {
    minds: [definition], mindConversations: [], mindMessages: [], mindAttachments: [], mindMedia: [],
  }
  const trees: { path: string; files: Record<string, Uint8Array> }[] = []
  for (const scope of ["mind", ...histories] as MindFileScope[]) {
    const destination = scope === "mind" ? `minds/${id}` : `media/mind-${scope === "assistant" ? "maker" : "preview"}-conv:${id}`
    const data: Record<string, Uint8Array> = {}
    for (const file of pkg.manifest.files.filter((entry) => entry.scope === scope)) {
      const parts = file.path.split("/")
      const filename = parts.pop()
      if (!filename) throw new Error("Invalid resource name.")
      const old = [...map.keys()].sort((a, b) => b.length - a.length).find((key) => filename === key || filename.startsWith(`${key}.`))
      parts.push(old ? `${map.get(old)}${filename.slice(old.length)}` : filename)
      const path = parts.join("/")
      if (data[path]) throw new Error("Resource names collide after remapping.")
      data[path] = pkg.files[mindFileKey(scope, file.path)]
    }
    if (Object.keys(data).length) trees.push({ path: destination, files: data })
  }
  for (const kind of histories) {
    const history = pkg.manifest[kind]
    if (!history) throw new Error("Missing history.")
    rows.mindConversations.push(record(history.conversation, "ownerId"))
    rows.mindMessages.push(...history.messages.map((entry) => record(entry, "owner_id")))
    rows.mindAttachments.push(...history.attachments.map((entry) => record(entry, "ownerId")))
    rows.mindMedia.push(...history.media.map((entry) => record(entry, "ownerId")))
  }
  return { id, rows, trees }
}

export async function importMindPackage(input: MindPackage, options: MindPackageOptions, files: MindFiles = browserMindFiles()): Promise<string> {
  const pkg = await validateMindPackage(input)
  ensureResources(pkg)
  const owner = await currentMindOwner(), collections = await getNativeCollections(PACKAGE_SCHEMAS)
  const prepared = prepareMindPackage(pkg, owner, options)
  for (const [name, rows] of Object.entries(prepared.rows)) {
    const ids = rows.map((row) => String(row.id))
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate remapped native IDs.")
    validateNative(collections[name], rows)
    for (const row of rows) if (await collections[name].findOne(String(row.id)).exec()) throw new Error("Import ID collision; no existing data was overwritten.")
  }
  for (const tree of prepared.trees) if (await files.exists(tree.path)) throw new Error("Import directory already exists. Nothing was changed.")
  const written: string[] = []
  try {
    for (const tree of prepared.trees) { written.push(tree.path); await files.writeTree(tree.path, tree.files) }
    for (const name of ["mindMessages", "mindAttachments", "mindMedia", "mindConversations", "minds"]) {
      const rows = prepared.rows[name]
      if (!rows.length) continue
      const result = await collections[name].bulkInsert(rows)
      if (result.error.length || result.success.length !== rows.length) throw new Error(`Native ${name} import did not complete.`)
    }
  } catch (error) {
    const failures: unknown[] = [error]
    for (const name of ["minds", "mindConversations", "mindMessages", "mindAttachments", "mindMedia"]) {
      try {
        const ids: string[] = []
        for (const row of prepared.rows[name]) {
          const document = await collections[name].findOne(String(row.id)).exec()
          if (document && (documentData(document).ownerId === owner || documentData(document).owner_id === owner)) ids.push(String(row.id))
        }
        if (ids.length && (await collections[name].bulkRemove(ids)).error.length) throw new Error(`Could not clean imported ${name}.`, { cause: error })
      } catch (cleanupError) { failures.push(cleanupError) }
    }
    for (const path of written) try { await files.removeTree(path) } catch (cleanupError) { failures.push(cleanupError) }
    if (failures.length > 1) throw new AggregateError(failures, "Mind import failed; cleanup is incomplete. Do not retry until resolved.", { cause: error })
    throw error
  }
  return prepared.id
}
