import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { readStorageOverview, type StorageOverview as Overview } from "./storage"

export function StorageOverview() {
  const [result, setResult] = useState<Overview>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let active = true
    readStorageOverview().then(
      (data) => {
        if (!active) return
        setResult(data)
        setLoading(false)
      },
      (reason: unknown) => {
        if (!active) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
      },
    )
    return () => { active = false }
  }, [revision])

  return (
    <section aria-label="Local storage overview" aria-busy={loading} className="grid min-w-0 gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">Local storage overview</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => {
            setLoading(true)
            setResult(undefined)
            setError(undefined)
            setRevision((value) => value + 1)
          }}
        >
          Refresh storage
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Read-only metadata. Stored values, chat content, and tokens are not displayed or sent anywhere.
      </p>
      {loading && <p role="status">Reading local storage...</p>}
      {error && <p role="alert">{error}</p>}
      {result && (
        <div data-testid="storage-result" data-read-at={result.readAt} className="grid min-w-0 gap-3 text-xs">
          <p className="break-all">
            Origin: {result.origin}<br />
            Read at: {result.readAt}
          </p>
          <section aria-label="localStorage" className="grid gap-2">
            <h3 className="font-medium">localStorage</h3>
            {result.localStorage.status === "error" ? (
              <p role="alert">localStorage: {result.localStorage.message}</p>
            ) : (
              <>
                <p data-testid="local-storage-summary">
                  {result.localStorage.data.entries.length} keys; approximately {result.localStorage.data.bytes} bytes (UTF-16 keys + values).
                </p>
                {result.localStorage.data.entries.length === 0 ? <p>No localStorage entries.</p> : (
                  <ul className="grid gap-1">
                    {result.localStorage.data.entries.map((entry) => (
                      <li key={entry.key} className="break-all">{entry.key} - {entry.bytes} bytes</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
          <section aria-label="IndexedDB" className="grid gap-2">
            <h3 className="font-medium">IndexedDB</h3>
            {result.indexedDB.status === "error" ? (
              <p role="alert">IndexedDB: {result.indexedDB.message}</p>
            ) : (
              <>
                <p data-testid="indexeddb-summary">{result.indexedDB.data.length} databases</p>
                {result.indexedDB.data.length === 0 && <p>No IndexedDB databases.</p>}
                {result.indexedDB.data.map((database) => (
                  <div key={database.name} className="grid gap-1">
                    <h4 className="break-all font-medium">{database.name} (v{database.version})</h4>
                    {database.stores.status === "error" ? (
                      <p role="alert">{database.name}: {database.stores.message}</p>
                    ) : database.stores.data.length === 0 ? <p>No object stores.</p> : (
                      <ul className="grid gap-1">
                        {database.stores.data.map((store) => (
                          <li key={store.name} className="break-all">{store.name} - {store.records} records</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </>
            )}
          </section>
        </div>
      )}
    </section>
  )
}
