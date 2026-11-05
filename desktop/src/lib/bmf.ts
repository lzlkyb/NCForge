import { invoke } from "./tauri";
import type { HistoryResult } from "./svnHistory";

/** 元数据（BMF）前端契约。字段名与 Rust 侧 `#[serde(rename_all = "camelCase")]` 对齐。 */

export interface BmfEntry {
  path: string;
  module: string;
  origin: string;
  name: string;
  displayName: string;
  namespace: string;
  version: number;
  entityCount: number;
  attrCount: number;
  enumCount: number;
  size: number;
  mtimeMs: number;
  error: string | null;
}

export interface BmfIndex {
  entries: BmfEntry[];
  roots: string[];
  warnings: string[];
  elapsedMs: number;
  cached: number;
}

export interface BmfAttr {
  id: string;
  name: string;
  field: string;
  displayName: string;
  typeName: string;
  typeDisplayName: string;
  dataType: string;
  style: string;
  dbType: string;
  fieldType: string;
  length: number | null;
  precision: number | null;
  isKey: boolean;
  nullable: boolean;
  defaultValue: string;
  refModel: string;
  sequence: number;
  refTarget: string;
  raw: string;
}

export interface BmfEntity {
  id: string;
  name: string;
  displayName: string;
  fullClass: string;
  table: string;
  accessor: string;
  isPrimary: boolean;
  keyAttrId: string;
  attrs: BmfAttr[];
  raw: string;
}

export interface BmfEnumItem {
  id: string;
  value: string;
  display: string;
  hidden: boolean;
}

export interface BmfEnum {
  id: string;
  name: string;
  displayName: string;
  typeName: string;
  dataType: string;
  fullClass: string;
  items: BmfEnumItem[];
  raw: string;
}

export interface BmfRelation {
  id: string;
  kind: string;
  name: string;
  source: string;
  target: string;
  srcAttrId: string;
  targetAttrId: string;
}

export interface BmfComponent {
  id: string;
  name: string;
  displayName: string;
  namespace: string;
  ownModule: string;
  genCodeStyle: string;
  version: number;
  mainEntity: string;
  industry: string;
  metaType: string;
}

export interface BmfDetail {
  path: string;
  encoding: string;
  eol: string;
  bom: boolean;
  size: number;
  sha256: string;
  mtimeMs: number;
  component: BmfComponent;
  entities: BmfEntity[];
  enums: BmfEnum[];
  relations: BmfRelation[];
  unknownTags: string[];
}

export interface BmfIssue {
  id: string;
  code: string;
  severity: "error" | "warn" | "info";
  title: string;
  detail: string;
  why: string;
  action: string;
  file: string;
  line: number | null;
  component: string;
  entity: string;
  attr: string;
}

export interface BmfGeneratedFile {
  kind: string;
  name: string;
  pathHint: string;
  encoding: string;
  eol: string;
  text: string;
}

export interface BmfRegistryItem {
  area: string;
  hint: string;
  existing: string;
  suggested: string;
  note: string;
}

export interface BmfGeneration {
  ddl: string;
  files: BmfGeneratedFile[];
  registry: BmfRegistryItem[];
  upm: string;
  warnings: string[];
}

// ── 生成中心（bmf_generate_plan / bmf_gen_diff / bmf_gen_apply）──

export type BmfCodeStyle = "traditional" | "standard" | "custom";
export type BmfSqlDialect =
  | "db2"
  | "gbase"
  | "informix"
  | "oracle"
  | "oscar"
  | "postgresql"
  | "sqlserver"
  | "sybase";

export interface BmfGenOptions {
  generateAggVo: boolean;
  generateEnumVo: boolean;
  generateInterfaces: boolean;
  generateSelVo: boolean;
  generateTest: boolean;
  generateDdl: boolean;
  withForeignKeys: boolean;
  onlyExtensionTables: boolean;
  ufBooleanToBoolean: boolean;
  localization: boolean;
}

export interface BmfGenProfile {
  style: BmfCodeStyle;
  dialect: BmfSqlDialect;
  basePackage: string;
  publicSrcRoot: string;
  clientSrcRoot: string;
  testSrcRoot: string;
  options: BmfGenOptions;
}

