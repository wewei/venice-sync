import { canonicalJson, buildBatch, MAX_BATCH_ITEMS, batchKey, type BatchSelection, type PreparedBatchItem } from "./batch-format"
import { currentVeniceOwner, waitForVeniceOwner, exportClassicConversation } from "./venice-classic"
import { exportMindHistory, exportAgenticHistory } from "./venice-mind-history"
import { exportMindPackage } from "./venice-mind-package"
import { exportCharacter } from "./venice-characters"
import { exportLibraryAsset } from "./venice-library"
import { exportStudioSession } from "./venice-studio"
import { mindFileKey, validateMindPackage } from "./mind-package-format"
import { validateLibraryPackage } from "./library-format"
import { validateStudioPackage } from "./studio-session-format"
import { parseConversationFile } from "./conversation-format"
import { parseAgenticConversation, parseMindConversation } from "./mind-conversation-format"
import { parseCharacterFile } from "./character-format"
import type { BatchPackage, BatchItem } from "./batch-format"
import { strFromU8 } from "fflate"
import { validateMindManifest } from "./mind-package-format"
import { validateLibraryManifest } from "./library-format"
import { validateStudioManifest } from "./studio-session-format"

export async function prepareBatchItem(selection: BatchSelection, owner: string): Promise<PreparedBatchItem> {
  const id = selection.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)
  const json = (value: unknown): PreparedBatchItem => ({
    selection, filename: `venice-${selection.kind}-${id}.json`, packaging: "json", files: { "export.json": canonicalJson(value) },
  })
  switch (selection.kind) {
    case "classic": return json(await exportClassicConversation(owner, selection.id))
    case "mind-history": return json(await exportMindHistory(selection.id))
    case "agentic": return json(await exportAgenticHistory(selection.id))
    case "character": return json(await exportCharacter(selection.id))
    case "mind": {
      const pkg = await validateMindPackage(await exportMindPackage(selection.id, { assistant: true, preview: true }))
      return { selection, filename: `venice-mind-${id}.zip`, packaging: "zip",
        files: { "manifest.json": canonicalJson(pkg.manifest), ...pkg.files } }
    }
    case "library": {
      const pkg = await validateLibraryPackage(await exportLibraryAsset(selection.id))
      return { selection, filename: `venice-library-${id}.zip`, packaging: "zip",
        files: { "manifest.json": canonicalJson(pkg.manifest), "asset.bin": pkg.bytes } }
    }
    case "studio-image":
    case "studio-audio": {
      const pkg = await validateStudioPackage(await exportStudioSession(selection.id, undefined, selection.kind === "studio-image" ? "image" : "audio"))
      return { selection, filename: `venice-${selection.kind}-${id}.zip`, packaging: "zip",
        files: { "manifest.json": canonicalJson(pkg.manifest), ...pkg.files } }
    }
  }
}

export async function exportBatch(selections: BatchSelection[], options: { signal?: AbortSignal; onProgress?: (completed: number) => void } = {}) {
  if (!selections.length || selections.length > MAX_BATCH_ITEMS || new Set(selections.map(batchKey)).size !== selections.length) throw new Error("Select 1-200 distinct items for batch export.")
  const owner = await waitForVeniceOwner()
  const check = () => {
    options.signal?.throwIfAborted()
    if (currentVeniceOwner() !== owner) throw new Error("The signed-in account changed during batch export. Nothing was downloaded.")
  }
  async function* prepare() {
    for (const selection of selections) {
      check()
      try {
        const prepared = await prepareBatchItem(selection, owner)
        check()
        yield prepared
      } catch (error) {
        options.signal?.throwIfAborted()
        throw new Error(`Could not export ${selection.kind} "${selection.title}": ${error instanceof Error ? error.message : String(error)}. No partial batch was downloaded.`, { cause: error })
      }
    }
  }
  const pkg = await buildBatch(prepare(), options)
  await validateBatchContents(pkg)
  check()
  return pkg
}

export async function validateBatchContents(pkg: BatchPackage): Promise<void> {
  for (const item of pkg.manifest.items) {
    assertPackaging(item)
    const files = Object.fromEntries(item.files.map(file => [file.path, pkg.objects[file.object]]))
    const metadata = files[item.packaging === "json" ? "export.json" : "manifest.json"]
    if (!metadata || metadata.length > 8 * 1024 * 1024) throw new Error("Batch item metadata exceeds its 8 MiB single-item limit.")
    const json = () => strFromU8(files["export.json"])
    switch (item.kind) {
      case "classic": parseConversationFile(json()); break
      case "mind-history": parseMindConversation(json()); break
      case "agentic": parseAgenticConversation(json()); break
      case "character": parseCharacterFile(json()); break
      case "mind": {
        const manifest = validateMindManifest(JSON.parse(strFromU8(files["manifest.json"])))
        const resources = Object.fromEntries(manifest.files.map(file => {
          const path = mindFileKey(file.scope, file.path)
          return [path, files[path]]
        }))
        if (Object.keys(files).length !== Object.keys(resources).length + 1) throw new Error("Unexpected files in batch Mind item.")
        await validateMindPackage({ manifest, files: resources }); break
      }
      case "library":
        if (Object.keys(files).length !== 2) throw new Error("Unexpected files in batch Library item.")
        await validateLibraryPackage({ manifest: validateLibraryManifest(JSON.parse(strFromU8(files["manifest.json"]))), bytes: files["asset.bin"] }); break
      case "studio-image":
      case "studio-audio": {
        const manifest = validateStudioManifest(JSON.parse(strFromU8(files["manifest.json"])))
        if (manifest.kind !== (item.kind === "studio-image" ? "image" : "audio")) throw new Error("Studio kind does not match batch item.")
        delete files["manifest.json"]
        await validateStudioPackage({ manifest, files }); break
      }
    }
  }
}
function assertPackaging(item: BatchItem) {
  const json = ["classic", "mind-history", "agentic", "character"].includes(item.kind)
  if (item.packaging !== (json ? "json" : "zip")) throw new Error("Batch content type and packaging disagree.")
}
