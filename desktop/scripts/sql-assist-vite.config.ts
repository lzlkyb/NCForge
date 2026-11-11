import base from "../vite.config";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Browser acceptance writes screenshots outside src; HMR would otherwise reload mid-assertion.
export default { ...base, server: { ...base.server, hmr: false,
  // An isolated review checkout can share dependencies through a Windows junction.
  fs: { allow: [fileURLToPath(new URL("..", import.meta.url)), realpathSync(fileURLToPath(new URL("../node_modules", import.meta.url)))] },
  watch: { ignored: ["**/src-tauri/**", "**/scripts/**", "**/docs/**"] } } };
