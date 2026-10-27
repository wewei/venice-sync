import styles from "./styles.css?inline"
import { mountApp } from "./mount"
import { getRuntimeInfo } from "./runtime"

const mounted = mountApp(getRuntimeInfo(), styles)

if (import.meta.hot && mounted.status === "mounted") {
  import.meta.hot.dispose(() => mounted.unmount())
}