export interface BmfArtifact {
  id: string;
  family: "java" | "db" | "bill" | "format" | "meta";
  kind: string;
  name: string;
  pathHint: string;
  encoding: string;
  eol: string;
  text: string;
  sha256: string;
  sourceRefs: string[];
  dependsOn: string[];
}

export interface BmfTimings {
  parseMs: number;
  validateMs: number;
  graphMs: number;
  renderMs: number;
  diffMs: number;
  writeMs: number;
  totalMs: number;
}

export interface BmfGenPlan {
  artifacts: BmfArtifact[];
  warnings: string[];
  timings: BmfTimings;
  inputSha256: string;
  profileSha256: string;
  profile: BmfGenProfile;
}

export type BmfArtifactStatusKind =
  | "new"
  | "unchanged"
  | "outdated"
  | "modified"
  | "conflict"
  | "orphan";

export interface BmfArtifactStatus {
  id: string;
  path: string;
  family: string;
  status: BmfArtifactStatusKind;
  detail: string;
}

export interface BmfGenDiff {
  items: BmfArtifactStatus[];
  manifest: string | null;
  timings: BmfTimings;
}

export interface BmfGenApply {
  written: number;
  skipped: number;
  items: BmfExportItem[];
  manifest: string;
  timings: BmfTimings;
}

export type BmfSkeleton = "treeCard" | "singleHead" | "singleBody" | "headBody" | "free";

export interface BmfScaffoldSpec {
  code: string;
  name: string;
  module: string;
  skeleton: BmfSkeleton;
  defs?: number | null;
  namespace?: string | null;
}

export interface BmfFieldPreview {
  entity: string;
  name: string;
  displayName: string;
  typeName: string;
  dbType: string;
  length: number | null;
  nullable: boolean;
  isKey: boolean;
}

export interface BmfEntityPreview {
  name: string;
  displayName: string;
  table: string;
  fullClass: string;
  primary: boolean;
  attrCount: number;
}

export interface BmfScaffold {
  text: string;
  pathHint: string;
  component: string;
  namespace: string;
  module: string;
  skeleton: string;
  entities: BmfEntityPreview[];
  fields: BmfFieldPreview[];
  tables: string[];
  voFiles: string[];
  defs: number;
}

export interface BmfWriteResult {
  path: string;
  backup: string | null;
  shaBefore: string;
  shaAfter: string;
  diff: string;
  changed: boolean;
}

export interface BmfNewAttr {
  name: string;
  displayName?: string;
  style?: string;
  typeName?: string;
  dataType?: string;
  dbType?: string;
  length?: number | null;
  nullable?: boolean;
  defaultValue?: string;
  isKey?: boolean;
  id?: string;
}

export type BmfEditOp =
  | { op: "setAttr"; id: string; name: string; value: string }
  | { op: "setEntityKey"; entity: string; attrId: string }
  | {
      op: "addAttribute";
      entity: string;
      name: string;
      displayName: string;
      style?: string;
      typeName?: string;
      dataType?: string;
      dbType?: string;
      length?: number | null;
      nullable?: boolean;
      defaultValue?: string;
      isKey?: boolean;
      id?: string;
    }
  | { op: "addEnumItem"; enumId: string; value: string; display: string; id?: string }
  | { op: "deleteNode"; id: string }
  | {
      op: "addEntity";
      name: string;
      displayName: string;
      table: string;
      fullClass: string;
      accessor?: string;
      isPrimary?: boolean;
      id?: string;
      /** 随实体一次写入的字段（复制实体用）。 */
      attrs?: BmfNewAttr[];
    }
  | { op: "addEnum"; name: string; displayName: string; typeName?: string; dataType?: string; id?: string }
  | {
      op: "addRelation";
      kind: RelationshipKind;
      name: string;
      source: string;
      target: string;
      srcAttrId?: string;
      targetAttrId?: string;
      id?: string;
    };

/** BMF 连接关系类型（与 UAP MDP 的 connectlist 一致）。 */
export const RELATION_KINDS = ["AggregationRelation", "Reference", "busiitfconnection"] as const;
export type RelationshipKind = (typeof RELATION_KINDS)[number];

/** 落盘结果里的单条文件：status = written | replaced | skipped。 */
export interface BmfExportItem {
  relPath: string;
  kind: string;
  status: "written" | "replaced" | "skipped";
  detail: string;
}

export interface BmfExportResult {
  items: BmfExportItem[];
  written: number;
  skipped: number;
  targetDir: string;
}

