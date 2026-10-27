import { afterEach, describe, expect, it, vi } from "vitest"
import { getRuntimeInfo } from "./runtime"

afterEach(() => vi.unstubAllGlobals())

describe("runtime identity", () => {
  it("labels a browser-only preview honestly", () => {
    vi.stubGlobal("GM_info", undefined)
    expect(getRuntimeInfo().mode).toBe("preview")
    expect(getRuntimeInfo().handler).toContain("not userscript E2E")
  })

  it("uses the actual userscript manager metadata", () => {
    vi.stubGlobal("GM_info", {
      scriptHandler: "Tampermonkey",
      script: { version: "0.1.0" },
    })
    expect(getRuntimeInfo()).toEqual({
      mode: "userscript",
      handler: "Tampermonkey",
      version: "0.1.0",
    })
  })
})
