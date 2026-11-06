import { useState } from "react";
import type { BmfDetail, BmfEditOp } from "../../lib/bmf";
import type { MetaStage } from "../../lib/metaDraft";
import { Input } from "../ui/input";
import { MetaOpDialog } from "./MetaOpDialog";

const ENTITY = /^[A-Za-z][A-Za-z0-9_]*$/;
const TABLE = /^[A-Za-z][A-Za-z0-9_$#]*$/;
const CLASS = /^nc\.vo\.[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;
const DOTTED = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

/** 以已有实体为蓝本新增实体：字段随实体一次写入，字段 id 重新生成。 */
export function MetaCopyEntityDialog({
  path,
  sha,
  detail,
  onClose,
  onSaved,
  onReload,
  onStage,
}: {
  path: string;
  sha: string;
  detail: BmfDetail;
  onClose: () => void;
  onSaved: () => void;
  onReload?: () => void;
  onStage?: MetaStage;
}) {
  const first = detail.entities[0];
  const [sourceId, setSourceId] = useState(first?.id ?? "");
  const src = detail.entities.find((e) => e.id === sourceId);
  const [form, setForm] = useState(() => ({
    name: first ? `${first.name}2` : "",
    displayName: first ? `${first.displayName || first.name}（副本）` : "",
    table: first ? `${first.table}2` : "",
    fullClass: first ? `${first.fullClass}2` : "",
    accessor: first ? `${first.accessor || first.fullClass}2` : "",
  }));
  const patch = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));

  const pickSource = (id: string) => {
    const e = detail.entities.find((x) => x.id === id);
    setSourceId(id);
    if (!e) return;
    patch({
      name: `${e.name}2`,
      displayName: `${e.displayName || e.name}（副本）`,
      table: `${e.table}2`,
      fullClass: `${e.fullClass}2`,
      accessor: `${e.accessor || e.fullClass}2`,
    });
  };

  const nameOk = ENTITY.test(form.name.trim());
  const tableOk = TABLE.test(form.table.trim());
  const classOk = CLASS.test(form.fullClass.trim());
  const accText = form.accessor.trim();
  const accessorOk = accText === "" || DOTTED.test(accText);
  const valid = !!src && nameOk && tableOk && classOk && accessorOk;

  const ops = (): BmfEditOp[] => {
    if (!src) return [];
    return [
      {
        op: "addEntity",
        name: form.name.trim(),
        displayName: form.displayName.trim(),
        table: form.table.trim(),
        fullClass: form.fullClass.trim(),
        accessor: accText,
        isPrimary: false,
        attrs: src.attrs.map((a) => ({
          name: a.name,
          displayName: a.displayName,
          style: a.style || "SINGLE",
          typeName: a.typeName || "String",
          dataType: a.dataType,
          dbType: a.dbType,
          length: a.length,
          nullable: a.nullable,
          defaultValue: a.defaultValue,
          isKey: a.isKey,
        })),
      },
    ];
  };

  return (
    <MetaOpDialog
      ariaLabel="复制实体"
      title={
        <>
          复制实体
          <span className="ml-2 text-[11px] font-normal text-muted-foreground">
            字段一起复制，字段 id 重新生成
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
      onStage={onStage}
      draftLabel={`复制实体为 ${form.name}`}
    >
      <div className="meta-form">
        <label>
          <span>复制自</span>
          <select aria-label="复制自" value={sourceId} onChange={(e) => pickSource(e.target.value)}>
            {detail.entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.displayName ? ` · ${e.displayName}` : ""} · {e.attrs.length} 字段
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>实体名（name）</span>
          <Input
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
            aria-invalid={!nameOk || undefined}
          />
          {!nameOk && <span className="meta-field-error">只能包含字母、数字、下划线，且以字母开头</span>}
        </label>
        <label>
          <span>显示名</span>
          <Input value={form.displayName} onChange={(e) => patch({ displayName: e.target.value })} />
        </label>
        <label>
          <span>表名（tableName）</span>
          <Input
            value={form.table}
            onChange={(e) => patch({ table: e.target.value })}
            aria-invalid={!tableOk || undefined}
          />
          {!tableOk && <span className="meta-field-error">只能包含字母、数字、下划线、$、#，且以字母开头</span>}
        </label>
        <label>
          <span>VO 类名（fullClassName）</span>
          <Input
            value={form.fullClass}
            onChange={(e) => patch({ fullClass: e.target.value })}
            aria-invalid={!classOk || undefined}
          />
          {!classOk && <span className="meta-field-error">必须是 nc.vo. 开头的完整类名</span>}
        </label>
        <label>
          <span>访问器（accessor）</span>
          <Input
            value={form.accessor}
            onChange={(e) => patch({ accessor: e.target.value })}
            aria-invalid={!accessorOk || undefined}
          />
          {!accessorOk && <span className="meta-field-error">必须是点分形式的类名</span>}
        </label>
        <p className="meta-note">
          {src ? `将复制 ${src.attrs.length} 个字段（含类型、长度、默认值、主键标记）。` : "先选择一个源实体。"}
        </p>
      </div>
    </MetaOpDialog>
  );
}
