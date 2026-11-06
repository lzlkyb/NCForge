import type { BmfAttr, BmfDetail, BmfEntity, BmfInterfaceAttr } from "./bmf";
import type { MetaSelection } from "./metaEditor";

export type MetaCanvasObject = BmfEntity & { modelKind?: "interface" | "reference" };
const interfaceField = (a: BmfInterfaceAttr): BmfAttr => ({ ...a, field: "", typeDisplayName: a.typeName, fieldType: "", length: null, precision: null,
  isKey: false, nullable: true, defaultValue: "", refModel: "", refTarget: "", raw: "" });

/** 图形适配只影响显示；接口、参照保留真实类别和对象 ID，不能作为实体写回。 */
export function canvasObjects(detail: BmfDetail): MetaCanvasObject[] {
  const interfaces = (detail.interfaces ?? []).filter((i) => !i.external).map((i): MetaCanvasObject => ({
    id: i.id, name: i.name, displayName: i.displayName, fullClass: i.fullClass, table: "", accessor: "", isPrimary: false,
    keyAttrId: "", attrs: i.attrs.map(interfaceField), raw: "", modelKind: "interface",
  }));
  const references = (detail.references ?? []).map((r): MetaCanvasObject => ({
    id: r.id, name: r.name || r.fullClass.split(".").pop() || r.id, displayName: r.displayName,
    fullClass: r.fullClass, table: "", accessor: "", isPrimary: false, keyAttrId: "", attrs: [], raw: "", modelKind: "reference",
  }));
  return [...detail.entities, ...interfaces, ...references];
}

export function canvasSelection(object: MetaCanvasObject, attrId?: string): MetaSelection {
  if (object.modelKind === "reference") return { kind: "reference", referenceId: object.id };
  if (object.modelKind === "interface") return attrId ? { kind: "interfaceAttr", interfaceId: object.id, attrId } : { kind: "interface", interfaceId: object.id };
  return attrId ? { kind: "attr", entityId: object.id, attrId } : { kind: "entity", entityId: object.id };
}

export const canvasSelectionId = (selection: MetaSelection): string | null => selection.kind === "entity" || selection.kind === "attr" ? selection.entityId
  : selection.kind === "interface" || selection.kind === "interfaceAttr" ? selection.interfaceId : selection.kind === "reference" ? selection.referenceId : null;

export function visibleCanvasNodes(positions: { x: number; y: number }[], heights: number[], viewport: { left: number; top: number; width: number; height: number }, zoom: number, selected: number = -1) {
  const keep = new Set<number>();
  const left = viewport.left / zoom - 300, top = viewport.top / zoom - 220;
  const right = (viewport.left + viewport.width) / zoom + 300, bottom = (viewport.top + viewport.height) / zoom + 220;
  positions.forEach((p, i) => { if (i === selected || (p.x + 244 >= left && p.x <= right && p.y + heights[i] >= top && p.y <= bottom)) keep.add(i); });
  return keep;
}
