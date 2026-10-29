import { useEffect, useRef, useState } from "react"
import { IconDownload, IconRefresh, IconUpload } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { IconAction } from "./components/IconAction"
import { isRecord, parseConversationFile, type ConversationFile } from "./conversation-format"
import { parseAgenticConversation, parseMindConversation, type AgenticConversationFile, type MindConversationFile, type MindTarget } from "./mind-conversation-format"
import { downloadTransferJson, readTransferFile } from "./transfer-files"
import { currentVeniceOwner, exportClassicConversation, importClassicConversation, listClassicConversations, waitForVeniceOwner } from "./venice-classic"
import { exportAgenticHistory, exportMindHistory, importAgenticHistory, importMindHistory, listMindHistory } from "./venice-mind-history"
import { VeniceAgenticIcon, VeniceClassicIcon, VeniceMindIcon } from "./components/VeniceIcons"
import { MindAvatar } from "./MindAvatar"
import type { MindAvatarReference } from "./mind-avatars"
import { BasketAddAll, BasketItem } from "./BatchBasket"
import type { BatchSelection } from "./batch-format"

type ConversationKind = "classic" | "mind" | "agentic"
interface Row {
  id: string; name: string; kind: ConversationKind; detail: string; messages: number; updatedAt: number
  mindId?: string; remoteMindId?: string; avatar?: MindAvatarReference
}
type Preview = { kind: "classic"; file: ConversationFile } | { kind: "mind"; file: MindConversationFile } | { kind: "agentic"; file: AgenticConversationFile }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const key = (target: MindTarget) => `${target.kind}:${target.id}`
const typeNames = { classic: "Classic", mind: "Mind", agentic: "Agentic" }
const typeIcons = { classic: VeniceClassicIcon, mind: VeniceMindIcon, agentic: VeniceAgenticIcon }
const batchSelection = (row: Row): BatchSelection => ({ kind: row.kind === "mind" ? "mind-history" : row.kind, id: row.id, title: row.name })

