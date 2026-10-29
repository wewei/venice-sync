// @vitest-environment node
import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildBatch, canonicalJson, batchKey, type PreparedBatchItem, type BatchKind } from "./batch-format"
import { importBatch, planBatchImport } from "./batch-import"
import { currentVeniceOwner, waitForVeniceOwner, importClassicConversation } from "./venice-classic"
import { importMindPackage } from "./venice-mind-package"
import { importMindHistory, importAgenticHistory, listMindHistory } from "./venice-mind-history"
import { importCharacter } from "./venice-characters"
import { importLibraryAsset } from "./venice-library"
import { importStudioSession } from "./venice-studio"
import { getMindCollections } from "./native-rxdb"
import { sha256 } from "./mind-package-format"
import { studioFixture } from "./test/studio-fixture"

vi.mock("./venice-classic", () => ({ currentVeniceOwner: vi.fn(), waitForVeniceOwner: vi.fn(), importClassicConversation: vi.fn() }))
vi.mock("./venice-mind-package", () => ({ importMindPackage: vi.fn() }))
vi.mock("./venice-mind-history", () => ({ importMindHistory: vi.fn(), importAgenticHistory: vi.fn(), listMindHistory: vi.fn() }))
vi.mock("./venice-characters", () => ({ importCharacter: vi.fn() }))
vi.mock("./venice-library", () => ({ importLibraryAsset: vi.fn() }))
vi.mock("./venice-studio", () => ({ importStudioSession: vi.fn() }))
vi.mock("./native-rxdb", () => ({ getMindCollections: vi.fn() }))
const jsonFile = (name: string) => JSON.parse(readFileSync(path.join("scripts", "fixtures", `${name}.json`), "utf8"))
async function fixture(kinds: BatchKind[]) {
  const content = async (kind: BatchKind): Promise<Record<string, Uint8Array>> => {
    if (kind === "classic") return { "export.json": canonicalJson(jsonFile("classic-conversation")) }
    if (kind === "character") return { "export.json": canonicalJson(jsonFile("character")) }
    if (kind === "mind-history" || kind === "agentic") {
      const file = jsonFile("mind-conversation"); file.conversation.mindId = "fixture-mind"
      if (kind === "agentic") { file.format = "venice-sync-agentic-conversation"; delete file.conversation.mindId; delete file.conversation.remoteMindId }
      return { "export.json": canonicalJson(file) }
    }
    if (kind === "mind") return { "manifest.json": canonicalJson({ format: "venice-sync-mind", version: 1, exportedAt: "test",
      definition: { id: "fixture-mind", name: "Fixture Mind", systemPrompt: { instructions: "Test" }, tools: {}, assets: {} }, files: [] }) }
    if (kind === "library") {
      const bytes = new Uint8Array([1, 2, 3])
      return { "asset.bin": bytes, "manifest.json": canonicalJson({ format: "venice-sync-library-asset", version: 1, exportedAt: "test",
        asset: { filename: "image.png", kind: "image", mimeType: "image/png", bytes: 3, sha256: await sha256(bytes), source: { type: "file", id: "test", metadata: {} } } }) }
    }
    const pkg = await studioFixture()
    return { "manifest.json": canonicalJson(pkg.manifest), ...pkg.files }
  }
  async function* items(): AsyncIterable<PreparedBatchItem> {
    for (const kind of kinds) {
      const packaging = ["classic", "character", "mind-history", "agentic"].includes(kind) ? "json" : "zip"
      yield { selection: { kind, id: kind, title: kind }, packaging, filename: `${kind}.${packaging}`, files: await content(kind) }
    }
  }
  return buildBatch(items())
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(waitForVeniceOwner).mockResolvedValue("owner")
  vi.mocked(currentVeniceOwner).mockReturnValue("owner")
  vi.mocked(importClassicConversation).mockResolvedValue("new-classic")
  vi.mocked(importMindPackage).mockResolvedValue("new-mind")
  vi.mocked(importMindHistory).mockResolvedValue("new-history")
  vi.mocked(importAgenticHistory).mockResolvedValue("new-agentic")
  vi.mocked(importCharacter).mockResolvedValue("new-character")
  vi.mocked(importLibraryAsset).mockResolvedValue("new-library")
  vi.mocked(importStudioSession).mockResolvedValue("new-studio")
  vi.mocked(listMindHistory).mockResolvedValue({ conversations: [], targets: [{ kind: "local", id: "existing", name: "Existing Mind" }] })
})
describe("selected batch import planning and execution", () => {
  it("plans without writes and imports definitions before histories, remapping to the newly imported Mind", async () => {
    const pkg = await fixture(["mind-history", "classic", "mind", "agentic", "character", "library", "studio-image"])
    const plan = await planBatchImport(pkg, pkg.manifest.items.map(batchKey))
    expect(importClassicConversation).not.toHaveBeenCalled()
    expect(importMindPackage).not.toHaveBeenCalled()
    expect(plan.entries[0].content.kind).toBe("mind")
    const outcome = await importBatch(plan, {})
    expect(outcome.results).toHaveLength(7)
    expect(outcome.results.every(result => result.status === "success")).toBe(true)
    expect(importMindHistory).toHaveBeenCalledWith(expect.anything(), { kind: "local", id: "new-mind", name: "Imported Mind" })
    expect(vi.mocked(importMindPackage).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(importMindHistory).mock.invocationCallOrder[0])
    expect(outcome.needsReload).toBe(true)
  })
  it("requires explicit verified destinations when the Mind definition is not selected", async () => {
    const pkg = await fixture(["mind-history"])
    const plan = await planBatchImport(pkg, pkg.manifest.items.map(batchKey))
    await expect(importBatch(plan, {})).rejects.toThrow("destination")
    expect(importMindHistory).not.toHaveBeenCalled()
    const result = await importBatch(plan, { [batchKey(pkg.manifest.items[0])]: "local:existing" })
    expect(result.results[0].status).toBe("success")
    expect(result.needsReload).toBe(false)
  })
  it("stops at the first failed item and reports successful copies without pretending rollback", async () => {
    const pkg = await fixture(["classic", "character", "library"])
    const plan = await planBatchImport(pkg, pkg.manifest.items.map(batchKey))
    vi.mocked(importCharacter).mockRejectedValue(new Error("Cleanup is incomplete"))
    const result = await importBatch(plan, {})
    expect(result.results.map(result => result.status)).toEqual(["success", "failed"])
    expect(result.results[1].error).toBe("Cleanup is incomplete")
    expect(importLibraryAsset).not.toHaveBeenCalled()
    expect(result.needsReload).toBe(true)
    expect(result.stopped).toBe(true)
  })
  it("cancels only after a completed current item and never retries completed writes", async () => {
    const pkg = await fixture(["classic", "character"]), abort = new AbortController()
    const plan = await planBatchImport(pkg, pkg.manifest.items.map(batchKey))
    vi.mocked(importClassicConversation).mockImplementationOnce(async () => { abort.abort(); return "committed" })
    const result = await importBatch(plan, {}, { signal: abort.signal })
    expect(result.results).toEqual([expect.objectContaining({ status: "success", id: "committed" })])
    expect(result.stopped).toBe(true)
    expect(importCharacter).not.toHaveBeenCalled()
  })
  it("rejects account changes before writes and stops if ownership changes between items", async () => {
    const pkg = await fixture(["classic", "character"])
    const plan = await planBatchImport(pkg, pkg.manifest.items.map(batchKey))
    vi.mocked(currentVeniceOwner).mockReturnValue("other")
    await expect(importBatch(plan, {})).rejects.toThrow("No items")
    vi.mocked(currentVeniceOwner).mockReturnValue("owner")
    vi.mocked(importClassicConversation).mockImplementationOnce(async () => { vi.mocked(currentVeniceOwner).mockReturnValue("other"); return "new" })
    const result = await importBatch(plan, {})
    expect(result.results.map(result => result.status)).toEqual(["success", "failed"])
    expect(importCharacter).not.toHaveBeenCalled()
  })
  it("rejects corrupt objects, unknown selections and unsupported native schemas during review", async () => {
    const pkg = await fixture(["mind"])
    await expect(planBatchImport(pkg, ["unknown"])).rejects.toThrow("distinct")
    vi.mocked(getMindCollections).mockRejectedValue(new Error("Unsupported native schema"))
    await expect(planBatchImport(pkg, pkg.manifest.items.map(batchKey))).rejects.toThrow("Unsupported native")
    pkg.objects = {}
    await expect(planBatchImport(pkg, pkg.manifest.items.map(batchKey))).rejects.toThrow("missing")
    expect(importMindPackage).not.toHaveBeenCalled()
  })
})
