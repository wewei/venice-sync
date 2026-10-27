import type { LibraryKind } from "./library-format"

export async function inspectLibraryMedia(blob: Blob, kind: LibraryKind): Promise<{ thumbnail?: Blob }> {
  const draw = (source: CanvasImageSource, width: number, height: number) => new Promise<Blob>((resolve, reject) => {
    if (!width || !height || width * height > 64 * 1024 * 1024) { reject(new Error("Unsupported Library image/video dimensions.")); return }
    const ratio = Math.min(1, 500 / Math.max(width, height)), canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio))
    const context = canvas.getContext("2d")
    if (!context) { reject(new Error("Canvas is unavailable for Library thumbnails.")); return }
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Library thumbnail encoding failed.")), "image/jpeg", 0.85)
  })
  if (kind === "image") {
    const bitmap = await createImageBitmap(blob)
    try { return { thumbnail: await draw(bitmap, bitmap.width, bitmap.height) } } finally { bitmap.close() }
  }
  const url = URL.createObjectURL(blob)
  const element = document.createElement(kind === "video" ? "video" : "audio")
  element.preload = "auto"
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("Library media decoding timed out.")) }, 15_000)
      const cleanup = () => { clearTimeout(timer); element.removeEventListener(event, loaded); element.removeEventListener("error", failed) }
      const loaded = () => { cleanup(); resolve() }
      const failed = () => { cleanup(); reject(new Error("The Library audio/video file could not be decoded.")) }
      const event = kind === "video" ? "loadeddata" : "loadedmetadata"
      element.addEventListener(event, loaded); element.addEventListener("error", failed); element.src = url; element.load()
    })
    return element instanceof HTMLVideoElement ? { thumbnail: await draw(element, element.videoWidth, element.videoHeight) } : {}
  } finally { element.removeAttribute("src"); element.load(); URL.revokeObjectURL(url) }
}