export function ConversationTransfer({ reloadPage }: { reloadPage: () => void }) {
  const [rows, setRows] = useState<Row[]>([])
  const [targets, setTargets] = useState<MindTarget[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [readErrors, setReadErrors] = useState<string[]>([])
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [preview, setPreview] = useState<Preview>()
  const [destination, setDestination] = useState("")
  const [imported, setImported] = useState<{ kind: ConversationKind; href: string }>()
  const [revision, setRevision] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let active = true
    Promise.allSettled([
      waitForVeniceOwner().then(listClassicConversations),
      listMindHistory(),
    ]).then(([classic, mind]) => {
      if (!active) return
      const entries: Row[] = [], failures: string[] = []
      if (classic.status === "fulfilled") entries.push(...classic.value.map((row): Row => ({
        id: row.id, name: row.name, kind: "classic", detail: row.modelId, messages: row.messages, updatedAt: row.updatedAt,
      })))
      else failures.push(`Classic: ${errorText(classic.reason)}`)
      if (mind.status === "fulfilled") {
        setTargets(mind.value.targets)
        entries.push(...mind.value.conversations.map((row): Row => ({
          id: row.id, name: row.name, kind: row.kind, detail: row.mind, messages: row.messages, updatedAt: row.updatedAt,
          mindId: row.mindId, remoteMindId: row.remoteMindId, avatar: row.avatar,
        })))
      } else { setTargets([]); failures.push(`Mind / Agentic: ${errorText(mind.reason)}`) }
      setRows(entries.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name)))
      setReadErrors(failures); setLoading(false)
    })
    return () => { active = false }
  }, [revision])
  const refresh = () => { setError(undefined); setLoading(true); setRevision((value) => value + 1) }

  async function exportConversation(row: Row) {
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      const file = row.kind === "classic" ? await exportClassicConversation(currentVeniceOwner(), row.id) :
        row.kind === "agentic" ? await exportAgenticHistory(row.id) : await exportMindHistory(row.id)
      downloadTransferJson(file, `venice-${row.kind}-${row.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)
      setNotice("Conversation JSON downloaded. The file contains plaintext chat content; keep it private.")
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }

  async function selectFile(file: File) {
    setBusy(true); setError(undefined); setNotice(undefined); setPreview(undefined); setImported(undefined); setDestination("")
    try {
      const json = await readTransferFile(file)
      let value: unknown
      try { value = JSON.parse(json) } catch { throw new Error("Invalid JSON. Select a Classic or Mind conversation export.") }
      if (isRecord(value) && value.format === "venice-sync-mind-conversation") {
        const archive = parseMindConversation(json)
        const original = archive.conversation.mindId ? `local:${archive.conversation.mindId}` : `remote:${archive.conversation.remoteMindId}`
        setDestination(targets.some((target) => key(target) === original) ? original : "")
        setPreview({ kind: "mind", file: archive })
      } else if (isRecord(value) && value.format === "venice-sync-agentic-conversation") {
        setPreview({ kind: "agentic", file: parseAgenticConversation(json) })
      } else setPreview({ kind: "classic", file: parseConversationFile(json) })
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }

  async function confirmImport() {
    if (!preview) { setError("Select and preview a conversation before importing."); return }
    setBusy(true); setError(undefined)
    try {
      if (preview.kind === "classic") {
        const id = await importClassicConversation(currentVeniceOwner(), preview.file)
        setImported({ kind: "classic", href: `/chat/classic/${encodeURIComponent(id)}` }); setPreview(undefined)
        setNotice("Imported as a new local Classic chat. Reloading this page to refresh Venice's conversation list.")
        refresh()
        try { reloadPage() }
        catch (reason) {
          setNotice("Imported as a new local Classic chat.")
          setError(`Import succeeded, but Venice could not refresh: ${errorText(reason)}. Reload this page manually; do not import the file again.`)
        }
      } else if (preview.kind === "mind") {
        const target = targets.find((entry) => key(entry) === destination)
        if (!target) throw new Error("Select an available destination Mind before confirming.")
        const id = await importMindHistory(preview.file, target)
        const prefix = target.kind === "local" ? `/chat/minds/local/${encodeURIComponent(target.id)}` : `/chat/minds/${encodeURIComponent(target.id)}`
        setImported({ kind: "mind", href: `${prefix}/${encodeURIComponent(id)}` }); setPreview(undefined)
        setNotice("Imported as a new Mind conversation. Venice's live list updates without reloading this page.")
        refresh()
      } else {
        const id = await importAgenticHistory(preview.file)
        setImported({ kind: "agentic", href: `/chat/agent/${encodeURIComponent(id)}` }); setPreview(undefined)
        setNotice("Imported as a new Agentic conversation. Venice's live list updates without reloading this page.")
        refresh()
      }
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }

  return (
    <section aria-label="Conversation transfer" aria-busy={loading || busy} className="grid gap-5">
      <header className="flex items-center justify-between gap-4">
        <div><h2 className="text-xl font-medium">Conversations</h2><p className="mt-1 text-sm text-muted-foreground">All your conversations, together. Type icons match the conversation source.</p></div>
        <div className="flex shrink-0 gap-1">
          <IconAction label="Refresh chats" disabled={loading || busy} onClick={refresh}><IconRefresh aria-hidden="true" /></IconAction>
          <IconAction label="Upload conversation file" disabled={busy || loading} onClick={() => input.current?.click()}><IconUpload aria-hidden="true" /></IconAction>
        </div>
      </header>
      <input ref={input} type="file" aria-label="Import conversation JSON" accept=".json,application/json" className="sr-only" tabIndex={-1} disabled={busy || loading}
        onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void selectFile(file) }} />
      {loading && <p role="status">Reading conversations...</p>}
      {readErrors.map((failure) => <p role="alert" key={failure} className="text-sm">{failure}</p>)}
      {error && <p role="alert" className="text-sm">{error}</p>}
      {!loading && <BasketAddAll items={rows.map(batchSelection)} label="loaded conversations" disabled={busy} />}
      {!loading && <div data-testid="conversation-list" className="grid gap-2">
        <p className="text-sm text-muted-foreground">{rows.length} conversations{readErrors.length ? " (some sources unavailable)" : ""}</p>
        {rows.length === 0 && <p className="rounded-xl border p-8 text-center text-muted-foreground">{readErrors.length ? "No conversations could be loaded from the available sources." : "No conversations in this account."}</p>}
        {rows.map((row) => {
          const Icon = typeIcons[row.kind]
          return <article key={`${row.kind}:${row.id}`} data-conversation-id={row.id} data-conversation-kind={row.kind} className="flex min-w-0 items-center gap-4 rounded-xl border p-4">
            <span role="img" aria-label={`${typeNames[row.kind]} conversation`} title={`${typeNames[row.kind]} conversation`} className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted">
              {row.kind === "mind" ? <MindAvatar mindId={row.mindId} remoteMindId={row.remoteMindId} avatar={row.avatar} name={row.detail} compact /> : <Icon aria-hidden="true" className="size-5" />}
            </span>
            <div className="min-w-0 flex-1"><h3 className="truncate font-medium" title={row.name}>{row.name}</h3>
              <p className="mt-1 truncate text-sm text-muted-foreground" title={row.detail}>{row.messages} messages · {row.detail}</p>
            </div>
            <BasketItem item={batchSelection(row)} disabled={busy} />
            <IconAction label={row.kind === "mind" ? "Export Mind JSON" : row.kind === "agentic" ? "Export Agentic JSON" : "Export JSON"} disabled={busy} onClick={() => void exportConversation(row)}><IconDownload aria-hidden="true" /></IconAction>
          </article>
        })}
      </div>}
      <details className="rounded-lg border p-3 text-sm text-muted-foreground"><summary className="cursor-pointer">Transfer support &amp; privacy</summary>
        <p className="mt-3">Classic text and ended Mind / Agentic text/reasoning JSON, up to 8 MiB. Attachments and tool histories are not supported here and are rejected rather than dropped. Exported JSON is plaintext. Account verification contacts only Venice's own service; no chat contents are uploaded.</p>
      </details>
      {preview && <div data-testid={preview.kind === "classic" ? "import-preview" : preview.kind === "mind" ? "mind-import-preview" : "agentic-import-preview"} className="grid gap-3 rounded-xl border p-5 text-sm">
        <div><p className="text-muted-foreground">{typeNames[preview.kind]} import preview</p><h3 className="mt-1 text-lg font-medium">{preview.file.conversation.name || "Untitled conversation"}</h3></div>
        <p>{preview.file.messages.length} messages. Creates a new copy; existing conversations are never overwritten.</p>
        {preview.kind === "classic" ? <p>After import, this page reloads automatically. Save unsent drafts and finish ongoing generation before confirming.</p> : preview.kind === "mind" ? <>
          <label className="grid gap-2">Destination Mind<select value={destination} disabled={busy} className="min-w-0 rounded-lg border bg-background p-3 text-foreground" onChange={(event) => setDestination(event.currentTarget.value)}>
            <option value="">Select an existing Mind</option>{targets.map((target) => <option key={key(target)} value={key(target)}>{target.name} ({target.kind})</option>)}
          </select></label>
          <p>Uses the chosen Mind's current definition. No Mind definition is created or overwritten. Keep this page open until import finishes.</p>
        </> : <p>Restores an independent Agentic chat, without a Mind binding or tool replay. Venice's current default agent/model settings apply to future replies. Keep this page open until import finishes.</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || (preview.kind === "mind" && !destination)} onClick={() => void confirmImport()}>{preview.kind === "classic" ? "Confirm import as new chat" : preview.kind === "mind" ? "Confirm Mind history import" : "Confirm Agentic history import"}</Button>
          <Button variant="outline" disabled={busy} onClick={() => setPreview(undefined)}>{preview.kind === "classic" ? "Cancel import" : preview.kind === "mind" ? "Cancel Mind import" : "Cancel Agentic import"}</Button>
        </div>
      </div>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {imported && <a className="underline" data-testid={imported.kind === "classic" ? "imported-chat-link" : imported.kind === "mind" ? "imported-mind-chat-link" : "imported-agentic-chat-link"} href={imported.href}>Open imported {typeNames[imported.kind]} conversation</a>}
    </section>
  )
}
