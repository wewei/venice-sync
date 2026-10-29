import { useContext, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { IconArrowLeft, IconBasket, IconBasketPlus, IconCheck, IconDownload, IconFolderOpen, IconX } from "@tabler/icons-react"
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

export function BatchBasket({ children, header, navigation, reloadPage, onImportingChange, visible = true }: {
  children: ReactNode; header?: ReactNode; navigation?: ReactNode; reloadPage?: () => void; onImportingChange?: (busy: boolean) => void; visible?: boolean
}) {
  const [items, setItems] = useState<BatchSelection[]>([])
  const [busy, setBusy] = useState(false), [expanded, setExpanded] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [view, setView] = useState<"export" | "import">("export")
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string>(), [notice, setNotice] = useState<string>()
  const [progress, setProgress] = useState(0), [archive, setArchive] = useState<BatchPackage>()
  const controller = useRef<AbortController | undefined>(undefined), active = useRef(true)
  const fileInput = useRef<HTMLInputElement>(null)
  const trigger = useRef<HTMLButtonElement>(null), back = useRef<HTMLButtonElement>(null)
  const drawerId = useId(), titleId = useId()
  useEffect(() => {
    onImportingChange?.(importing)
    return () => onImportingChange?.(false)
  }, [importing, onImportingChange])
  useEffect(() => {
    if (!expanded || !visible) return
    back.current?.focus()
    const returnTarget = trigger.current
    return () => {
      if (returnTarget?.isConnected && !returnTarget.closest("[hidden]")) returnTarget.focus({ preventScroll: true })
    }
  }, [expanded, visible])
  useEffect(() => { if (!visible) controller.current?.abort() }, [visible])
  useEffect(() => {
    active.current = true
    return () => { active.current = false; controller.current?.abort() }
  }, [])
  const remove = (item: BatchSelection) => setItems(current => current.filter(entry => batchKey(entry) !== batchKey(item)))
  function add(incoming: BatchSelection[]) {
    const merged = new Map(items.map(item => [batchKey(item), item]))
    incoming.forEach(item => merged.set(batchKey(item), item))
    if (merged.size > MAX_BATCH_ITEMS) { setError("The export basket allows at most 200 items. Add a smaller selection."); setView("export"); setExpanded(true); return }
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
      if (active.current) { setArchive(pkg); setNotice("Batch verified. Select items to review and import, or take out original files. Opening a batch writes nothing.") }
    } catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (active.current) setBusy(false) }
  }
  return <BatchContext.Provider value={{ items, busy, add, remove }}>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div hidden={expanded} className="flex min-h-0 min-w-0 flex-1 flex-col gap-5">
        <div className="flex shrink-0 items-start justify-between gap-2">
          <div className="min-w-0">{header ?? <h2 className="font-medium">Venice Sync</h2>}</div>
          <IconAction ref={trigger} label={`Export basket (${items.length})`} aria-controls={drawerId} aria-expanded={expanded}
            className="relative size-11 shrink-0" onClick={() => setExpanded(true)}>
            <IconBasket aria-hidden="true" />
            <span aria-hidden="true" className="absolute top-0 right-0 min-w-5 rounded-full bg-secondary px-1 text-[0.65rem] font-medium">{items.length}</span>
          </IconAction>
        </div>
        {busy && <p role="status" className="sr-only">{importing ? "Batch import running. Open the basket to review progress." : "Batch operation running. Open the basket to review progress."}</p>}
        <fieldset disabled={busy} className="flex min-h-0 min-w-0 flex-1 border-0 p-0">{children}</fieldset>
      </div>
        <section hidden={!expanded} id={drawerId} role="region" aria-labelledby={titleId} data-testid="batch-basket-page"
          onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setExpanded(false) } }}
          className="flex min-h-0 min-w-0 flex-1 flex-col [&_button]:min-h-11 [&_button]:whitespace-normal [&_button[data-size=icon]]:min-w-11">
          <div className="flex shrink-0 items-center gap-2 border-b p-2">
            <IconAction ref={back} label="Back to content" className="size-11 shrink-0" onClick={() => setExpanded(false)}><IconArrowLeft aria-hidden="true" /></IconAction>
            {navigation}
            <h1 id={titleId} className="text-lg font-medium">Content basket</h1>
            {importing && <span role="status" className="ml-auto text-xs">Import running</span>}
          </div>
          <div role="group" aria-label="Basket views" className="grid shrink-0 grid-cols-2 gap-1 border-b p-2">
            <Button className="h-auto min-h-11 whitespace-normal" variant={view === "export" ? "secondary" : "ghost"} aria-pressed={view === "export"} onClick={() => setView("export")}>To export ({items.length})</Button>
            <Button className="h-auto min-h-11 whitespace-normal" variant={view === "import" ? "secondary" : "ghost"} aria-pressed={view === "import"} onClick={() => setView("import")}>Import from backup</Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 [overflow-wrap:anywhere]">
            {error && <p role="alert">{error}</p>}
            {notice && <p role="status">{notice}</p>}
            <section hidden={view !== "export"} aria-label="Export basket" className="grid min-w-0 gap-3" data-testid="batch-basket-details">
              <div className="flex flex-wrap items-center gap-2">
                <IconAction label="Download export basket" disabled={busy || !items.length} onClick={() => void download()}><IconDownload aria-hidden="true" /></IconAction>
                {busy && exporting && <Button size="sm" variant="outline" onClick={() => controller.current?.abort()}>Cancel batch export</Button>}
                {exporting && <span role="status">{`Preparing ${progress}/${items.length} items...`}</span>}
              </div>
              <p className="text-xs text-muted-foreground">Add items from any content page. Minds include all saved package content; selecting chats does not automatically include their Mind definitions. Export is a sequence of reads, not an atomic account snapshot. Limits: 200 items, 4096 files, 128 MiB logical/expanded/ZIP. Returning to Venice keeps selections and results; it cancels any pending export download. Reloading discards this workspace.</p>
              {!items.length && <p className="text-muted-foreground">Your export basket is empty. Add items from the content pages.</p>}
              {!!items.length && <Button size="sm" variant="ghost" className="w-fit" disabled={busy} onClick={() => setItems([])}>Clear export basket</Button>}
              {items.map(item => <div key={batchKey(item)} className="flex min-w-0 items-center gap-2" data-basket-item={batchKey(item)}>
                <span className="min-w-0 flex-1 truncate" title={item.title}>{item.kind} · {item.title}</span>
                <IconAction label={`Remove basket item: ${item.title}`} disabled={busy} onClick={() => remove(item)}><IconX aria-hidden="true" /></IconAction>
              </div>)}
            </section>
            <section hidden={view !== "import"} aria-label="Import from backup" className="grid min-w-0 gap-3">
              <p className="text-xs text-muted-foreground">Open and validate a backup read-only, then select and review items before explicitly confirming new copies. This list is separate from your export basket.</p>
              <Button variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}><IconFolderOpen aria-hidden="true" />Open batch archive</Button>
              {busy && !exporting && !importing && <p role="status">Verifying batch archive...</p>}
              <input ref={fileInput} type="file" accept=".zip" aria-label="Open batch ZIP" className="sr-only" tabIndex={-1} disabled={busy}
                onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void openArchive(file) }} />
              {archive && <section aria-label="Opened batch contents" className="grid min-w-0 gap-2">
                <h3 className="font-medium">Verified backup ({archive.manifest.items.length} items)</h3>
                <Button size="sm" variant="ghost" className="w-fit" disabled={busy} onClick={() => setArchive(undefined)}>Close opened batch</Button>
                <details className="min-w-0">
                  <summary className="min-h-11 cursor-pointer py-3">Take out original files</summary>
                  {archive.manifest.items.map(item => <div key={batchKey(item)} className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate" title={item.title}>{item.kind} · {item.title}</span>
                    <IconAction label={`Take out item: ${item.title}`} disabled={busy} onClick={() => {
                      try { downloadBytes(reconstructBatchItem(archive, item), item.filename, item.packaging === "json" ? "application/json" : "application/zip") }
                      catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
                    }}><IconDownload aria-hidden="true" /></IconAction>
                  </div>)}
                </details>
                {reloadPage && <BatchImportPanel archive={archive} busy={busy} onBusyChange={setBusy} onImportingChange={setImporting} reloadPage={reloadPage} />}
              </section>}
            </section>
          </div>
        </section>
    </div>
  </BatchContext.Provider>
}
