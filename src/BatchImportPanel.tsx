import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { batchKey, type BatchPackage } from "./batch-format"
import { importBatch, planBatchImport, unresolvedBatchDestinations, type BatchImportPlan, type BatchImportResult } from "./batch-import"

export function BatchImportPanel({ archive, busy, onBusyChange, onImportingChange, reloadPage }: {
  archive: BatchPackage; busy: boolean; onBusyChange: (busy: boolean) => void
  onImportingChange?: (busy: boolean) => void; reloadPage: () => void
}) {
  const [selected, setSelected] = useState<string[]>([]), [plan, setPlan] = useState<BatchImportPlan>()
  const [destinations, setDestinations] = useState<Record<string, string>>({})
  const [results, setResults] = useState<BatchImportResult[]>([])
  const [error, setError] = useState<string>(), [notice, setNotice] = useState<string>()
  const [running, setRunning] = useState(false), [needsReload, setNeedsReload] = useState(false)
  const abort = useRef<AbortController | undefined>(undefined), active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => { active.current = false; abort.current?.abort() }
  }, [])
  useEffect(() => {
    onImportingChange?.(running)
    return () => onImportingChange?.(false)
  }, [running, onImportingChange])
  const attempted = new Set(results.map(result => result.key))
  const changeSelection = (keys: string[]) => { setSelected(keys); setPlan(undefined); setError(undefined) }
  async function review() {
    onBusyChange(true); setError(undefined); setNotice(undefined)
    try {
      const prepared = await planBatchImport(archive, selected)
      if (active.current) { setPlan(prepared); setDestinations({}) }
    } catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (active.current) onBusyChange(false) }
  }
  async function confirm() {
    if (!plan) { setError("Review selected items first."); return }
    const controller = new AbortController(); abort.current = controller
    onBusyChange(true); setRunning(true); setError(undefined); setNotice(undefined)
    try {
      const outcome = await importBatch(plan, destinations, { signal: controller.signal, onResult: result => {
        if (active.current) setResults(current => [...current, result])
      } })
      if (!active.current) return
      const tried = new Set(outcome.results.map(result => result.key))
      setSelected(current => current.filter(key => !tried.has(key)))
      setPlan(undefined); setNeedsReload(current => current || outcome.needsReload)
      const failure = outcome.results.find(result => result.status === "failed")
      if (failure) setError(`Stopped at "${failure.title}": ${failure.error} Successful copies remain. Review the failure before retrying; cleanup may be incomplete.`)
      else setNotice(`${outcome.results.length} new copies imported${outcome.stopped ? "; stopped before the remaining items" : ""}. Review results, then refresh Venice if required.`)
    } catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally {
      if (active.current) { setRunning(false); onBusyChange(false) }
      abort.current = undefined
    }
  }
  return <section aria-label="Selected batch import" className="grid gap-3 border-t pt-3">
    <h3 className="font-medium">Import selected items as new copies</h3>
    <p className="text-xs text-muted-foreground">Select, review, then confirm. All formats/hashes are checked before writes. Imported Mind definitions are created before their selected local histories; other Mind histories require an explicit destination. Existing data is not overwritten.</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => changeSelection(archive.manifest.items.filter(item => !attempted.has(batchKey(item))).map(batchKey))}>Select all unattempted items</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => changeSelection([])}>Clear import selection</Button>
    </div>
    {archive.manifest.items.map(item => {
      const key = batchKey(item)
      return <label key={key} data-batch-import-key={key} className="flex min-w-0 items-center gap-2">
        <input type="checkbox" aria-label={`Import batch item: ${item.title}`} disabled={busy || attempted.has(key)} checked={selected.includes(key)}
          onChange={event => changeSelection(event.currentTarget.checked ? [...selected, key] : selected.filter(value => value !== key))} />
        <span className="min-w-0 truncate" title={item.title}>{item.kind} · {item.title}{attempted.has(key) ? " · Already attempted; see results" : ""}</span>
      </label>
    })}
    <Button size="sm" variant="outline" disabled={busy || !selected.length} onClick={() => void review()}>Review {selected.length} selected imports</Button>
    {plan && <div data-testid="batch-import-preview" className="grid gap-3 rounded-lg border p-3">
      <p>{plan.entries.length} items will be imported sequentially. This is not an all-or-nothing transaction. On failure, later items stop and successful copies remain. Cancellation stops after the current item; attempted items are disabled to prevent accidental duplication.</p>
      <p>Save drafts and finish generation first. Keep this page open. There is no automatic page reload; review results and use Refresh Venice once afterwards.</p>
      {plan.entries.map(entry => <div key={batchKey(entry.item)} className="grid gap-1">
        <span>{entry.item.kind} · {entry.item.title}</span>
        {entry.newMindKey && <span className="text-xs">Destination: the new copy of the selected Mind definition.</span>}
        {entry.content.kind === "mind-history" && !entry.newMindKey && <label>Destination Mind for {entry.item.title}
          <select aria-label={`Destination Mind: ${entry.item.title}`} data-batch-destination-key={batchKey(entry.item)} className="w-full min-w-0 rounded border bg-background p-2" disabled={busy}
            value={destinations[batchKey(entry.item)] ?? ""} onChange={event => setDestinations(current => ({ ...current, [batchKey(entry.item)]: event.currentTarget.value }))}>
            <option value="">Select an existing Mind</option>
            {plan.targets.map(target => <option key={`${target.kind}:${target.id}`} value={`${target.kind}:${target.id}`}>{target.name} ({target.kind})</option>)}
          </select>
        </label>}
      </div>)}
      <Button disabled={busy || unresolvedBatchDestinations(plan, destinations).length > 0} onClick={() => void confirm()}>Confirm selected batch import</Button>
      <Button variant="outline" disabled={busy} onClick={() => setPlan(undefined)}>Cancel batch import preview</Button>
    </div>}
    {running && <Button variant="outline" onClick={() => abort.current?.abort()}>Stop after current item</Button>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!!results.length && <div role="log" aria-label="Batch import results" className="grid gap-1">
      {results.map(result => <p key={result.key} data-batch-result-key={result.key} data-batch-result-status={result.status} data-batch-new-id={result.id}>{result.status === "success" ? "Imported" : "Failed"}: {result.kind} · {result.title}{result.id ? ` · New ID: ${result.id}` : ""}{result.error ? ` · ${result.error}` : ""}</p>)}
    </div>}
    {needsReload && <Button disabled={busy} onClick={() => {
      try { reloadPage() }
      catch (reason) { setError(`Items were already imported, but refresh failed: ${reason instanceof Error ? reason.message : String(reason)}. Reload manually; do not import them again.`) }
    }}>Refresh Venice after reviewing results</Button>}
  </section>
}
