import { isRecord } from "./conversation-format"

export function nativeVenicePage(): Window {
  if (location.origin !== "https://venice.ai") throw new Error("Native content transfer is available only on https://venice.ai.")
  return typeof unsafeWindow === "undefined" ? window : unsafeWindow
}

const modules = new Map<number, Promise<unknown>>()

export function loadNativeModule(moduleId: number): Promise<unknown> {
  const cached = modules.get(moduleId)
  if (cached) return cached
  const result = new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => fail(new Error("Venice's native content bridge timed out. Reload and retry.")), 5000)
    const fail = (error: unknown) => {
      if (settled) return
      settled = true; clearTimeout(timer); modules.delete(moduleId)
      reject(error instanceof Error ? error : new Error("Venice's native content bridge failed."))
    }
    try {
      const runtime: unknown = Reflect.get(nativeVenicePage(), "TURBOPACK")
      if (!isRecord(runtime) || typeof runtime.push !== "function") throw new Error("Unsupported Venice runtime.")
      const push = runtime.push.bind(runtime)
      const id = `venice-sync-module-${crypto.randomUUID()}`, chunk = `venice-sync/${id}.js`
      push([chunk, id, (context: unknown) => {
        try {
          if (!isRecord(context) || typeof context.r !== "function") throw new Error("Unsupported Venice module loader.")
          const value: unknown = context.r(moduleId)
          if (!settled) { settled = true; clearTimeout(timer); resolve(value) }
        } catch (error) { fail(error) }
      }])
      Promise.resolve(push([chunk, { otherChunks: [], runtimeModuleIds: [id] }])).catch(fail)
    } catch (error) { fail(error) }
  })
  modules.set(moduleId, result)
  // Synchronous module lookup can fail before the promise is placed in the cache.
  void result.catch(() => { if (modules.get(moduleId) === result) modules.delete(moduleId) })
  return result
}
