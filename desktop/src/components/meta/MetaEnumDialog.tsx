import { useState } from "react";
import type { BmfEditOp, BmfEnum } from "../../lib/bmf";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { MetaOpDialog } from "./MetaOpDialog";

const ENUM_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * 枚举编辑 / 新增。新增只建枚举壳（`<enumitemlist/>`），枚举项保存后再加：
 * 后端新增项要按 id 找已落地的节点，同批插入无法引用还没写出的容器。
 */
export function MetaEnumDialog({
  path,
  sha,
  en,
  onClose,
  onSaved,
  onReload,
}: {
  path: string;
  sha: string;
  /** null = 新增枚举。 */
  en: BmfEnum | null;
  onClose: () => void;
  onSaved: () => void;
  onReload?: () => void;
}) {
  const adding = en === null;
  const [form, setForm] = useState(() => ({
    name: en?.name ?? "",
    displayName: en?.displayName ?? "",
    typeName: en?.typeName || "String",
    dataType: en?.dataType ?? "",
  }));
  const [pending, setPending] = useState<{ value: string; display: string }[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [draft, setDraft] = useState({ value: "", display: "" });
  const patch = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));

  const nameOk = ENUM_NAME.test(form.name.trim());
  const typeOk = form.typeName.trim() !== "";
  const draftOk = draft.value.trim() !== "" && draft.display.trim() !== "";
  const kept = (en?.items ?? []).filter((it) => !removed.includes(it.id));
  const values = [...kept.map((it) => it.value), ...pending.map((p) => p.value.trim())];
  const duplicate = values.length !== new Set(values).size;
  const valid = nameOk && typeOk && !duplicate;

  const addDraft = () => {
    if (!draftOk) return;
    setPending((list) => [...list, { value: draft.value.trim(), display: draft.display.trim() }]);
    setDraft({ value: "", display: "" });
  };

  const ops = (): BmfEditOp[] => {
    if (adding) {
      return [
        {
          op: "addEnum",
          name: form.name.trim(),
          displayName: form.displayName.trim(),
          typeName: form.typeName.trim() || "String",
          dataType: form.dataType.trim(),
        },
      ];
    }
    const e = en!;
    const out: BmfEditOp[] = [];
    const set = (name: string, value: string) => out.push({ op: "setAttr", id: e.id, name, value });
    if (form.name.trim() !== e.name) set("name", form.name.trim());
    if (form.displayName !== e.displayName) set("displayName", form.displayName);
    if (form.typeName.trim() !== e.typeName) set("typeName", form.typeName.trim());
    if (form.dataType.trim() !== e.dataType) set("dataType", form.dataType.trim());
    for (const id of removed) out.push({ op: "deleteNode", id });
    for (const p of pending) {
      out.push({ op: "addEnumItem", enumId: e.id, value: p.value, display: p.display });
    }
    return out;
  };

  return (
    <MetaOpDialog
      ariaLabel={adding ? "新增枚举" : "编辑枚举"}
      title={
        <>
          {adding ? "新增枚举" : `编辑枚举 ${en?.name}`}
          <span className="ml-2 text-[11px] font-normal text-muted-foreground">
            {adding ? "保存后再加枚举项" : "改名不会同步字段里的引用"}
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
          <span>枚举名（name）</span>
          <Input
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="如 billstatus"
            aria-invalid={!nameOk || undefined}
          />
          {!nameOk && <span className="meta-field-error">只能包含字母、数字、下划线，且以字母开头</span>}
        </label>
        <label>
          <span>显示名</span>
          <Input
            value={form.displayName}
            onChange={(e) => patch({ displayName: e.target.value })}
            placeholder="如 单据状态"
          />
        </label>
        <label>
          <span>值类型（typeName）</span>
          <Input
            value={form.typeName}
            onChange={(e) => patch({ typeName: e.target.value })}
            placeholder="String"
            aria-invalid={!typeOk || undefined}
          />
          {!typeOk && <span className="meta-field-error">类型不能为空</span>}
        </label>
        <label>
          <span>基础类型（dataType）</span>
          <Input
            value={form.dataType}
            onChange={(e) => patch({ dataType: e.target.value })}
            placeholder="可留空"
          />
        </label>
      </div>

      {!adding && en && (
        <div className="meta-enum-edit">
          <div className="meta-enum-edit-head">
            <span>枚举项（{kept.length + pending.length}）</span>
            {duplicate && <span className="meta-field-error">枚举值重复</span>}
          </div>
          <div className="meta-enum-items">
            {kept.map((it) => (
              <span key={it.id} className="meta-enum-item">
                {it.value} = {it.display}
                <button
                  type="button"
                  className="meta-item-del"
                  aria-label={`删除枚举项 ${it.value}`}
                  onClick={() => setRemoved((r) => [...r, it.id])}
                >
                  <Icon name="close" size={10} />
                </button>
              </span>
            ))}
            {pending.map((p, i) => (
              <span key={`new-${i}`} className="meta-enum-item is-new" title="保存后写入">
                {p.value} = {p.display}
                <button
                  type="button"
                  className="meta-item-del"
                  aria-label={`移除待新增枚举项 ${p.value}`}
                  onClick={() => setPending((list) => list.filter((_, k) => k !== i))}
                >
                  <Icon name="close" size={10} />
                </button>
              </span>
            ))}
            {kept.length + pending.length === 0 && <span className="meta-note">还没有枚举项。</span>}
          </div>
          <div className="meta-enum-add">
            <Input
              value={draft.value}
              onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
              placeholder="值"
              aria-label="新枚举项的值"
            />
            <Input
              value={draft.display}
              onChange={(e) => setDraft((d) => ({ ...d, display: e.target.value }))}
              placeholder="显示名"
              aria-label="新枚举项的显示名"
            />
            <button type="button" className="meta-link" onClick={addDraft} disabled={!draftOk}>
              <Icon name="plus" size={12} /> 加一项
            </button>
          </div>
        </div>
      )}
    </MetaOpDialog>
  );
}