/** 跨工程引用命中：谁在用本组件的实体 / 枚举。 */
export interface BmfRefHit {
  path: string;
  component: string;
  entity: string;
  attr: string;
  field: string;
  value: string;
}

export interface BmfRefScan {
  hits: BmfRefHit[];
  scanned: number;
  skipped: number;
  truncated: boolean;
}

export interface BmfPublishCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "block";
  detail: string;
  hint: string;
}

export interface BmfPublishProbe {
  ncHome: string | null;
  component: string;
  module: string;
  checks: BmfPublishCheck[];
  blockers: number;
  warnings: number;
  ready: boolean;
  manual: string;
}

/** 历史修订 / 导入正文解码后的结果；`empty` = 该修订里没有这个文件。 */
export interface BmfRevisionText {
  revision: number;
  sourcePath: string;
  text: string;
  encoding: string;
  empty: boolean;
}

/** 自有 Excel 模板的逐行导入状态。`same` 不产生任何写操作。 */
export interface BmfImportChange {
  field: string;
  before: string;
  after: string;
}

export interface BmfImportRow {
  row: number;
  entity: string;
  attrName: string;
  status: "add" | "update" | "same" | "error";
  changes: BmfImportChange[];
  message: string;
}

export interface BmfImportPreview {
  file: string;
  sheet: string;
  /** 预览所基于的文件 SHA；写入时作为冲突校验的期望值。 */
  sha256: string;
  rows: BmfImportRow[];
  ops: BmfEditOp[];
  add: number;
  update: number;
  same: number;
  errors: number;
}

/** NC 安装目录里的同名组件副本（F3）。 */
export interface BmfNcCandidate {
  path: string;
  module: string;
  size: number;
  mtimeMs: number;
}

export interface BmfNcCompare {
  ncHome: string;
  component: string;
  workspaceModule: string | null;
  candidates: BmfNcCandidate[];
  selected: string | null;
  detail: BmfDetail | null;
}

/** M6 发布编排：官方工具探测项。unknown = 无法从 NC home 判断。 */
export interface BmfReleaseTool {
  id: string;
  label: string;
  status: "found" | "missing" | "unknown";
  path: string | null;
  note: string;
}

export interface BmfReleaseStep {
  id: string;
  title: string;
  mode: "auto" | "manual";
  status: "ready" | "blocked" | "pending";
  detail: string;
  hint: string;
}

export interface BmfReleasePlan {
  ncHome: string | null;
  component: string;
  module: string;
  tools: BmfReleaseTool[];
  steps: BmfReleaseStep[];
  blockers: number;
  warnings: number;
  ready: boolean;
  /** 骨架阶段恒为 false：官方入口确认前不提供自动发布。 */
  autoPublish: boolean;
  installCopy: string | null;
  workspaceSha256: string | null;
  installSha256: string | null;
  evidenceTemplate: string;
}

export interface BmfReleaseEvidenceSaved {
  path: string;
  content: string;
}

export const bmfIndexScan = (force = false) => invoke<BmfIndex>("bmf_index_scan", { force });
export const bmfDetail = (path: string) => invoke<BmfDetail>("bmf_doc_detail", { path });
export const bmfValidate = (path: string) => invoke<BmfIssue[]>("bmf_validate", { path });
export const bmfGenerate = (path: string, entities?: string[]) =>
  invoke<BmfGeneration>("bmf_generate", { path, entities: entities ?? null });
/** 生成中心：一次解析出全部产物（不落盘）。`profile` 为空时按 BMF 的代码风格推导。 */
export const bmfGeneratePlan = (
  path: string,
  profile?: BmfGenProfile | null,
  entities?: string[],
) =>
  invoke<BmfGenPlan>("bmf_generate_plan", {
    path,
    profile: profile ?? null,
    entities: entities ?? null,
  });
/** 漂移对比：计划 vs 上次清单 vs 磁盘。`root` 为空只看清单。 */
export const bmfGenDiff = (
  path: string,
  profile: BmfGenProfile | null,
  entities: string[] | undefined,
  root: string | null,
) =>
  invoke<BmfGenDiff>("bmf_gen_diff", {
    path,
    profile,
    entities: entities ?? null,
    root,
  });
