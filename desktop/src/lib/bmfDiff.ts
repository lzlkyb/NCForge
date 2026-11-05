import type { BmfAttr, BmfDetail, BmfEntity, BmfEnum } from "./bmf";

/** 字段级结构对比：用于同一组件的不同版本 / 不同工程副本。 */
export type DiffKind = "component" | "entity" | "attr" | "enum" | "enumItem" | "relation";
export type DiffChange = "added" | "removed" | "changed";

export interface DiffRow {
  kind: DiffKind;
  /** 所属实体 / 枚举 / 关系的名字，便于分组渲染。 */
  scope: string;
  change: DiffChange;
  field: string;
  before: string;
  after: string;
}

const ATTR_FIELDS: { key: keyof BmfAttr; label: string }[] = [
  { key: "displayName", label: "显示名" },
  { key: "field", label: "列名" },
  { key: "typeName", label: "类型" },
  { key: "dataType", label: "dataType" },
  { key: "style", label: "风格" },
  { key: "dbType", label: "dbType" },
  { key: "length", label: "长度" },
  { key: "precision", label: "精度" },
  { key: "nullable", label: "可空" },
  { key: "defaultValue", label: "默认值" },
  { key: "isKey", label: "主键" },
];

const show = (v: unknown): string => (v == null ? "—" : String(v));

function byName<T extends { name: string }>(list: T[]): Map<string, T> {
  const m = new Map<string, T>();
  // 重名时保留第一个：结构对比不该因为重复定义而抖动。
  for (const it of list) if (!m.has(it.name)) m.set(it.name, it);
  return m;
}

/**
 * 对比两份 BMF 详情的结构差异。`before` 是当前打开的组件，`after` 是对比目标。
 *
 * 只比结构，不比原始字节 / 注释 / 未知节点——那些东西没有稳定的语义键，逐字节 diff
 * 属于版本工具（SVN）的职责，放在这里只会制造噪声。
 */
export function diffDetails(before: BmfDetail, after: BmfDetail): DiffRow[] {
  const rows: DiffRow[] = [];
  const cmp = (kind: DiffKind, scope: string, field: string, a: unknown, b: unknown) => {
    if (show(a) !== show(b)) {
      rows.push({ kind, scope, change: "changed", field, before: show(a), after: show(b) });
    }
  };

  cmp("component", "组件", "版本", before.component.version, after.component.version);
  cmp("component", "组件", "命名空间", before.component.namespace, after.component.namespace);
  cmp("component", "组件", "所属模块", before.component.ownModule, after.component.ownModule);
  cmp("component", "组件", "主实体", before.component.mainEntity, after.component.mainEntity);

  const beforeEnt = byName(before.entities);
  const afterEnt = byName(after.entities);
  for (const [name, e] of beforeEnt) {
    const other = afterEnt.get(name);
    if (!other) {
      rows.push({ kind: "entity", scope: name, change: "removed", field: "实体", before: entityLabel(e), after: "" });
      continue;
    }
    cmp("entity", name, "显示名", e.displayName, other.displayName);
    cmp("entity", name, "表名", e.table, other.table);
    cmp("entity", name, "fullClass", e.fullClass, other.fullClass);
    cmp("entity", name, "访问器", e.accessor, other.accessor);
    cmp("entity", name, "主键", keyName(e), keyName(other));
    diffAttrs(rows, name, e, other);
  }
  for (const [name, e] of afterEnt) {
    if (!beforeEnt.has(name)) {
      rows.push({ kind: "entity", scope: name, change: "added", field: "实体", before: "", after: entityLabel(e) });
    }
  }

  diffEnums(rows, before.enums, after.enums);
  diffRelations(rows, before, after);
  return rows;
}

const entityLabel = (e: BmfEntity) => `${e.table || "无表名"} · ${e.attrs.length} 字段`;
const keyName = (e: BmfEntity) => e.attrs.find((a) => a.id === e.keyAttrId)?.name ?? "未指向";

