import { useState } from "react";
import type { BmfAttr, BmfEditOp, BmfEntity } from "../../lib/bmf";
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
}: {
  path: string;
  /** 打开组件时的 SHA-256：保存前由后端复核，外部改过就拒绝。 */
  sha: string;
  entity: BmfEntity;
  attr: BmfAttr | null;
  onClose: () => void;
  onSaved: () => void;
  onReload?: () => void;
}) {
  const adding = attr === null;
  const [form, setForm] = useState(() => ({
    name: attr?.name ?? "",
    displayName: attr?.displayName ?? "",
    fieldName: attr?.field ?? "",
    typeName: attr?.typeName ?? "String",
    style: attr?.style || "SINGLE",
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
  const fieldOk = adding || IDENT.test(form.fieldName.trim());
  const typeOk = form.typeName.trim() !== "";
  const valid = lengthOk && nonNeg(precNum) && nonNeg(seqNum) && nameOk && fieldOk && typeOk;

  const ops = (): BmfEditOp[] => {
    if (adding) {
      const name = form.name.trim();
      return [
        {
          op: "addAttribute",
          entity: entity.id,
          name,
          displayName: form.displayName.trim() || name,
          typeName: form.typeName.trim() || "String",
          dbType: form.dbType.trim() || "varchar",
          length: lenNum ?? 101,
          nullable: form.nullable,
          defaultValue: form.defaultValue.trim(),
        },
      ];
    }
    const out: BmfEditOp[] = [];
    const a = attr!;
    const set = (name: string, value: string) => out.push({ op: "setAttr", id: a.id, name, value });
    if (form.displayName !== a.displayName) set("displayName", form.displayName);
    if (form.fieldName.trim() !== a.field) set("fieldName", form.fieldName.trim());
    if (form.typeName.trim() !== a.typeName) set("typeName", form.typeName.trim());
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
        {!adding && (
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
          <Input
            value={form.typeName}
            onChange={(e) => patch({ typeName: e.target.value })}
            placeholder="String / Decimal / UFID"
            aria-invalid={!typeOk || undefined}
          />
          {!typeOk && <span className="meta-field-error">类型不能为空</span>}
        </label>
        <label>
          <span>数据类型（dataTypeStyle）</span>
          <select aria-label="数据类型" value={form.style} onChange={(e) => patch({ style: e.target.value })}>
            {STYLES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
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
        <label>
          <span>精度（precision）</span>
          <Input
            value={form.precision}
            onChange={(e) => patch({ precision: e.target.value })}
            inputMode="numeric"
            placeholder="空 = 不写小数位"
            aria-invalid={!nonNeg(precNum) || undefined}
          />
          {!nonNeg(precNum) && <span className="meta-field-error">精度必须是非负整数</span>}
        </label>
        <label>
          <span>顺序（sequence）</span>
          <Input
            value={form.sequence}
            onChange={(e) => patch({ sequence: e.target.value })}
            inputMode="numeric"
            placeholder="空 = 不改"
            aria-invalid={!nonNeg(seqNum) || undefined}
          />
          {!nonNeg(seqNum) && <span className="meta-field-error">顺序必须是非负整数</span>}
        </label>
        <label className="meta-check">
          <input type="checkbox" checked={form.nullable} onChange={(e) => patch({ nullable: e.target.checked })} />
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
    </MetaOpDialog>
  );
}
