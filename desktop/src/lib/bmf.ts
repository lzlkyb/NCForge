import { invoke } from "./tauri";

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
  | { op: "addEnumItem"; enumId: string; value: string; display: string; id?: string };

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

export const bmfIndexScan = (force = false) => invoke<BmfIndex>("bmf_index_scan", { force });
export const bmfDetail = (path: string) => invoke<BmfDetail>("bmf_doc_detail", { path });
export const bmfValidate = (path: string) => invoke<BmfIssue[]>("bmf_validate", { path });
export const bmfGenerate = (path: string, entities?: string[]) =>
  invoke<BmfGeneration>("bmf_generate", { path, entities: entities ?? null });
export const bmfScaffoldPreview = (spec: BmfScaffoldSpec) =>
  invoke<BmfScaffold>("bmf_scaffold_preview", { spec });
export const bmfScaffoldWrite = (spec: BmfScaffoldSpec, path: string) =>
  invoke<string>("bmf_scaffold_write", { spec, path });
export const bmfEditPreview = (path: string, ops: BmfEditOp[]) =>
  invoke<string>("bmf_edit_preview", { path, ops });
/** `expectedSha` = 打开时 detail.sha256；外部改过文件会拒绝保存。 */
export const bmfEditSave = (path: string, ops: BmfEditOp[], expectedSha: string | null = null) =>
  invoke<BmfWriteResult>("bmf_edit_save", { path, ops, expectedSha });
export const bmfPublishProbe = (component: string, module: string, bmfPath?: string) =>
  invoke<BmfPublishProbe>("bmf_publish_probe", {
    component,
    module,
    bmfPath: bmfPath ?? null,
  });
