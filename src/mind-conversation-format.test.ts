import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parseMindConversation, prepareMindImport, validateMindConversation } from "./mind-conversation-format"

function fixture() {
  return parseMindConversation(readFileSync(path.resolve("scripts", "fixtures", "mind-conversation.json"), "utf8"))
}

describe("Mind history format", () => {
  it("preserves structured text, reasoning, statuses and timestamps", () => {
    const file = fixture()
    expect(parseMindConversation(JSON.stringify(file))).toEqual(file)
    expect(file.messages[1].output_items.map((item) => item.type)).toEqual(["reasoning", "message"])
  })

  it("remaps nested IDs and shared turn references while binding the chosen Mind", () => {
    const file = fixture()
    let sequence = 0
    const prepared = prepareMindImport(file, "current-owner", { kind: "local", id: "destination", name: "Target" }, () => `new-${sequence++}`)
    expect(prepared.conversation).toMatchObject({ id: "new-0", ownerId: "current-owner", mindId: "destination" })
    expect(prepared.messages[0].id).not.toBe(file.messages[0].id)
    expect(prepared.messages.every((entry) => entry.mind_conversation_id === prepared.id && entry.owner_id === "current-owner")).toBe(true)
    expect(prepared.messages[0].turn_id).toBe(prepared.messages[0].id)
    expect(prepared.messages[1].turn_id).toBe(prepared.messages[0].id)
    const output = prepared.messages[0].output_items[0]
    expect(output.response_id).toBe(prepared.messages[0].id)
    expect(output.content[0].item_id).toBe(output.id)
    expect(output.content[0].response_id).toBe(prepared.messages[0].id)
    const remote = prepareMindImport(file, "owner", { kind: "remote", id: "published", name: "Remote" })
    expect(remote.conversation.remoteMindId).toBe("published")
    expect(remote.conversation.mindId).toBeUndefined()
  })

  it.each([
    ["active generations", (f: ReturnType<typeof fixture>) => Object.assign(f.messages[0], { status: "in_progress" })],
    ["tool execution", (f: ReturnType<typeof fixture>) => { f.messages[1].output_items[0].type = "toolCallExecution" }],
    ["nested agents", (f: ReturnType<typeof fixture>) => { f.messages[1].output_items[0].container_id = "agent" }],
    ["foreign messages", (f: ReturnType<typeof fixture>) => { f.messages[0].mind_conversation_id = "other" }],
    ["duplicate IDs", (f: ReturnType<typeof fixture>) => { f.messages[1].id = f.messages[0].id }],
    ["missing response references", (f: ReturnType<typeof fixture>) => { f.messages[0].output_items[0].response_id = "missing" }],
    ["raw RxDB fields", (f: ReturnType<typeof fixture>) => { f.messages[0]._deleted = true }],
    ["Agentic histories", (f: ReturnType<typeof fixture>) => { delete f.conversation.mindId }],
    ["ambiguous Mind bindings", (f: ReturnType<typeof fixture>) => { f.conversation.remoteMindId = "remote" }],
    ["Studio links", (f: ReturnType<typeof fixture>) => { f.conversation.studioProjectId = "project" }],
  ])("rejects %s instead of dropping data", (_name, mutate) => {
    const file = fixture()
    mutate(file)
    expect(() => validateMindConversation(file)).toThrow()
  })

  it("rejects the wrong formats and invalid JSON", () => {
    expect(() => parseMindConversation("{")).toThrow("Invalid")
    expect(() => validateMindConversation({ format: "venice-sync-classic", version: 1 })).toThrow("Mind conversation")
    expect(() => parseMindConversation('{"__proto__":{}}')).toThrow("unsafe")
  })
})
