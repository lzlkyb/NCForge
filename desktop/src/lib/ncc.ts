import { invoke } from "./tauri";

/** 与 Rust `commands/ncc_cmds.rs` 的 `NccDecodeConfig` 一一对应。 */
export interface NccDecodeConfig {
  home: string;
  path: string;
  /** false = 没读到 miscellaneous.xml，下面的开关是默认值（全开）。 */
  found: boolean;
  gzip: boolean;
  aes: boolean;
  mark: boolean;
}

export const nccDecodeConfig = () => invoke<NccDecodeConfig>("ncc_decode_config");