function diffAttrs(rows: DiffRow[], entity: string, before: BmfEntity, after: BmfEntity) {
  const a = byName(before.attrs);
  const b = byName(after.attrs);
  for (const [name, attr] of a) {
    const other = b.get(name);
    if (!other) {
      rows.push({ kind: "attr", scope: entity, change: "removed", field: name, before: attr.typeName || "字段", after: "" });
      continue;
    }
    for (const f of ATTR_FIELDS) {
      const x = attr[f.key];
      const y = other[f.key];
      if (show(x) !== show(y)) {
        rows.push({ kind: "attr", scope: entity, change: "changed", field: `${name}.${f.label}`, before: show(x), after: show(y) });
      }
    }
  }
  for (const [name, attr] of b) {
    if (!a.has(name)) {
      rows.push({ kind: "attr", scope: entity, change: "added", field: name, before: "", after: attr.typeName || "字段" });
    }
  }
}

function diffEnums(rows: DiffRow[], before: BmfEnum[], after: BmfEnum[]) {
  const a = byName(before);
  const b = byName(after);
  for (const [name, e] of a) {
    const other = b.get(name);
    if (!other) {
      rows.push({ kind: "enum", scope: name, change: "removed", field: "枚举", before: `${e.items.length} 项`, after: "" });
      continue;
    }
    if (show(e.displayName) !== show(other.displayName)) {
      rows.push({ kind: "enum", scope: name, change: "changed", field: "显示名", before: show(e.displayName), after: show(other.displayName) });
    }
    const ia = new Map(e.items.map((i) => [i.value, i]));
    const ib = new Map(other.items.map((i) => [i.value, i]));
    for (const [v, it] of ia) {
      const o = ib.get(v);
      if (!o) rows.push({ kind: "enumItem", scope: name, change: "removed", field: v, before: it.display, after: "" });
      else if (show(it.display) !== show(o.display)) {
        rows.push({ kind: "enumItem", scope: name, change: "changed", field: v, before: show(it.display), after: show(o.display) });
      }
    }
    for (const [v, it] of ib) {
      if (!ia.has(v)) rows.push({ kind: "enumItem", scope: name, change: "added", field: v, before: "", after: it.display });
    }
  }
  for (const [name, e] of b) {
    if (!a.has(name)) rows.push({ kind: "enum", scope: name, change: "added", field: "枚举", before: "", after: `${e.items.length} 项` });
  }
}

function diffRelations(rows: DiffRow[], before: BmfDetail, after: BmfDetail) {
  const label = (d: BmfDetail, r: BmfDetail["relations"][number]) => {
    const name = (id: string) => d.entities.find((e) => e.id === id)?.name ?? id;
    return `${name(r.source)} → ${name(r.target)}`;
  };
  const key = (d: BmfDetail, r: BmfDetail["relations"][number]) => `${r.kind}|${label(d, r)}`;
  const a = new Map(before.relations.map((r) => [key(before, r), r]));
  const b = new Map(after.relations.map((r) => [key(after, r), r]));
  for (const [k, r] of a) {
    const o = b.get(k);
    if (!o) {
      rows.push({ kind: "relation", scope: label(before, r), change: "removed", field: r.kind, before: r.name || "—", after: "" });
    } else if (show(r.name) !== show(o.name)) {
      rows.push({ kind: "relation", scope: label(before, r), change: "changed", field: "关系名", before: show(r.name), after: show(o.name) });
    }
  }
  for (const [k, r] of b) {
    if (!a.has(k)) {
      rows.push({ kind: "relation", scope: label(after, r), change: "added", field: r.kind, before: "", after: r.name || "—" });
    }
  }
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
}

export function summarize(rows: DiffRow[]): DiffSummary {
  return {
    added: rows.filter((r) => r.change === "added").length,
    removed: rows.filter((r) => r.change === "removed").length,
    changed: rows.filter((r) => r.change === "changed").length,
  };
}
