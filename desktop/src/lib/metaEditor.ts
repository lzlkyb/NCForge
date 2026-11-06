import type { BmfDetail, BmfEntity, BmfIssue } from "./bmf";
import type { MetaView } from "../components/meta/MetaViewPanel";

export type MetaSelection =
  | { kind: "component" }
  | { kind: "entity"; entityId: string }
  | { kind: "attr"; entityId: string; attrId: string }
  | { kind: "relation"; relationId: string }
  | { kind: "enum"; enumId: string }
  | { kind: "interface"; interfaceId: string }
  | { kind: "interfaceAttr"; interfaceId: string; attrId: string }
  | { kind: "reference"; referenceId: string };
export type MetaMode = "linked" | "model" | "fields";
export type MetaPane = "fields" | "interfaces" | "relations" | "issues" | "overview" | "refs";
export interface MetaCanvasState {
  moved: Record<string, { x: number; y: number }>;
  zoom: number;
  left: number;
  top: number;
}
export interface MetaEditorState {
  selection: MetaSelection;
  mode: MetaMode;
  modeChosen: boolean;
  pane: MetaPane;
  view: MetaView;
  filter: string;
  selectedFields: string[];
  fieldScroll: { left: number; top: number };
  canvas: MetaCanvasState;
  split: number;
}

export function newMetaEditorState(): MetaEditorState {
  return {
    selection: { kind: "component" }, mode: "linked", modeChosen: false, pane: "fields", view: "detail",
    filter: "", selectedFields: [], fieldScroll: { left: 0, top: 0 },
    canvas: { moved: {}, zoom: 1, left: 0, top: 0 }, split: 0.52,
  };
}

export const findMetaEntity = (detail: BmfDetail, id: string) =>
  detail.entities.find((e) => e.id === id || e.name === id);

/** 只在对象消失时回退；刷新后的检查器始终读取新详情，不缓存旧属性对象。 */
export function restoreMetaSelection(detail: BmfDetail, selection: MetaSelection): MetaSelection {
  if (selection.kind === "entity" || selection.kind === "attr") {
    const entity = findMetaEntity(detail, selection.entityId);
    if (entity) {
      if (selection.kind === "attr" && entity.attrs.some((a) => a.id === selection.attrId)) {
        return { ...selection, entityId: entity.id };
      }
      return { kind: "entity", entityId: entity.id };
    }
  } else if (selection.kind === "relation" && detail.relations.some((r) => r.id === selection.relationId)) {
    return selection;
  } else if (selection.kind === "enum" && detail.enums.some((e) => e.id === selection.enumId)) {
    return selection;
  } else if (selection.kind === "interface" || selection.kind === "interfaceAttr") {
    const item = detail.interfaces?.find((i) => i.id === selection.interfaceId);
    if (item) return selection.kind === "interfaceAttr" && !item.attrs.some((a) => a.id === selection.attrId)
      ? { kind: "interface", interfaceId: item.id } : selection;
  } else if (selection.kind === "reference" && detail.references?.some((r) => r.id === selection.referenceId)) {
    return selection;
  } else if (selection.kind === "component") {
    return selection;
  }
  return { kind: "component" };
}

export function selectedMetaEntity(detail: BmfDetail, selection: MetaSelection): BmfEntity | undefined {
  if (selection.kind === "attr" || selection.kind === "entity") return findMetaEntity(detail, selection.entityId);
  if (selection.kind === "relation") {
    const relation = detail.relations.find((r) => r.id === selection.relationId);
    return relation ? findMetaEntity(detail, relation.source) : undefined;
  }
  return detail.entities.find((e) => e.id === detail.component.mainEntity) ?? detail.entities[0];
}

/** 诊断可能使用技术名或 GUID；没有真实对象时不显示一个无效定位按钮。 */
export function locateMetaIssue(detail: BmfDetail, issue: BmfIssue): MetaSelection | null {
  const entity = findMetaEntity(detail, issue.entity);
  if (entity) {
    const attr = entity.attrs.find((a) => a.id === issue.attr || a.name === issue.attr);
    return attr ? { kind: "attr", entityId: entity.id, attrId: attr.id } : { kind: "entity", entityId: entity.id };
  }
  const itf = detail.interfaces?.find((i) => i.id === issue.entity || i.name === issue.entity);
  if (itf) {
    const attr = itf.attrs.find((a) => a.id === issue.attr || a.name === issue.attr);
    return attr ? { kind: "interfaceAttr", interfaceId: itf.id, attrId: attr.id } : { kind: "interface", interfaceId: itf.id };
  }
  const relation = detail.relations.find((r) => r.id === issue.entity || r.id === issue.attr);
  if (relation) return { kind: "relation", relationId: relation.id };
  const reference = detail.references?.find((r) => r.id === issue.entity);
  return reference ? { kind: "reference", referenceId: reference.id } : null;
}

export const semanticPane = (selection: MetaSelection): MetaPane => selection.kind === "interface" || selection.kind === "interfaceAttr" || selection.kind === "reference"
  ? "interfaces" : selection.kind === "enum" || selection.kind === "relation" ? "relations" : "fields";

export function fieldWindow(count: number, top: number, height: number, rowHeight = 32) {
  const start = Math.max(0, Math.min(count, Math.floor(top / rowHeight) - 5));
  const end = Math.min(count, start + Math.ceil(Math.max(height, 160) / rowHeight) + 10);
  return { start, end, before: start * rowHeight, after: (count - end) * rowHeight };
}