/** 落盘选中产物；`force` 才覆盖「生成后被手改」的文件（覆盖前备份）。 */
export const bmfGenApply = (
  path: string,
  profile: BmfGenProfile | null,
  entities: string[] | undefined,
  root: string,
  selected: string[],
  force = false,
) =>
  invoke<BmfGenApply>("bmf_gen_apply", {
    path,
    profile,
    entities: entities ?? null,
    root,
    selected,
    force,
  });
export const bmfScaffoldPreview = (spec: BmfScaffoldSpec) =>
  invoke<BmfScaffold>("bmf_scaffold_preview", { spec });
/** 生成物落盘：只写相对路径；已有文件默认跳过，`overwrite` 时先备份再重写。 */
export const bmfGenExport = (
  path: string,
  targetDir: string,
  entities?: string[],
  overwrite = false,
) =>
  invoke<BmfExportResult>("bmf_gen_export", {
    path,
    targetDir,
    entities: entities ?? null,
    overwrite,
  });
export const bmfScaffoldWrite = (spec: BmfScaffoldSpec, path: string) =>
  invoke<string>("bmf_scaffold_write", { spec, path });
export const bmfEditPreview = (path: string, ops: BmfEditOp[]) =>
  invoke<string>("bmf_edit_preview", { path, ops });
/** `expectedSha` = 打开时 detail.sha256；外部改过文件会拒绝保存。 */
export const bmfEditSave = (path: string, ops: BmfEditOp[], expectedSha: string | null = null) =>
  invoke<BmfWriteResult>("bmf_edit_save", { path, ops, expectedSha });
/** 跨工程引用扫描（F1）：按类全名找 typeName / refModelName，只读。 */
export const bmfReferences = (path: string) => invoke<BmfRefScan>("bmf_references", { path });
export const bmfPublishProbe = (component: string, module: string, bmfPath?: string) =>
  invoke<BmfPublishProbe>("bmf_publish_probe", {
    component,
    module,
    bmfPath: bmfPath ?? null,
  });

/**
 * 组件历史：工作副本根按**文件路径**推导，链接工程的 BMF 也能读到，
 * 不受主工作区（`getSession().root`）限制。
 */
export const bmfHistory = (path: string, limit = 50, from = 0) =>
  invoke<HistoryResult>("bmf_history", { path, limit, from });
/** 某个修订里的完整正文（SVN 层已转 UTF-8、统一 LF）。 */
export const bmfRevisionText = (path: string, repositoryPath: string, revision: number) =>
  invoke<BmfRevisionText>("bmf_revision_text", { path, repositoryPath, revision });
/** 把一段 BMF 正文解析成语义模型；`path` 只用于归属与回显，不读写磁盘。 */
export const bmfDetailText = (path: string, text: string) =>
  invoke<BmfDetail>("bmf_detail_text", { path, text });
/** 导出自有字段模板（.xlsx）到工作区内目录；目标已存在会拒绝。 */
export const bmfExcelTemplate = (path: string, targetDir: string) =>
  invoke<string>("bmf_excel_template", { path, targetDir });
/** 解析自有模板并生成逐行差异与待写操作；只读，不写文件。 */
export const bmfExcelPreview = (path: string, file: string) =>
  invoke<BmfImportPreview>("bmf_excel_preview", { path, file });
/**
 * F3 只读对比：按文件名在 NC 安装目录各模块的 METADATA 下找同名组件并解析。
 * `installPath` 只能来自上一次返回的候选；不会写入安装目录。
 */
export const bmfNchomeCompare = (path: string, component: string, installPath?: string | null) =>
  invoke<BmfNcCompare>("bmf_nchome_compare", {
    path,
    component,
    installPath: installPath ?? null,
  });
/** M6 发布编排骨架：工具探测 + 前置检查 + 步骤；只读，不发布。 */
export const bmfReleasePlan = (path: string, component: string, module: string) =>
  invoke<BmfReleasePlan>("bmf_release_plan", { path, component, module });
/** 记录发布证据（Markdown），存到应用配置目录；`result` = success | failed | conditional。 */
export const bmfReleaseEvidence = (
  path: string,
  component: string,
  module: string,
  result: string,
  operator: string,
  note: string,
) =>
  invoke<BmfReleaseEvidenceSaved>("bmf_release_evidence", {
    path,
    component,
    module,
    result,
    operator,
    note,
  });
