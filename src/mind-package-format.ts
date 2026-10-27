import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { assertSafeJson, isRecord, text } from "./conversation-format"

export const MAX_MIND_PACKAGE_BYTES = 128 * 1024 * 1024
export const MAX_MIND_FILE_BYTES = 25 * 1024 * 1024
const MAX_FILES = 2048
export type MindFileScope = "mind" | "assistant" | "preview"
export interface MindPackageFile { scope: MindFileScope; path: string; size: number; sha256: string }
export interface MindEditorHistory {
  conversation: Record<string, unknown>
  messages: Record<string, unknown>[]
  attachments: Record<string, unknown>[]
  media: Record<string, unknown>[]
}
export interface MindPackageManifest {
  format: "venice-sync-mind"
  version: 1
  exportedAt: string
  definition: Record<string, unknown>
  assistant?: MindEditorHistory
  preview?: MindEditorHistory
  files: MindPackageFile[]
}
export interface MindPackage { manifest: MindPackageManifest; files: Record<string, Uint8Array> }

export function safeMindPath(value: string): string {
  if (!value || value.length > 500 || value.split("/").some((part) => !part || part === "." || part === ".." ||
      part.includes("\\") || [...part].some((char) => char.charCodeAt(0) < 32)) || value.startsWith("/") || /^[a-z]:/i.test(value)) throw new Error("Unsafe path in Mind package.")
  return value
}

export function mindFileKey(scope: MindFileScope, path: string): string {
  return safeMindPath(`files/${scope}/${safeMindPath(path)}`)
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function portableMindRecord(value: Record<string, unknown>): Record<string, unknown> {
  const result = { ...value }
  for (const key of ["_rev", "_meta", "_deleted", "_attachments", "ownerId", "owner_id"]) delete result[key]
  return result
}

function document(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid record in Mind package.")
  if (Object.keys(value).some((key) => key.startsWith("_") || key === "ownerId" || key === "owner_id")) {
    throw new Error("Mind package contains account or internal database fields.")
  }
  return value
}

function terminalRecords(messages: Record<string, unknown>[]): void {
  for (const message of messages) {
    if (!["completed", "failed", "cancelled"].includes(String(message.status))) throw new Error("Finish or stop Builder/Preview generation before backing it up.")
    if (!Array.isArray(message.output_items)) throw new Error("Editor history has no structured output_items.")
    for (const item of message.output_items) {
      if (!isRecord(item)) throw new Error("Invalid editor output item.")
      if (item.type === "functionCall" || item.type === "serverFunctionCall") {
        const outputType = item.type === "functionCall" ? "functionCallOutput" : "serverFunctionCallOutput"
        if (!message.output_items.some((output) => isRecord(output) && output.type === outputType && output.call_id === item.call_id)) {
          throw new Error("Unresolved assistant tool calls cannot be restored safely.")
        }
      }
      if (item.client_continuation !== undefined) throw new Error("Resumable assistant continuations cannot be restored. Finish the editor run first.")
    }
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return
      if (isRecord(value)) {
        if (typeof value.status === "string" && /^(?:in_progress|pending|queued|running|streaming|requires_action)$/.test(value.status)) {
          throw new Error("Active tool actions cannot be restored safely. Finish or stop the editor conversation first.")
        }
        if (isRecord(value.user_action) && value.user_action.status === "pending") throw new Error("Resolve pending assistant approvals before exporting.")
      }
      for (const item of Object.values(value)) visit(item)
    }
    visit(message.output_items)
  }
}

