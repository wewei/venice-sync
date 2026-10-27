import { createElement, useEffect, useState, type ReactElement, type SVGProps } from "react"
import { IconFolder, IconMasksTheater, IconMessage, IconSparkles } from "@tabler/icons-react"

export { IconFolder as VeniceLibraryIcon, IconMasksTheater as VeniceCharactersIcon, IconMessage as VeniceClassicIcon }

interface Shape { tag: string; attributes: Record<string, string>; children: Shape[] }
interface NativeIcon { viewBox: string; shapes: Shape[] }
const tags = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "g"])
const attributes = ["d", "x", "y", "x1", "x2", "y1", "y2", "width", "height", "rx", "ry", "r", "cx", "cy", "points", "transform"]

function readNativeIcon(selector: string): NativeIcon | undefined {
  const source = document.querySelector(selector)
  if (!source) return
  const copy = (element: Element, depth: number): Shape | undefined => {
    if (!tags.has(element.localName) || depth > 4) return
    return {
      tag: element.localName,
      attributes: Object.fromEntries(attributes.flatMap((name) => {
        const value = element.getAttribute(name)
        return value === null ? [] : [[name, value]]
      })),
      children: Array.from(element.children).flatMap((child) => { const shape = copy(child, depth + 1); return shape ? [shape] : [] }),
    }
  }
  const shapes = Array.from(source.children).flatMap((element) => { const shape = copy(element, 0); return shape ? [shape] : [] })
  return shapes.length ? { viewBox: source.getAttribute("viewBox") ?? "0 0 24 24", shapes } : undefined
}

function renderShape(shape: Shape, index: number): ReactElement {
  return createElement(shape.tag, { ...shape.attributes, key: index }, shape.children.map(renderShape))
}

type IconProps = SVGProps<SVGSVGElement> & { size?: number | string }

function NativeVeniceIcon({ kind, size = 24, ...props }: IconProps & { kind: "mind" | "agentic" }) {
  const selector = kind === "mind" ? 'a[href="/minds"] svg' : 'a[href="/chat/agent"] svg, a[href^="/chat/agent/"] svg'
  const [icon, setIcon] = useState(() => readNativeIcon(selector))
  useEffect(() => {
    if (icon) return
    let active = true
    const update = () => {
      if (!active) return
      const current = readNativeIcon(selector)
      if (!current) return
      observer.disconnect()
      setIcon(current)
    }
    // Reuse the site's own icon at runtime; do not vendor its custom artwork or copy event handlers.
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { childList: true, subtree: true })
    queueMicrotask(update)
    return () => { active = false; observer.disconnect() }
  }, [icon, selector])
  if (!icon) return <IconSparkles size={size} {...props} data-venice-icon={`${kind}-fallback`} />
  return <svg width={size} height={size} viewBox={icon.viewBox} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props} data-venice-icon={`${kind}-native`}>
    {icon.shapes.map(renderShape)}
  </svg>
}

export function VeniceMindIcon(props: IconProps) { return <NativeVeniceIcon kind="mind" {...props} /> }
export function VeniceAgenticIcon(props: IconProps) { return <NativeVeniceIcon kind="agentic" {...props} /> }
