import { useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { IconBasketPlus, IconCheck, IconDownload, IconFolderOpen, IconX } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { IconAction } from "./components/IconAction"
import { BatchContext } from "./batch-context"
import { batchKey, decodeBatch, encodeBatch, MAX_BATCH_BYTES, MAX_BATCH_ITEMS, reconstructBatchItem, type BatchPackage, type BatchSelection } from "./batch-format"
import { exportBatch, validateBatchContents } from "./batch-export"
import { currentVeniceOwner } from "./venice-classic"
import { BatchImportPanel } from "./BatchImportPanel"

function downloadBytes(bytes: Uint8Array, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type }))
  const link = document.createElement("a")
  link.href = url; link.download = filename; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function BasketItem({ item, disabled = false }: { item: BatchSelection; disabled?: boolean }) {
  const basket = useContext(BatchContext)
  if (!basket) return null
  const selected = basket.items.some(entry => batchKey(entry) === batchKey(item))
  const label = `${selected ? "Remove from" : "Add to"} export basket: ${item.title}`
  return <IconAction label={label} aria-pressed={selected} disabled={disabled || basket.busy}
    onClick={() => selected ? basket.remove(item) : basket.add([item])}>
    {selected ? <IconCheck aria-hidden="true" /> : <IconBasketPlus aria-hidden="true" />}
  </IconAction>
}
export function BasketAddAll({ items, label, disabled = false }: { items: BatchSelection[]; label: string; disabled?: boolean }) {
  const basket = useContext(BatchContext)
  if (!basket) return null
  return <Button variant="outline" size="sm" disabled={disabled || basket.busy || !items.length} onClick={() => basket.add(items)}>
    <IconBasketPlus aria-hidden="true" />Add all {label} ({items.length})
  </Button>
}

