import { useState } from "react";
import type { BmfEditOp, BmfEntity } from "../../lib/bmf";
import { Input } from "../ui/input";
import { MetaOpDialog } from "./MetaOpDialog";

const ENTITY = /^[A-Za-z][A-Za-z0-9_]*$/;
const TABLE = /^[A-Za-z][A-Za-z0-9_$#]*$/;
const DOTTED = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;
const CLASS = /^nc\.vo\.[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

/**
 * 实体编辑 / 新增。改名不会自动更新其它组件对该实体的引用（BMF 内按 id 引用，
 * 跨组件按类名/表名引用），所以只在提示里讲清楚，不假装能自动同步。
 */
export function MetaEntityDialog({
  path,
  sha,
  entity,
  onClose,
  onSaved,
  onReload,
}: {
  path: string;
  sha: string;
  /** null = 新增实体。 */
  entity: BmfEntity | null;
  onClose: () => void;
  onSaved: () => void;
  onReload?: () => void;
}) {
  const adding = entity === null;
  const [form, setForm] = useState(() => ({
    name: entity?.name ?? "",
    displayName: entity?.displayName ?? "",
    table: entity?.table ?? "",
    fullClass: entity?.fullClass ?? "",
    accessor: entity?.accessor ?? "",
    isPrimary: entity?.isPrimary ?? false,
    keyAttrId: entity?.keyAttrId ?? "",
  }));
  const patch = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));

  const nameOk = ENTITY.test(form.name.trim());
  const tableOk = TABLE.test(form.table.trim());
  const classOk = CLASS.test(form.fullClass.trim());
  const accText = form.accessor.trim();
  const accessorOk = accText === "" || DOTTED.test(accText);
  const valid = nameOk && tableOk && classOk && accessorOk;

  const ops = (): BmfEditOp[] => {
    if (adding) {
      return [
        {
          op: "addEntity",
          name: form.name.trim(),
          displayName: form.displayName.trim(),
          table: form.table.trim(),
          fullClass: form.fullClass.trim(),
          accessor: accText,
          isPrimary: form.isPrimary,
        },
      ];
    }
    const e = entity!;
    const out: BmfEditOp[] = [];
    const set = (name: string, value: string) => out.push({ op: "setAttr", id: e.id, name, value });
    if (form.name.trim() !== e.name) set("name", form.name.trim());
    if (form.displayName !== e.displayName) set("displayName", form.displayName);
    if (form.table.trim() !== e.table) set("tableName", form.table.trim());
    if (form.fullClass.trim() !== e.fullClass) set("fullClassName", form.fullClass.trim());
    if (accText !== e.accessor) set("accessor", accText);
    if (form.isPrimary !== e.isPrimary) set("isPrimary", form.isPrimary ? "true" : "false");
    if (form.keyAttrId !== e.keyAttrId) set("keyAttributeId", form.keyAttrId);
    return out;
  };

  return (
    <MetaOpDialog
      ariaLabel={adding ? "新增实体" : "编辑实体"}
      title={
        <>
          {adding ? "新增实体" : `编辑实体 ${entity?.name}`}
          <span className="ml-2 text-[11px] font-normal text-muted-foreground">
            {adding ? "主实体请到「编辑实体」里勾选" : "改名不会同步其它组件里的引用"}
          </span>
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
        <label>
          <span>实体名（name）</span>
          <Input
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="如 BillH"
            aria-invalid={!nameOk || undefined}
          />
          {!nameOk && <span className="meta-field-error">只能包含字母、数字、下划线，且以字母开头</span>}
        </label>
        <label>
          <span>显示名</span>
          <Input
            value={form.displayName}
            onChange={(e) => patch({ displayName: e.target.value })}
            placeholder="如 单据表头"
          />
        </label>
        <label>
          <span>表名（tableName）</span>
          <Input
            value={form.table}
            onChange={(e) => patch({ table: e.target.value })}
            placeholder="如 bd_bill_h"
            aria-invalid={!tableOk || undefined}
          />
          {!tableOk && <span className="meta-field-error">只能包含字母、数字、下划线、$、#，且以字母开头</span>}
        </label>
        <label>
          <span>VO 类名（fullClassName）</span>
          <Input
            value={form.fullClass}
            onChange={(e) => patch({ fullClass: e.target.value })}
            placeholder="nc.vo.module.BillHVO"
            aria-invalid={!classOk || undefined}
          />
          {!classOk && <span className="meta-field-error">必须是 nc.vo. 开头的完整类名</span>}
        </label>
        <label>
          <span>访问器（accessor）</span>
          <Input
            value={form.accessor}
            onChange={(e) => patch({ accessor: e.target.value })}
            placeholder="留空 = 与 VO 类名相同"
            aria-invalid={!accessorOk || undefined}
          />
          {!accessorOk && <span className="meta-field-error">必须是点分形式的类名</span>}
        </label>
        {!adding && entity && (
          <label>
            <span>主键字段（keyAttributeId）</span>
            <select
              aria-label="主键字段"
              value={form.keyAttrId}
              onChange={(e) => patch({ keyAttrId: e.target.value })}
            >
              <option value="">（不指定）</option>
              {entity.attrs.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.displayName ? ` · ${a.displayName}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="meta-check">
          <input
            type="checkbox"
            checked={form.isPrimary}
            onChange={(e) => patch({ isPrimary: e.target.checked })}
          />
          <span>主实体（isPrimary）</span>
        </label>
      </div>
    </MetaOpDialog>
  );
}
