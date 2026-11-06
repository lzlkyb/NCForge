import { useState } from "react";
import type { BmfAttr, BmfDetail, BmfEditOp, BmfEntity } from "../../lib/bmf";
import type { MetaStage } from "../../lib/metaDraft";
import { BMF_BASE_TYPES, baseTypeById, fieldTypeOps } from "../../lib/bmfTypes";
import { Input } from "../ui/input";
import { MetaOpDialog } from "./MetaOpDialog";

const IDENT = /^[a-z][a-z0-9_]*$/;
const STYLES = ["SINGLE", "REF", "ARRAY"] as const;

/**
 * 字段编辑：只碰用户填的这几个 XML 属性，先预览 diff 再保存。
 *
 * 名称/列名/类型都会进入 VO 与建表脚本，后端会再校验一次；
 * 这里做即时反馈，避免「预览成功、官方工具打不开」。
 */
export function MetaEditDialog({
  path,
  sha,
  entity,
  attr,
  onClose,
  onSaved,
  onReload,
  inline = false,
  onStage,
  detail,
}: {
  path: string;
  /** 打开组件时的 SHA-256：保存前由后端复核，外部改过就拒绝。 */
  sha: string;
  entity: BmfEntity;
  attr: BmfAttr | null;
  onClose: () => void;
  onSaved: () => void;
  onReload?: () => void;
  inline?: boolean;
  onStage?: MetaStage;
  detail?: BmfDetail;
}) {
  const adding = attr === null;
  const [newId] = useState(() => attr?.id ?? crypto.randomUUID());
  const [form, setForm] = useState(() => ({
    name: attr?.name ?? "",
    displayName: attr?.displayName ?? "",
    fieldName: attr?.field ?? "",
    typeName: attr?.typeName ?? "String",
    typeId: attr ? attr.dataType : BMF_BASE_TYPES[0].id,
    style: attr ? attr.style : "SINGLE",
    dbType: attr?.dbType || "varchar",
    length: attr?.length == null ? "" : String(attr.length),
    precision: attr?.precision == null ? "" : String(attr.precision),
    sequence: attr == null || attr.sequence < 0 ? "" : String(attr.sequence),
    nullable: attr?.nullable ?? true,
    defaultValue: attr?.defaultValue ?? "",
  }));
  const patch = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));

  const numOf = (raw: string) => (raw.trim() === "" ? null : Number(raw));
  const lenNum = numOf(form.length);
  const precNum = numOf(form.precision);
  const seqNum = numOf(form.sequence);
  const lengthOk = lenNum === null || (Number.isSafeInteger(lenNum) && lenNum > 0);
  const nonNeg = (n: number | null) => n === null || (Number.isSafeInteger(n) && n >= 0);
  const nameOk = !adding || IDENT.test(form.name.trim());
  // ARRAY 等已有字段允许没有列映射；原样保留不应阻止编辑显示名。
  const fieldOk = (adding && !form.fieldName.trim()) || form.fieldName.trim() === attr?.field || IDENT.test(form.fieldName.trim());
  const typeOk = form.typeName.trim() !== "";
  let typeError = "";
  let changedTypeOps: BmfEditOp[] = [];
  if (attr && (form.typeId !== attr.dataType || form.typeName !== attr.typeName)) {
    try { changedTypeOps = fieldTypeOps(detail ?? { entities: [entity], enums: [] }, attr, form.typeId); }
    catch (error) { typeError = (error as Error).message; }
  }
  const valid = lengthOk && nonNeg(precNum) && nonNeg(seqNum) && nameOk && fieldOk && typeOk && !typeError
    && !(lenNum != null && precNum != null && precNum > lenNum) && !(attr?.isKey && form.nullable && !attr.nullable);

  const ops = (): BmfEditOp[] => {
    if (adding) {
      const name = form.name.trim();
      const out: BmfEditOp[] = [
        {
          op: "addAttribute",
          id: newId,
          entity: entity.id,
          name,
          displayName: form.displayName.trim() || name,
          typeName: form.typeName.trim() || "String",
          dataType: form.typeId,
          style: "SINGLE",
          dbType: form.dbType.trim() || "varchar",
          length: lenNum ?? (form.typeName === "String" ? 101 : baseTypeById(form.typeId)?.length ?? null),
          nullable: form.nullable,
          defaultValue: form.defaultValue.trim(),
        },
      ];
      if (form.fieldName.trim() && form.fieldName.trim() !== name) out.push({ op: "setAttr", id: newId, name: "fieldName", value: form.fieldName.trim() });
      if (precNum != null) out.push({ op: "setAttr", id: newId, name: "precision", value: String(precNum) });
      return out;
    }
    const out: BmfEditOp[] = [];
    const a = attr!;
    const set = (name: string, value: string) => out.push({ op: "setAttr", id: a.id, name, value });
    if (form.displayName !== a.displayName) set("displayName", form.displayName);
    if (form.fieldName.trim() !== a.field) set("fieldName", form.fieldName.trim());
    out.push(...changedTypeOps);
    if (form.style !== a.style) set("dataTypeStyle", form.style);
    if (lenNum !== a.length) set("length", lenNum == null ? "" : String(lenNum));
    if (precNum !== a.precision) set("precision", precNum == null ? "" : String(precNum));
    if (seqNum !== null && seqNum !== a.sequence) set("sequence", String(seqNum));
    if (form.nullable !== a.nullable) set("isNullable", form.nullable ? "true" : "false");
    if (form.defaultValue !== a.defaultValue) set("defaultValue", form.defaultValue);
    return out;
  };

  return (
    <MetaOpDialog
      ariaLabel={adding ? "新增字段" : "编辑字段"}
      title={
        <>
          {adding ? "新增字段" : `编辑字段 ${attr?.name}`}
          <span className="ml-2 text-[11px] font-normal text-muted-foreground">{entity.name}</span>
        </>
      }
      path={path}
      sha={sha}
      ops={ops()}
      valid={valid}
      onClose={onClose}
      onSaved={onSaved}
      onReload={onReload}
      inline={inline}
      onStage={onStage}
      draftLabel={`${adding ? "新增" : "修改"}字段 ${form.name}`}
    >
      <div className="meta-form">
        {adding && (
          <label>
            <span>字段名</span>
            <Input
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="如 vbillcode（小写字母开头）"
              aria-invalid={!nameOk || undefined}
            />
            {!nameOk && <span className="meta-field-error">只能用小写字母、数字、下划线，且以字母开头</span>}
          </label>
        )}
        <label>
          <span>显示名</span>
          <Input
            value={form.displayName}
            onChange={(e) => patch({ displayName: e.target.value })}
            placeholder="界面上的中文名"
          />
        </label>
        {(
          <label>
            <span>列名（fieldName）</span>
            <Input
              value={form.fieldName}
              onChange={(e) => patch({ fieldName: e.target.value })}
              placeholder="数据库列名"
              aria-invalid={!fieldOk || undefined}
            />
            {!fieldOk && <span className="meta-field-error">列名只能用小写字母、数字、下划线，且以字母开头</span>}
          </label>
        )}
        <label>
          <span>类型（typeName）</span>
          <select aria-label="字段类型" value={form.typeId || "__current"} disabled={attr?.style === "REF" || attr?.style === "ARRAY"}
            onChange={(e) => { const type = baseTypeById(e.target.value); if (type) patch({ typeId: type.id, typeName: type.name, style: "SINGLE", dbType: type.dbType,
              length: type.length == null ? "" : String(type.length), precision: type.precision == null ? "" : String(type.precision) }); }}>
            {!baseTypeById(form.typeId) && <option value={form.typeId || "__current"}>{form.typeName || "未声明"}（保留原值）</option>}
            {BMF_BASE_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
          </select>
          {typeError && <span className="meta-field-error">{typeError}</span>}
        </label>
        {!adding && <label>
          <span>数据类型（dataTypeStyle）</span>
          <select aria-label="数据类型" value={form.style} disabled>
            {!STYLES.some((style) => style === form.style) && <option value={form.style}>{form.style || "未声明（保留原值）"}</option>}
            {STYLES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>}
        {adding && (
          <label>
            <span>列类型（dbtype）</span>
            <Input value={form.dbType} onChange={(e) => patch({ dbType: e.target.value })} placeholder="varchar" />
          </label>
        )}
        <label>
          <span>{adding ? "长度（默认 101）" : "长度"}</span>
          <Input
            value={form.length}
            onChange={(e) => patch({ length: e.target.value })}
            inputMode="numeric"
            placeholder="空 = 不写"
            aria-invalid={!lengthOk || undefined}
          />
          {!lengthOk && <span className="meta-field-error">长度必须是大于 0 的整数</span>}
        </label>
        {<label>
          <span>精度（precision）</span>
          <Input
            value={form.precision}
            onChange={(e) => patch({ precision: e.target.value })}
            inputMode="numeric"
            placeholder="空 = 不写小数位"
            aria-invalid={!nonNeg(precNum) || undefined}
          />
          {!nonNeg(precNum) && <span className="meta-field-error">精度必须是非负整数</span>}
        </label>}
        {!adding && <label>
          <span>顺序（sequence）</span>
          <Input
            value={form.sequence}
            onChange={(e) => patch({ sequence: e.target.value })}
            inputMode="numeric"
            placeholder="空 = 不改"
            aria-invalid={!nonNeg(seqNum) || undefined}
          />
          {!nonNeg(seqNum) && <span className="meta-field-error">顺序必须是非负整数</span>}
        </label>}
        <label className="meta-check">
          <input type="checkbox" checked={form.nullable} disabled={!!attr?.isKey} onChange={(e) => patch({ nullable: e.target.checked })} />
          <span>允许为空（isNullable）</span>
        </label>
        <label>
          <span>默认值</span>
          <Input
            value={form.defaultValue}
            onChange={(e) => patch({ defaultValue: e.target.value })}
            placeholder="留空 = 不写"
          />
        </label>
      </div>
      {lenNum != null && precNum != null && precNum > lenNum && <p className="meta-field-error">精度不能大于长度</p>}
    </MetaOpDialog>
  );
}
