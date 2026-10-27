import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { MAX_CONVERSATION_BYTES } from "./conversation-format"
import { parseAgenticConversation, prepareAgenticImport, validateAgenticConversation, validateMindConversation } from "./mind-conversation-format"

function fixture() {
  const file = JSON.parse(readFileSync(path.resolve("scripts", "fixtures", "mind-conversation.json"), "utf8"))
  delete file.conversation.mindId
  file.format = "venice-sync-agentic-conversation"
  return validateAgenticConversation(file)
}

describe("Agentic history archive", () => {
  it("preserves structured text/reasoning, roles and timestamps without a Mind association", () => {
    const file = fixture()
    expect(parseAgenticConversation(JSON.stringify(file))).toEqual(file)
    expect(file.messages[1].output_items.map((item) => item.type)).toEqual(["reasoning", "message"])
    expect(() => validateMindConversation(file)).toThrow("Mind conversation")
  })

  it("creates new conversation/message/item/turn IDs without inheriting account or folder bindings", () => {
    const file = fixture()
    file.conversation.ownerId = "old-owner"
    file.conversation.folderId = "old-folder"
    let sequence = 0
    const prepared = prepareAgenticImport(file, "current-owner", () => `new-${sequence++}`)
    expect(prepared.conversation).toMatchObject({ id: "new-0", ownerId: "current-owner", type: "chat" })
    expect(prepared.conversation.mindId).toBeUndefined()
    expect(prepared.conversation.remoteMindId).toBeUndefined()
    expect(prepared.conversation.folderId).toBeUndefined()
    expect(prepared.messages[0].turn_id).toBe(prepared.messages[0].id)
    expect(prepared.messages[1].turn_id).toBe(prepared.messages[0].id)
    expect(prepared.messages[0].output_items[0].response_id).toBe(prepared.messages[0].id)
    expect(prepared.messages[0].output_items[0].content[0].item_id).toBe(prepared.messages[0].output_items[0].id)
  })

  it.each([
    ["Mind binding", (file: ReturnType<typeof fixture>) => { file.conversation.mindId = "mind" }],
    ["remote Mind binding", (file: ReturnType<typeof fixture>) => { file.conversation.remoteMindId = "remote" }],
    ["Studio binding", (file: ReturnType<typeof fixture>) => { file.conversation.studioProjectId = "studio" }],
    ["tool execution", (file: ReturnType<typeof fixture>) => { file.messages[0].output_items[0].type = "functionCall" }],
    ["media", (file: ReturnType<typeof fixture>) => { file.messages[0].output_items[0].content = [{ id: "image", type: "input_image", media_id: "missing" }] }],
    ["unfinished generation", (file: ReturnType<typeof fixture>) => { Object.assign(file.messages[0], { status: "in_progress" }) }],
  ])("rejects %s instead of silently reclassifying or discarding it", (_name, mutate) => {
    const file = fixture()
    mutate(file)
    expect(() => validateAgenticConversation(file)).toThrow()
  })

  it("rejects invalid JSON and oversized archives", () => {
    expect(() => parseAgenticConversation("{")).toThrow("Invalid")
    expect(() => parseAgenticConversation(" ".repeat(MAX_CONVERSATION_BYTES + 1))).toThrow("8 MiB")
  })
})