export function BatchBasket({ children, reloadPage, onImportingChange }: {
  children: ReactNode; reloadPage?: () => void; onImportingChange?: (busy: boolean) => void
}) {
  const [items, setItems] = useState<BatchSelection[]>([])
  const [busy, setBusy] = useState(false), [expanded, setExpanded] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string>(), [notice, setNotice] = useState<string>()
  const [progress, setProgress] = useState(0), [archive, setArchive] = useState<BatchPackage>()
  const controller = useRef<AbortController | undefined>(undefined), active = useRef(true)
  const fileInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    active.current = true
    return () => { active.current = false; controller.current?.abort() }
  }, [])
  const remove = (item: BatchSelection) => setItems(current => current.filter(entry => batchKey(entry) !== batchKey(item)))
  function add(incoming: BatchSelection[]) {
    const merged = new Map(items.map(item => [batchKey(item), item]))
    incoming.forEach(item => merged.set(batchKey(item), item))
    if (merged.size > MAX_BATCH_ITEMS) { setError("The export basket allows at most 200 items. Add a smaller selection."); return }
    setItems([...merged.values()]); setError(undefined)
  }
  async function download() {
    const abort = new AbortController(); controller.current = abort
    setBusy(true); setExporting(true); setError(undefined); setNotice(undefined); setProgress(0)
    try {
      const owner = currentVeniceOwner()
      const pkg = await exportBatch(items, { signal: abort.signal, onProgress: completed => { if (active.current) setProgress(completed) } })
      const bytes = await encodeBatch(pkg, abort.signal)
      abort.signal.throwIfAborted()
      if (!active.current) return
      if (currentVeniceOwner() !== owner) throw new Error("The signed-in account changed. No batch was downloaded.")
      downloadBytes(bytes, `venice-batch-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`, "application/zip")
      setNotice(`${items.length} items exported in one batch. Nothing was uploaded. The archive is unencrypted; keep it private.`)
    } catch (reason) {
      if (active.current) {
        if (abort.signal.aborted) setNotice("Batch export cancelled. No batch was downloaded; the basket is unchanged.")
        else setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally { if (active.current) { setBusy(false); setExporting(false) }; controller.current = undefined }
  }
  async function openArchive(file: File) {
    setBusy(true); setError(undefined); setNotice(undefined); setArchive(undefined)
    try {
      if (file.size > MAX_BATCH_BYTES) throw new Error("Batch ZIP exceeds 128 MiB.")
      const pkg = await decodeBatch(new Uint8Array(await file.arrayBuffer()))
      await validateBatchContents(pkg)
      if (active.current) { setArchive(pkg); setExpanded(true); setNotice("Batch verified. Take out individual files and use the existing import previews; opening a batch writes nothing.") }
    } catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (active.current) setBusy(false) }
  }
  return <BatchContext.Provider value={{ items, busy, add, remove }}>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <section aria-label="Export basket" className="grid shrink-0 gap-2 rounded-lg border p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" aria-expanded={expanded} disabled={busy} onClick={() => setExpanded(value => !value)}>Export basket ({items.length})</Button>
          <IconAction label="Download export basket" disabled={busy || !items.length} onClick={() => void download()}><IconDownload aria-hidden="true" /></IconAction>
          <IconAction label="Open batch archive" disabled={busy} onClick={() => fileInput.current?.click()}><IconFolderOpen aria-hidden="true" /></IconAction>
          {busy && exporting && <Button size="sm" variant="outline" onClick={() => controller.current?.abort()}>Cancel batch export</Button>}
          {busy && <span role="status">{exporting ? `Preparing ${progress}/${items.length} items...` : "Verifying batch archive..."}</span>}
        </div>
        <input ref={fileInput} type="file" accept=".zip" aria-label="Open batch ZIP" className="sr-only" disabled={busy}
          onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void openArchive(file) }} />
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {expanded && <div className="grid max-h-52 gap-3 overflow-y-auto" data-testid="batch-basket-details">
          <p className="text-xs text-muted-foreground">Add items from any content page. Minds include all saved package content; selecting chats does not automatically include their Mind definitions. Export is a sequence of reads, not an atomic account snapshot. Limits: 200 items, 4096 files, 128 MiB logical/expanded/ZIP. Close the panel to discard the basket.</p>
          {!!items.length && <Button size="sm" variant="ghost" className="w-fit" disabled={busy} onClick={() => setItems([])}>Clear export basket</Button>}
          {items.map(item => <div key={batchKey(item)} className="flex min-w-0 items-center gap-2" data-basket-item={batchKey(item)}>
            <span className="min-w-0 flex-1 truncate" title={item.title}>{item.kind} · {item.title}</span>
            <IconAction label={`Remove basket item: ${item.title}`} disabled={busy} onClick={() => remove(item)}><IconX aria-hidden="true" /></IconAction>
          </div>)}
          {archive && <section aria-label="Opened batch contents" className="grid gap-2">
            <h3 className="font-medium">Take items out of this batch ({archive.manifest.items.length})</h3>
            <p className="text-xs text-muted-foreground">Take out an original-format file, or select items below to review and import new copies. Opening the batch itself writes nothing.</p>
            <Button size="sm" variant="ghost" className="w-fit" disabled={busy} onClick={() => setArchive(undefined)}>Close opened batch</Button>
            {archive.manifest.items.map(item => <div key={batchKey(item)} className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={item.title}>{item.kind} · {item.title}</span>
              <IconAction label={`Take out item: ${item.title}`} disabled={busy} onClick={() => {
                try { downloadBytes(reconstructBatchItem(archive, item), item.filename, item.packaging === "json" ? "application/json" : "application/zip") }
                catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
              }}><IconDownload aria-hidden="true" /></IconAction>
            </div>)}
            {reloadPage && <BatchImportPanel archive={archive} busy={busy} onBusyChange={setBusy} onImportingChange={onImportingChange} reloadPage={reloadPage} />}
          </section>}
        </div>}
      </section>
      <fieldset disabled={busy} className="flex min-h-0 min-w-0 flex-1 border-0 p-0">{children}</fieldset>
    </div>
  </BatchContext.Provider>
}
