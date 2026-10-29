import { batchKey, validateBatchPackage, type BatchPackage, type BatchItem } from "./batch-format"
import { readBatchItem, validateBatchContents } from "./batch-export"
import { currentVeniceOwner, waitForVeniceOwner, importClassicConversation } from "./venice-classic"
import { importMindPackage } from "./venice-mind-package"
import { importMindHistory, importAgenticHistory, listMindHistory } from "./venice-mind-history"
import { importCharacter } from "./venice-characters"
import { importLibraryAsset } from "./venice-library"
import { importStudioSession } from "./venice-studio"
import { getMindCollections } from "./native-rxdb"
import type { MindTarget } from "./mind-conversation-format"

interface ImportEntry {
  item: BatchItem
  content: Awaited<ReturnType<typeof readBatchItem>>
  newMindKey?: string
}
export interface BatchImportPlan {
  owner: string
  entries: ImportEntry[]
  targets: MindTarget[]
}
export interface BatchImportResult {
  key: string; title: string; kind: BatchItem["kind"]
  status: "success" | "failed"; id?: string; error?: string
}
export interface BatchImportOutcome { results: BatchImportResult[]; stopped: boolean; needsReload: boolean }
export async function planBatchImport(input: BatchPackage, keys: string[]): Promise<BatchImportPlan> {
  const pkg = await validateBatchPackage(input)
  await validateBatchContents(pkg)
  const selected = new Set(keys)
  if (!keys.length || selected.size !== keys.length || keys.some(key => !pkg.manifest.items.some(item => batchKey(item) === key))) throw new Error("Select distinct items from the opened batch.")
  const owner = await waitForVeniceOwner(), entries: ImportEntry[] = []
  for (const item of pkg.manifest.items) if (selected.has(batchKey(item))) entries.push({ item, content: await readBatchItem(pkg, item) })
  const definitions = new Map<string, string>()
  for (const entry of entries) if (entry.content.kind === "mind") {
    const original = String(entry.content.file.manifest.definition.id)
    if (definitions.has(original)) throw new Error("Selected batch has ambiguous duplicate Mind definitions.")
    definitions.set(original, batchKey(entry.item))
  }
  for (const entry of entries) if (entry.content.kind === "mind-history") {
    const id = entry.content.file.conversation.mindId
    if (id) entry.newMindKey = definitions.get(id)
  }
  const needsTargets = entries.some(entry => entry.content.kind === "mind-history" && !entry.newMindKey)
  if (entries.some(entry => ["mind", "mind-history", "agentic"].includes(entry.content.kind))) await getMindCollections()
  const targets = needsTargets ? (await listMindHistory()).targets : []
  if (currentVeniceOwner() !== owner) throw new Error("The account changed during batch import preview.")
  entries.sort((a, b) => Number(b.content.kind === "mind") - Number(a.content.kind === "mind"))
  return { owner, entries, targets }
}
export function unresolvedBatchDestinations(plan: BatchImportPlan, destinations: Record<string, string>): string[] {
  return plan.entries.filter(entry => entry.content.kind === "mind-history" && !entry.newMindKey &&
    !plan.targets.some(target => `${target.kind}:${target.id}` === destinations[batchKey(entry.item)])).map(entry => batchKey(entry.item))
}
export async function importBatch(plan: BatchImportPlan, destinations: Record<string, string>, options: {
  signal?: AbortSignal; onResult?: (result: BatchImportResult) => void
} = {}): Promise<BatchImportOutcome> {
  if (unresolvedBatchDestinations(plan, destinations).length) throw new Error("Select a destination for every unbound Mind history before importing.")
  if (currentVeniceOwner() !== plan.owner) throw new Error("The account changed since preview. No items were imported.")
  const results: BatchImportResult[] = [], minds = new Map<string, string>()
  let needsReload = false, stopped = false
  for (const { item, content, newMindKey } of plan.entries) {
    if (options.signal?.aborted) { stopped = true; break }
    let result: BatchImportResult
    try {
      if (currentVeniceOwner() !== plan.owner) throw new Error("The signed-in account changed. Remaining items were not imported.")
      let id: string
      switch (content.kind) {
        case "classic": id = await importClassicConversation(plan.owner, content.file); needsReload = true; break
        case "character": id = await importCharacter(content.file); needsReload = true; break
        case "library": id = await importLibraryAsset(content.file); needsReload = true; break
        case "studio-image":
        case "studio-audio": id = await importStudioSession(content.file); needsReload = true; break
        case "agentic": id = await importAgenticHistory(content.file); break
        case "mind":
          id = await importMindPackage(content.file, { assistant: true, preview: true })
          minds.set(batchKey(item), id); break
        case "mind-history": {
          let target: MindTarget | undefined
          if (newMindKey) {
            const importedId = minds.get(newMindKey)
            if (!importedId) throw new Error("The required Mind definition was not imported. This history was not written.")
            target = { kind: "local", id: importedId, name: "Imported Mind" }
          } else target = plan.targets.find(target => `${target.kind}:${target.id}` === destinations[batchKey(item)])
          if (!target) throw new Error("Destination Mind is unavailable.")
          id = await importMindHistory(content.file, target); break
        }
      }
      result = { key: batchKey(item), title: item.title, kind: item.kind, status: "success", id }
    } catch (error) {
      result = { key: batchKey(item), title: item.title, kind: item.kind, status: "failed", error: error instanceof Error ? error.message : String(error) }
      stopped = true
    }
    results.push(result)
    options.onResult?.(result)
    if (result.status === "failed") break
  }
  return { results, stopped, needsReload }
}
