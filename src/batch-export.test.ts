// @vitest-environment node
import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { strFromU8 } from "fflate"
import { currentVeniceOwner, waitForVeniceOwner, exportClassicConversation } from "./venice-classic"
import { exportMindHistory, exportAgenticHistory } from "./venice-mind-history"
import { exportMindPackage } from "./venice-mind-package"
import { exportCharacter } from "./venice-characters"
import { exportLibraryAsset } from "./venice-library"
import { exportStudioSession } from "./venice-studio"
import { sha256, type MindPackage } from "./mind-package-format"
import { canonicalJson, decodeBatch, encodeBatch, reconstructBatchItem, type BatchSelection } from "./batch-format"
import { exportBatch, validateBatchContents } from "./batch-export"
import { studioAudioFixture, studioFixture } from "./test/studio-fixture"
import { parseConversationFile } from "./conversation-format"
import { parseMindConversation, parseAgenticConversation } from "./mind-conversation-format"
import { parseCharacterFile } from "./character-format"
import { decodeMindPackage } from "./mind-package-format"
import { decodeLibraryPackage } from "./library-format"
import { decodeStudioPackage } from "./studio-session-format"

vi.mock("./venice-classic", () => ({ currentVeniceOwner: vi.fn(), waitForVeniceOwner: vi.fn(), exportClassicConversation: vi.fn() }))
vi.mock("./venice-mind-history", () => ({ exportMindHistory: vi.fn(), exportAgenticHistory: vi.fn() }))
vi.mock("./venice-mind-package", () => ({ exportMindPackage: vi.fn() }))
vi.mock("./venice-characters", () => ({ exportCharacter: vi.fn() }))
vi.mock("./venice-library", () => ({ exportLibraryAsset: vi.fn() }))
vi.mock("./venice-studio", () => ({ exportStudioSession: vi.fn() }))
const selection = (kind: BatchSelection["kind"]): BatchSelection => ({ kind, id: kind, title: `${kind} fixture` })
beforeEach(async () => {
  vi.resetAllMocks()
  vi.mocked(currentVeniceOwner).mockReturnValue("owner")
  vi.mocked(waitForVeniceOwner).mockResolvedValue("owner")
  vi.mocked(exportClassicConversation).mockResolvedValue(parseConversationFile(readFileSync("scripts\\fixtures\\classic-conversation.json", "utf8")))
  const mind = parseMindConversation(readFileSync("scripts\\fixtures\\mind-conversation.json", "utf8"))
  vi.mocked(exportMindHistory).mockResolvedValue(mind)
  const agentic = JSON.parse(JSON.stringify(mind))
  agentic.format = "venice-sync-agentic-conversation"; delete agentic.conversation.mindId; delete agentic.conversation.remoteMindId
  vi.mocked(exportAgenticHistory).mockResolvedValue(parseAgenticConversation(JSON.stringify(agentic)))
  vi.mocked(exportCharacter).mockResolvedValue(parseCharacterFile(readFileSync("scripts\\fixtures\\character.json", "utf8")))
  const bytes = new Uint8Array([5, 6, 7])
  const pkg: MindPackage = { manifest: { format: "venice-sync-mind", version: 1, exportedAt: "test",
    definition: { id: "mind", name: "Synthetic", systemPrompt: { instructions: "Test" }, tools: {}, assets: {} },
    files: [{ scope: "mind", path: "assets/file.png", size: 3, sha256: await sha256(bytes) }] },
    files: { "files/mind/assets/file.png": bytes } }
  vi.mocked(exportMindPackage).mockResolvedValue(pkg)
  vi.mocked(exportLibraryAsset).mockResolvedValue({ manifest: { format: "venice-sync-library-asset", version: 1, exportedAt: "test",
    asset: { filename: "test.png", kind: "image", mimeType: "image/png", bytes: 3, sha256: await sha256(bytes), source: { type: "file", id: "source", metadata: {} } } }, bytes })
  vi.mocked(exportStudioSession).mockImplementation(async (_id, _files, kind) => kind === "audio" ? studioAudioFixture() : studioFixture())
})
describe("batch native export orchestration", () => {
  it("uses existing adapters and reconstructs mixed native import formats without nested ZIPs", async () => {
    const pkg = await exportBatch(["classic", "mind-history", "agentic", "mind", "character", "library", "studio-image", "studio-audio"].map(kind => selection(kind as BatchSelection["kind"])))
    await expect(validateBatchContents(pkg)).resolves.toBeUndefined()
    const decoded = await decodeBatch(await encodeBatch(pkg))
    for (const item of decoded.manifest.items) {
      const bytes = reconstructBatchItem(decoded, item)
      switch (item.kind) {
        case "classic": expect(parseConversationFile(strFromU8(bytes)).messages).toHaveLength(2); break
        case "mind-history": expect(parseMindConversation(strFromU8(bytes)).conversation).toBeDefined(); break
        case "agentic": expect(parseAgenticConversation(strFromU8(bytes)).conversation).toBeDefined(); break
        case "character": expect(parseCharacterFile(strFromU8(bytes)).character).toBeDefined(); break
        case "mind": expect((await decodeMindPackage(bytes)).files["files/mind/assets/file.png"]).toEqual(new Uint8Array([5, 6, 7])); break
        case "library": expect((await decodeLibraryPackage(bytes)).bytes).toEqual(new Uint8Array([5, 6, 7])); break
        case "studio-image": expect((await decodeStudioPackage(bytes)).manifest.kind).toBe("image"); break
        case "studio-audio": expect((await decodeStudioPackage(bytes)).manifest.kind).toBe("audio"); break
      }
    }
    expect(exportMindPackage).toHaveBeenCalledWith("mind", { assistant: true, preview: true })
    expect(exportStudioSession).toHaveBeenCalledWith("studio-image", undefined, "image")
    expect(exportStudioSession).toHaveBeenCalledWith("studio-audio", undefined, "audio")
  })
  it("rejects partial failures and does not continue reading later selections", async () => {
    vi.mocked(exportMindPackage).mockRejectedValue(new Error("Missing original"))
    await expect(exportBatch([selection("classic"), selection("mind"), selection("library")])).rejects.toThrow('mind "mind fixture": Missing original')
    expect(exportLibraryAsset).not.toHaveBeenCalled()
  })
  it("rejects an account switch, cancellation and repeated selection", async () => {
    vi.mocked(exportClassicConversation).mockImplementationOnce(async () => {
      vi.mocked(currentVeniceOwner).mockReturnValue("other")
      return parseConversationFile(readFileSync("scripts\\fixtures\\classic-conversation.json", "utf8"))
    })
    await expect(exportBatch([selection("classic")])).rejects.toThrow("account changed")
    const abort = new AbortController(); abort.abort()
    await expect(exportBatch([selection("library")], { signal: abort.signal })).rejects.toThrow()
    expect(exportLibraryAsset).not.toHaveBeenCalled()
    await expect(exportBatch([selection("classic"), selection("classic")])).rejects.toThrow("distinct")
  })
  it("rejects semantically wrong item formats even with valid object checksums", async () => {
    const pkg = await exportBatch([selection("classic")])
    const item = pkg.manifest.items[0], invalid = canonicalJson({ format: "other" }), hash = await sha256(invalid)
    pkg.objects = { [hash]: invalid }; item.files = [{ path: "export.json", object: hash, bytes: invalid.length }]
    await expect(validateBatchContents(pkg)).rejects.toThrow()
  })
})
