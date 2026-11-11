import { invoke } from "./tauri";
import { trackOperation } from "./operations";
import { downloadText } from "./resultExport";

/**
 * 配置导入导出（M8 团队化）：把本机配置打包成 JSON 给同事，或从同事那里导入。
 *
 * 口径（与 Rust `config_io` 模块一一对应，两边同步改）：
 * - **口令不随配置走**：数据库 / SVN 口令只存本机（DPAPI），导出物里没有这些字段，
 *   导入后需要在新机器上重新输入一次。这不是缺陷，是安全设计。
 * - **缺字段不动本机值**：老版本 / 手改文件少了字段时，本机对应设置保持原样。
 * - **路径字段要改写**：导出的是导出机器的绝对路径，换机器后大概率不存在，
 *   导入预览界面允许逐条改（`PATH_FIELDS`）。
 */

/** 导出信封（Rust `config_io::ConfigExport` 的镜像）。 */
export interface ConfigExport {
  app: string;
  schema: number;
  from_version: string;
  config: ExportableConfig;
}

/** 可导出字段白名单（Rust `config_io::ExportableConfig` 的镜像）。 */
export interface ExportableConfig {
  workspace_root?: string | null;
  nc_home?: string | null;
  server_heap_mb?: number | null;
  client_heap_mb?: number | null;
  svn_user?: string | null;
  patch_out_dir?: string | null;
  patch_out_root?: string | null;
  db_url?: string | null;
  db_user?: string | null;
  db_active?: string | null;
  db_conns_init?: boolean | null;
  db_conns?: DbConnExport[] | null;
  lang_enabled?: boolean | null;
  lang_auto_start?: boolean | null;
  lang_xmx_mb?: number | null;
  /** 工程关联覆盖表：全量替换语义，导入后本机列表被换成它。 */
  linked_overrides?: LinkedOverrideExport[] | null;
}

/** 导出物里的连接（**没有口令字段**——Rust 导出时就抹掉了）。 */
export interface DbConnExport {
  id: string;
  name: string;
  source: string;
  url?: string;
  prop_ds?: string | null;
  note?: string;
}

/** 导出物里的工程关联覆盖（Rust `config::LinkedOverrideConfig` 的镜像）。 */
export interface LinkedOverrideExport {
  action: string;
  target: string;
  dir?: string | null;
}

/** 本机支持的最高格式版本（Rust `config_io::EXPORT_SCHEMA`，两边同步改）。 */
export const EXPORT_SCHEMA = 2;

/** 路径类字段：换机器后必须允许改写的项。 */
export const PATH_FIELDS: { key: PathFieldKey; label: string; hint: string }[] = [
  { key: "workspace_root", label: "工作区", hint: "工程根目录（如 newar）" },
  { key: "nc_home", label: "NC home", hint: "NC 安装目录（含 ufjdk / modules）" },
  { key: "patch_out_dir", label: "补丁输出目录", hint: "「待上线补丁」位置" },
  { key: "patch_out_root", label: "编译产物根", hint: "Eclipse 编译输出目录" },
];

export type PathFieldKey =
  | "workspace_root"
  | "nc_home"
  | "patch_out_dir"
  | "patch_out_root";

export type ParseResult =
  | { ok: true; data: ConfigExport }
  | { ok: false; error: string };

/**
 * 前端预解析导出文件。**权威校验在 Rust**（`parse_import` 会再查一遍，
 * 包括丢弃文件里硬塞的口令字段）；这里只为了在预览前给出友好错误，
 * 别把「缺胳膊少腿的文件」拖到确认那一步才发现。
 */
