export function withExistingDatabase<T>(
  name: string,
  version: number,
  read: (database: IDBDatabase) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let database: IDBDatabase | undefined
    let settled = false
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      database?.close()
      if (error) reject(error)
      else if (value !== undefined) resolve(value)
      else reject(new Error("Database operation returned no result."))
    }
    const timer = setTimeout(() => {
      finish(new Error("Database read timed out. Refresh to retry."))
    }, 5000)
    try {
      const request = indexedDB.open(name, version)
      request.onupgradeneeded = () => {
        request.transaction?.abort()
        finish(new Error("Database changed while opening. Refresh to retry."))
      }
      request.onblocked = () => finish(new Error("Database open is blocked by another tab."))
      request.onerror = () => finish(request.error ?? new Error("Could not open database."))
      request.onsuccess = () => {
        database = request.result
        if (settled) { database.close(); return }
        database.onversionchange = () => {
          finish(new Error("Database version changed while reading. Refresh to retry."))
        }
        try {
          read(database).then((value) => finish(undefined, value), (error: unknown) => finish(error))
        } catch (error) {
          finish(error)
        }
      }
    } catch (error) {
      finish(error)
    }
  })
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Database request failed."))
  })
}

export function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      transaction.abort()
    }, 4000)
    transaction.oncomplete = () => { clearTimeout(timer); resolve() }
    transaction.onabort = () => {
      clearTimeout(timer)
      reject(transaction.error ?? new Error("Database transaction was aborted or timed out."))
    }
    transaction.onerror = () => {
      clearTimeout(timer)
      reject(transaction.error ?? new Error("Database transaction failed."))
    }
  })
}
