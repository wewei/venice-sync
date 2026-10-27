import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { MAX_CONVERSATION_BYTES, parseConversationFile, prepareConversationImport, validateConversationFile } from "./conversation-format"

function fixture() {
  return parseConversationFile(readFileSync(path.resolve("scripts", "fixtures", "classic-conversation.json"), "utf8"))
}

describe("Classic conversation JSON", () => {
  it("round trips all plain text, roles and timestamps, including Unicode", () => {
    const data = fixture()
    data.messages[0].content = "\u4f60\u597d\n<test>&\ud83d\ude00"
    expect(parseConversationFile(JSON.stringify(data))).toEqual(data)
    const { conversation, messages } = data
    expect(validateConversationFile({ conversation, messages }).messages).toEqual(messages)
  })

  it("preserves default media configuration on ordinary text messages", () => {
    const data = fixture()
    for (const message of data.messages) {
      message.imageSettings = { width: 1024, height: 1024, format: "webp", negativePrompt: "" }
      message.videoSettings = { duration: 5 }
      message.audioSettings = { voiceId: "test-voice" }
      message.attachments = []
    }
    expect(parseConversationFile(JSON.stringify(data))).toEqual(data)
  })

  it("creates new IDs, binds the current owner, and removes temporary/folder state", () => {
    const data = fixture()
    Object.assign(data.conversation, { ownerId: "old-owner", folderId: "old-folder", sessionId: "old-session", expirationTimestamp: 1 })
    let sequence = 0
    const result = prepareConversationImport(data, "current-owner", () => `new-${sequence++}`)
    expect(result.conversation).toMatchObject({ id: "new-0", ownerId: "current-owner", folderId: null, isTemporary: false, expirationMode: "permanent" })
    expect(result.conversation.sessionId).toBeUndefined()
    expect(result.conversation.expirationTimestamp).toBeUndefined()
    expect(result.messages.map((entry) => entry.id)).toEqual(["new-1", "new-2"])
    expect(result.messages.every((entry) => entry.conversationId === "new-0" && entry.ownerId === "current-owner")).toBe(true)
    expect(data.conversation.id).toBe("venice-sync-fixture-conversation")
  })

  it("rejects malformed, oversized and future-format files", () => {
    expect(() => parseConversationFile("{")).toThrow("Invalid JSON")
    expect(() => parseConversationFile(" ".repeat(MAX_CONVERSATION_BYTES + 1))).toThrow("8 MiB")
    expect(() => validateConversationFile({ ...fixture(), version: 2 })).toThrow("version")
    expect(() => validateConversationFile({ v: 1, messages: [] })).toThrow("Classic")
    expect(() => parseConversationFile('{"__proto__": {}}')).toThrow("unsafe")
  })

  it.each([
    ["duplicate IDs", (data: ReturnType<typeof fixture>) => { data.messages[1].id = data.messages[0].id }],
    ["foreign messages", (data: ReturnType<typeof fixture>) => { data.messages[0].conversationId = "other" }],
    ["attachments", (data: ReturnType<typeof fixture>) => { data.messages[0].attachments = [{ type: "Document" }] }],
    ["image masks", (data: ReturnType<typeof fixture>) => { data.messages[0].imageSettings = { maskMedia: { id: "mask" } } }],
    ["image doodles", (data: ReturnType<typeof fixture>) => { data.messages[0].imageSettings = { doodleMedia: { id: "doodle" } } }],
    ["doodle sources", (data: ReturnType<typeof fixture>) => { data.messages[0].imageSettings = { doodleSourceMedia: { id: "source" } } }],
    ["video paths", (data: ReturnType<typeof fixture>) => { data.messages[0].videoPath = "video.mp4" }],
    ["audio paths", (data: ReturnType<typeof fixture>) => { data.messages[0].audioPath = "audio.mp3" }],
    ["branching", (data: ReturnType<typeof fixture>) => { data.messages[1].parentMessageId = data.messages[0].id }],
    ["non-text media", (data: ReturnType<typeof fixture>) => { Object.assign(data.messages[0], { modelType: "image" }) }],
    ["characters", (data: ReturnType<typeof fixture>) => { data.conversation.characterId = "character" }],
    ["invalid timestamps", (data: ReturnType<typeof fixture>) => { data.messages[0].createdAtUnixTimestamp = -1 }],
    ["non-string content", (data: ReturnType<typeof fixture>) => { Object.assign(data.messages[0], { content: [] }) }],
  ])("rejects %s without dropping data", (_name, mutate) => {
    const data = fixture()
    mutate(data)
    expect(() => validateConversationFile(data)).toThrow()
  })
})
