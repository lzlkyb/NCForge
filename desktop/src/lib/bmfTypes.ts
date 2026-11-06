import catalog from "./bmfBaseTypes.json";
import type { BmfAttr, BmfDetail, BmfEditOp, BmfInterfaceAttr } from "./bmf";

export interface BmfBaseType { id: string; name: string; label: string; dbType: string; length: number | null; precision: number | null }
export const BMF_BASE_TYPES: readonly BmfBaseType[] = catalog;
export const baseTypeById = (id: string) => BMF_BASE_TYPES.find((type) => type.id === id);
export function baseTypeByName(name: string) {
  const matches = BMF_BASE_TYPES.filter((type) => type.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function valueType(detail: Pick<BmfDetail, "enums">, type: Pick<BmfAttr, "typeName" | "dataType" | "style">): string | null {
  if (type.style === "REF") return "String";
  if (detail.enums.some((en) => en.id === type.dataType)) return "Integer";
  if (["UFID", "String", "CUSTOM", "Multilangtext", "MEMO"].includes(type.typeName)) return "String";
  if (["UFDouble", "UFMoney", "BigDecimal"].includes(type.typeName)) return "UFDouble";
  if (["Integer", "UFBoolean", "UFDate", "UFDateTime", "UFTime", "UFLiteralDate"].includes(type.typeName)) return type.typeName;
  if (["IMAGE", "BLOB"].includes(type.typeName)) return "byte[]";
  return null;
}

/** 与 Rust 的严格值类型检查一致；未知类型不使用 String 回退。 */
export function mappingCompatible(detail: Pick<BmfDetail, "enums">, field: BmfAttr, expected: BmfInterfaceAttr) {
  if (field.style === "ARRAY" || expected.style === "ARRAY") return field.style === expected.style && !!field.dataType && field.dataType === expected.dataType;
  const a = valueType(detail, field), b = valueType(detail, expected);
  return a && b ? a === b : !!field.dataType && field.dataType === expected.dataType && field.style === expected.style;
}

/** 类型名、GUID 与存储类型一起修改；参照和数组需要自己的目标定义，不能猜成基础类型。 */
export function fieldTypeOps(detail: Pick<BmfDetail, "enums" | "entities" | "interfaces">, field: BmfAttr, typeId: string): BmfEditOp[] {
  const type = baseTypeById(typeId);
  if (!type && typeId === field.dataType) return [];
  if (!type) throw new Error("请选择已验证的 UAP 基础类型");
  if (field.dataType === type.id && field.typeName === type.name) return [];
  if (field.style === "REF" || field.style === "ARRAY") throw new Error(`${field.name} 是参照或数组，类型需要保留目标定义`);
  if (field.isKey && type.name !== "UFID") throw new Error(`${field.name} 是主键，请保留 UFID 类型`);
  const changed = { ...field, typeName: type.name, dataType: type.id, style: "SINGLE" };
  for (const entity of detail.entities) for (const mapping of entity.mappings ?? []) {
    if (mapping.attrId !== field.id) continue;
    const expected = detail.interfaces?.find((i) => i.id === mapping.interfaceId)?.attrs.find((a) => a.id === mapping.interfaceAttrId);
    if (!expected) throw new Error(`${field.name} 的接口定义未加载，类型暂时只读`);
    if (!mappingCompatible(detail, changed, expected)) throw new Error(`${field.name} 与接口属性 ${expected.name} 类型不兼容`);
  }
  return [["typeName", type.name], ["dataType", type.id], ["dataTypeStyle", "SINGLE"], ["dbtype", type.dbType]]
    .map(([name, value]) => ({ op: "setAttr", id: field.id, name, value }));
}
