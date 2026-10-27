import { safeMindPath, MAX_MIND_FILE_BYTES, MAX_MIND_PACKAGE_BYTES } from "./mind-package-format"

export interface MindFiles {
  readTree(path: string): Promise<Record<string, Uint8Array>>
  exists(path: string): Promise<boolean>
  writeTree(path: string, files: Record<string, Uint8Array>): Promise<void>
  removeTree(path: string): Promise<void>
}

function missing(error: unknown): boolean { return error instanceof DOMException && error.name === "NotFoundError" }

export function browserMindFiles(): MindFiles {
  const root = () => navigator.storage.getDirectory()
  const directory = async (path: string, create = false) => {
    let handle = await root()
    safeMindPath(path)
    for (const part of path.split("/")) handle = await handle.getDirectoryHandle(part, { create })
    return handle
  }
  return {
    async exists(path) {
      try { await directory(path); return true } catch (error) { if (missing(error)) return false; throw error }
    },
    async readTree(path) {
      let handle: FileSystemDirectoryHandle
      try { handle = await directory(path) } catch (error) { if (missing(error)) return {}; throw error }
      const result: Record<string, Uint8Array> = {}
      let total = 0
      async function walk(current: FileSystemDirectoryHandle, prefix: string) {
        for await (const [name, entry] of current.entries()) {
          const relative = safeMindPath(`${prefix}${name}`)
          if (entry.kind === "directory") await walk(entry, `${relative}/`)
          else {
            const file = await entry.getFile()
            total += file.size
            if (file.size > MAX_MIND_FILE_BYTES || total > MAX_MIND_PACKAGE_BYTES || Object.keys(result).length >= 2048) {
              throw new Error("Mind files exceed package limits (25 MiB per file, 128 MiB total, 2048 files).")
            }
            result[relative] = new Uint8Array(await file.arrayBuffer())
          }
        }
      }
      await walk(handle, "")
      return result
    },
    async writeTree(path, files) {
      const base = await directory(path, true)
      for (const [path, bytes] of Object.entries(files)) {
        const parts = safeMindPath(path).split("/")
        const name = parts.pop()
        if (!name) throw new Error("Missing file name.")
        let parent = base
        for (const part of parts) parent = await parent.getDirectoryHandle(part, { create: true })
        const file = await parent.getFileHandle(name, { create: true })
        const writable = await file.createWritable()
        try { await writable.write(Uint8Array.from(bytes).buffer); await writable.close() }
        catch (error) { await writable.abort(); throw error }
      }
    },
    async removeTree(path) {
      if (!/^(?:minds\/[a-f0-9-]{36}|media\/mind-(?:maker|preview)-conv:[a-f0-9-]{36})$/.test(path)) {
        throw new Error("Refusing to remove a non-import Mind directory.")
      }
      const parts = path.split("/"), name = parts.pop()
      if (!name) throw new Error("Missing import directory.")
      let parent: FileSystemDirectoryHandle
      try { parent = await directory(parts.join("/")) } catch (error) { if (missing(error)) return; throw error }
      try { await parent.removeEntry(name, { recursive: true }) } catch (error) { if (!missing(error)) throw error }
    },
  }
}
