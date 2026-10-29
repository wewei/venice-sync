import { createContext } from "react"
import type { BatchSelection } from "./batch-format"

export interface BatchBasketState {
  items: BatchSelection[]
  busy: boolean
  add(items: BatchSelection[]): void
  remove(item: BatchSelection): void
}
export const BatchContext = createContext<BatchBasketState | undefined>(undefined)
