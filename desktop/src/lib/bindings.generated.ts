/**
 * ⚠️ 本文件由 `scripts/gen-bindings.mjs` 从 Rust 源码生成，**不要手改**。
 *
 * 来源：`src-tauri/src/**` 里带 `// @ts-mirror` 标记的结构体。改了 Rust 字段就重跑：
 *   npm run bindings:generate
 *
 * 与手写类型的相等性由 `src/lib/bindings.check.ts` 在 tsc 阶段钉住——
 * 那条断言就是「改一个 Rust 字段，`tsc` 当场红」的落点。
 */
/** src-tauri/src/commands/system.rs:61 · request */
export interface ConfigPatch {
  autostart_enabled?: boolean;
  deploy_on_start?: boolean;
  auto_compile?: boolean;
  auto_compile_incremental?: boolean;
  auto_compile_external?: boolean;
  prewarm_index?: boolean;
  persistent_worker?: boolean;
  build_parallel?: number;
  hotswap_enabled?: boolean;
  hotswap_auto?: boolean;
}

/** src-tauri/src/config.rs:19 · response */
export interface AppConfig {
  autostart_enabled: boolean;
  workspace_root: string | null;
  nc_home: string | null;
  server_heap_mb: number | null;
  client_heap_mb: number | null;
  hotwebs: string[] | null;
  svn_user: string | null;
  svn_password_dpapi: string | null;
  patch_out_dir: string | null;
  patch_out_root: string | null;
  db_url: string | null;
  db_user: string | null;
  db_password_dpapi: string | null;
  db_conns: DbConnConfig[];
  db_active: string | null;
  db_conns_init: boolean;
  lang_enabled: boolean;
  lang_auto_start: boolean;
  lang_xmx_mb: number | null;
  deploy_on_start: boolean;
  hotswap_enabled: boolean;
  hotswap_auto: boolean;
  auto_compile: boolean;
  auto_compile_incremental: boolean;
  auto_compile_external: boolean;
  prewarm_index: boolean;
  persistent_worker: boolean;
  build_parallel: number;
  linked_overrides: LinkedOverrideConfig[];
}

/** src-tauri/src/config.rs:168 · response */
export interface LinkedOverrideConfig {
  action: string;
  target: string;
  dir: string | null;
}

/** src-tauri/src/config.rs:192 · response */
export interface DbConnConfig {
  id: string;
  name: string;
  env: string;
  source: string;
  url: string;
  user: string;
  propDs: string | null;
  passwordDpapi: string | null;
  autoCommit: boolean;
  engine: string;
  note: string;
  defaultSchema: string;
  noStmtCache: boolean;
  group: string;
  color: string;
  keepAliveSec: number;
  initSql: string;
}