export function parseExportFile(text: string): ParseResult {
  let tree: unknown;
  try {
    // 容忍 BOM：Windows 记事本把 .json 另存为 UTF-8 会在头部加 \uFEFF，JSON.parse 直接拒
    tree = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    return { ok: false, error: `不是合法的 JSON 文件：${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof tree !== "object" || tree === null || Array.isArray(tree)) {
    return { ok: false, error: "文件内容不是一个配置对象（顶层不是 JSON 对象）" };
  }
  const t = tree as Record<string, unknown>;
  if (t.app !== undefined && t.app !== "ncforge") {
    return { ok: false, error: `这不是 NCForge 的配置文件（app 字段是 ${JSON.stringify(t.app)}）` };
  }
  if (typeof t.schema === "number" && t.schema > EXPORT_SCHEMA) {
    return {
      ok: false,
      error: `文件由更新的工作台生成（格式版本 ${t.schema}，本机支持到 ${EXPORT_SCHEMA}），请先升级工作台再导入`,
    };
  }
  const cfg = (t.config ?? {}) as ExportableConfig;
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) return { ok: false, error: "config 必须是配置对象" };
  for (const field of PATH_FIELDS) {
    if (cfg[field.key] != null && typeof cfg[field.key] !== "string") return { ok: false, error: `${field.label}必须是路径文本` };
  }
  for (const key of ["svn_user", "db_url", "db_user", "db_active"] as const) {
    if (cfg[key] != null && typeof cfg[key] !== "string") return { ok: false, error: `${key} 必须是文本` };
  }
  for (const key of ["server_heap_mb", "lang_xmx_mb", "client_heap_mb"] as const) {
    if (cfg[key] != null && (!Number.isInteger(cfg[key]) || Number(cfg[key]) <= 0)) return { ok: false, error: `${key} 必须是正整数` };
  }
  for (const key of ["lang_enabled", "lang_auto_start", "db_conns_init"] as const) {
    if (cfg[key] != null && typeof cfg[key] !== "boolean") return { ok: false, error: `${key} 必须是开关值` };
  }
  if (cfg.db_conns != null && (!Array.isArray(cfg.db_conns) || cfg.db_conns.some(conn => !conn || typeof conn !== "object" || typeof conn.id !== "string" || typeof conn.name !== "string"))) {
    return { ok: false, error: "数据库连接列表格式不正确" };
  }
  if (cfg.linked_overrides != null && (!Array.isArray(cfg.linked_overrides) || cfg.linked_overrides.some(o => !o || typeof o !== "object" || typeof o.action !== "string" || typeof o.target !== "string"))) {
    return { ok: false, error: "工程关联覆盖列表格式不正确" };
  }
  return {
    ok: true,
    data: {
      app: typeof t.app === "string" ? t.app : "",
      schema: typeof t.schema === "number" ? t.schema : 0,
      from_version: typeof t.from_version === "string" ? t.from_version : "",
      config: cfg,
    },
  };
}

/** 导入预览模型：界面照着渲染，改路径后经 `withPathEdits` 产出新导出对象。 */
export interface ImportPlan {
  fromVersion: string;
  /** 有值的路径项（null / 缺键的不出现）。 */
  pathItems: { key: PathFieldKey; label: string; hint: string; value: string }[];
  /** 数据库连接数（含 prop 来源——口令每次现解的那种）。 */
  connCount: number;
  connNames: string[];
  hasHeap: boolean;
  hasClientHeap: boolean;
  hasSvnUser: boolean;
  hasLang: boolean;
  /** 工程关联覆盖条数（全量替换语义，导入即覆盖本机列表）。 */
  overrideCount: number;
  /** 覆盖里的工程名 / 路径（`add` 动作可能只有 dir，这时显示 dir）。 */
  overrideTargets: string[];
  /** 恒定 true：口令永远不进导出物。界面据此显示固定提示。 */
  secretsExcluded: true;
}

export function buildImportPlan(data: ConfigExport): ImportPlan {
  const cfg = data.config;
  const pathItems = PATH_FIELDS.map((f) => ({ ...f, value: cfg[f.key] ?? "" })).filter(
    (f) => f.value.trim() !== "",
  );
  const conns = cfg.db_conns ?? [];
  const overrides = cfg.linked_overrides ?? [];
  return {
    fromVersion: data.from_version,
    pathItems,
    connCount: conns.length,
    connNames: conns.map((c) => c.name || c.id),
    hasHeap: cfg.server_heap_mb != null,
    hasClientHeap: cfg.client_heap_mb != null,
    hasSvnUser: cfg.svn_user != null,
    hasLang: cfg.lang_enabled != null || cfg.lang_auto_start != null || cfg.lang_xmx_mb != null,
    overrideCount: overrides.length,
    overrideTargets: overrides.map((o) => o.target || o.dir || o.action),
    secretsExcluded: true,
  };
}

/** 把预览界面里改过的路径写回导出对象（只动有编辑的键）。 */
export function withPathEdits(data: ConfigExport, edits: Partial<Record<PathFieldKey, string>>): ConfigExport {
  const cfg = { ...data.config };
  for (const [k, v] of Object.entries(edits)) {
    if (v !== undefined) cfg[k as PathFieldKey] = v.trim() === "" ? null : v.trim();
  }
  return { ...data, config: cfg };
}

/** 导出文件名：`ncforge-config-20261031-1005.json`。 */
export function exportFileName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `ncforge-config-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

/** 调 Rust 导出命令拿 JSON 文本，再走既有的 Blob 下载通道落盘。 */
export const exportConfig = () => invoke<string>("export_config");

/** 把（可能改过路径的）导出对象序列化后交给 Rust 导入。 */
export const importConfig = (data: ConfigExport) =>
  trackOperation({ key: "settings.import", label: "导入配置", page: "settings", phase: "校验并写入配置" }, () => invoke<unknown>("import_config", { json: JSON.stringify(data) }));

/** 导出并下载。复用 `downloadText`（SQL 导出同款通道，webview 内 Blob 下载）。 */
export function downloadConfigExport(): Promise<string> {
  return trackOperation({ key: "settings.export", label: "导出配置", page: "settings" }, async () => {
  const json = await exportConfig();
  // 第 4 参 false = 不带 BOM：JSON 头部多一个不可见字符，导入侧 JSON.parse 会直接失败
  downloadText(exportFileName(new Date()), json, "application/json", false);
  return json;
  });
}
