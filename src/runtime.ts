export interface RuntimeInfo {
  mode: "userscript" | "preview"
  handler: string
  version: string
}

export function getRuntimeInfo(): RuntimeInfo {
  if (typeof GM_info === "undefined") {
    return {
      mode: "preview",
      handler: "Local preview (not userscript E2E)",
      version: "development",
    }
  }

  return {
    mode: "userscript",
    handler: GM_info.scriptHandler,
    version: GM_info.script.version,
  }
}