export function validateMindManifest(value: unknown): MindPackageManifest {
  assertSafeJson(value)
  if (!isRecord(value) || value.format !== "venice-sync-mind" || value.version !== 1) throw new Error("Unsupported Mind package format/version.")
  const definition = document(value.definition)
  const id = text(definition.id, "Mind id")
  if (!/^[\w-]{1,60}$/.test(id)) throw new Error("Unsupported Mind ID.")
  if (typeof definition.name !== "string" || !isRecord(definition.systemPrompt) ||
      typeof definition.systemPrompt.instructions !== "string" || !isRecord(definition.assets) || !isRecord(definition.tools)) {
    throw new Error("Mind definition is missing its name, instructions, tools or assets.")
  }
  const history = (value: unknown, type: "maker" | "preview"): MindEditorHistory | undefined => {
    if (value === undefined) return undefined
    if (!isRecord(value)) throw new Error("Invalid editor history.")
    const conversation = document(value.conversation)
    const expected = type === "maker" ? `mind-maker-conv:${id}` : `mind-preview-conv:${id}`
    if (conversation.id !== expected || conversation.type !== type || conversation.mindId !== id || conversation.remoteMindId || conversation.studioProjectId) {
      throw new Error("Editor history belongs to a different Mind or conversation type.")
    }
    if (!Array.isArray(value.messages) || !Array.isArray(value.attachments) || !Array.isArray(value.media)) throw new Error("Incomplete editor history collections.")
    const messages = value.messages.map(document), attachments = value.attachments.map(document), media = value.media.map(document)
    const ids = new Set<string>()
    for (const record of messages) {
      const messageId = text(record.id, "message id")
      if (ids.has(messageId) || record.mind_conversation_id !== expected) throw new Error("Duplicate or foreign editor message.")
      ids.add(messageId)
    }
    for (const record of [...attachments, ...media]) {
      if (record.mindConversationId !== expected || (record.mindMessageId !== undefined && !ids.has(String(record.mindMessageId)))) {
        throw new Error("Editor media references foreign or missing history.")
      }
    }
    terminalRecords(messages)
    return { conversation, messages, attachments, media }
  }
  const assistant = history(value.assistant, "maker"), preview = history(value.preview, "preview")
  if (!Array.isArray(value.files) || value.files.length > MAX_FILES) throw new Error("Mind package has too many files.")
  const keys = new Set<string>()
  let total = 0
  const files = value.files.map((entry: unknown): MindPackageFile => {
    if (!isRecord(entry) || !["mind", "assistant", "preview"].includes(String(entry.scope)) ||
        typeof entry.path !== "string" || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) ||
        entry.size < 0 || entry.size > MAX_MIND_FILE_BYTES || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error("Invalid Mind package file manifest.")
    }
    const scope = entry.scope === "mind" ? "mind" : entry.scope === "assistant" ? "assistant" : "preview"
    if ((scope === "assistant" && !assistant) || (scope === "preview" && !preview)) throw new Error("File references excluded editor history.")
    const key = mindFileKey(scope, entry.path)
    if (keys.has(key)) throw new Error("Duplicate package file.")
    keys.add(key); total += entry.size
    return { scope, path: entry.path, size: entry.size, sha256: entry.sha256 }
  })
  if (total > MAX_MIND_PACKAGE_BYTES) throw new Error("Mind package exceeds 128 MiB.")
  return { format: "venice-sync-mind", version: 1, exportedAt: text(value.exportedAt, "exportedAt"), definition, ...(assistant ? { assistant } : {}), ...(preview ? { preview } : {}), files }
}

export async function validateMindPackage(pkg: MindPackage): Promise<MindPackage> {
  const manifest = validateMindManifest(pkg.manifest)
  const expected = new Set(manifest.files.map((file) => mindFileKey(file.scope, file.path)))
  if (Object.keys(pkg.files).length !== expected.size || Object.keys(pkg.files).some((key) => !expected.has(key))) throw new Error("Unexpected or missing package files.")
  for (const entry of manifest.files) {
    const bytes = pkg.files[mindFileKey(entry.scope, entry.path)]
    if (!bytes || bytes.byteLength !== entry.size || await sha256(bytes) !== entry.sha256) throw new Error("Mind package file checksum/size mismatch.")
  }
  return { manifest, files: pkg.files }
}

export async function encodeMindPackage(pkg: MindPackage): Promise<Uint8Array> {
  const data = await validateMindPackage(pkg)
  const manifest = strToU8(JSON.stringify(data.manifest, null, 2))
  if (manifest.length > 8 * 1024 * 1024) throw new Error("Mind package metadata exceeds 8 MiB.")
  const zip = zipSync({ "manifest.json": manifest, ...data.files }, { level: 0 })
  if (zip.length > MAX_MIND_PACKAGE_BYTES) throw new Error("Mind package exceeds 128 MiB.")
  return zip
}

export async function decodeMindPackage(bytes: Uint8Array): Promise<MindPackage> {
  if (bytes.length > MAX_MIND_PACKAGE_BYTES) throw new Error("Mind package exceeds 128 MiB.")
  let total = 0, count = 0
  const names = new Set<string>()
  const entries = unzipSync(bytes, { filter: (entry) => {
    safeMindPath(entry.name)
    if (names.has(entry.name)) throw new Error("Duplicate ZIP entry.")
    names.add(entry.name)
    if (++count > MAX_FILES + 1 || entry.originalSize > (entry.name === "manifest.json" ? 8 * 1024 * 1024 : MAX_MIND_FILE_BYTES) ||
        (total += entry.originalSize) > MAX_MIND_PACKAGE_BYTES) throw new Error("Mind ZIP exceeds extraction limits.")
    return true
  } })
  if (!entries["manifest.json"]) throw new Error("Mind ZIP has no manifest.json.")
  const manifest: unknown = JSON.parse(strFromU8(entries["manifest.json"]))
  delete entries["manifest.json"]
  return validateMindPackage({ manifest: validateMindManifest(manifest), files: entries })
}
