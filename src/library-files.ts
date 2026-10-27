import { safeMindPath } from "./mind-package-format"
import { MAX_LIBRARY_FILE } from "./library-format"

export interface LibraryFiles {
  read(path: string): Promise<Blob>
  containerExists(id: string): Promise<boolean>
  write(path: string, value: Blob): Promise<void>
  remove(id: string): Promise<void>
}

function assertContainer(id: string): void {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Unsafe generated Library container ID.")
}
function missing(error: unknown): boolean { return error instanceof DOMException && error.name === "NotFoundError" }

export function browserLibraryFiles(): LibraryFiles {
  const directory = async (path: string, create = false) => {
    let handle = await navigator.storage.getDirectory()
    for (const part of safeMindPath(path).split("/")) handle = await handle.getDirectoryHandle(part, { create })
    return handle
  }
  return {
    async read(path) {
      safeMindPath(path)
      const parts = path.split("/"), name = parts.pop()
      if (!name) throw new Error("Missing Library filename.")
      const parent = await directory(parts.join("/"))
      const file = await (await parent.getFileHandle(name)).getFile()
      if (!file.size || file.size > MAX_LIBRARY_FILE) throw new Error("Library original is empty or exceeds 100 MiB.")
      return file
    },
    async containerExists(id) {
      assertContainer(id)
      try { await directory(`media/${id}`); return true } catch (error) { if (!missing(error)) throw error }
      try {
        const thumbnails = await directory("thumbnails")
        for await (const name of thumbnails.keys()) if (name.startsWith(`${id}_`)) return true
      } catch (error) { if (!missing(error)) throw error }
      return false
    },
    async write(path, value) {
      if (!/^(?:media\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.[a-z0-9]+|thumbnails\/[a-f0-9-]{36}_[a-f0-9-]{36}_thumb500\.jpg)$/.test(path)) {
        throw new Error("Refusing to write outside a generated Library namespace.")
      }
      const parts = path.split("/"), name = parts.pop()
      if (!name) throw new Error("Missing Library filename.")
      const parent = await directory(parts.join("/"), true), handle = await parent.getFileHandle(name, { create: true })
      const stream = await handle.createWritable()
      try { await stream.write(value); await stream.close() } catch (error) { await stream.abort(); throw error }
    },
    async remove(id) {
      assertContainer(id)
      try { await (await directory("media")).removeEntry(id, { recursive: true }) } catch (error) { if (!missing(error)) throw error }
      try {
        const thumbnails = await directory("thumbnails")
        for await (const [name, entry] of thumbnails.entries()) {
          if (entry.kind === "file" && name.startsWith(`${id}_`)) await thumbnails.removeEntry(name)
        }
      } catch (error) { if (!missing(error)) throw error }
    },
  }
}
