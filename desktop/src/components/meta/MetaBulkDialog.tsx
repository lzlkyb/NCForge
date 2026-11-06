import { useMemo, useState } from "react";
import type { BmfDetail, BmfEntity } from "../../lib/bmf";
import type { MetaStage } from "../../lib/metaDraft";
import { BMF_BASE_TYPES } from "../../lib/bmfTypes";
import { autoMetaColumns, META_COLUMNS, META_TEMPLATES, parseMetaPaste, planMetaBatch, planMetaPaste, type MetaColumn } from "../../lib/metaBulk";
import { Input } from "../ui/input";
import { MetaOpDialog } from "./MetaOpDialog";

export function MetaBulkDialog({ detail, entity, ids, kind, initialText = "", onStage, onClose, onSaved }: {
  detail: BmfDetail; entity: BmfEntity; ids: string[]; kind: "paste" | "batch" | "template"; initialText?: string;
  onStage: MetaStage; onClose: () => void; onSaved: () => void;
}) {
  const [text, setText] = useState(initialText || (kind === "template" ? META_TEMPLATES["删除标记与时间戳"] : ""));
  const [mode, setMode] = useState<"add" | "update">("add");
  const [columns, setColumns] = useState<MetaColumn[] | null>(null);
  const [batch, setBatch] = useState({ typeId: "", length: "", precision: "", nullable: "", defaultValue: "", changeDefault: false });
  const parsed = useMemo(() => { try { return { data: parseMetaPaste(text), error: null }; } catch (e) { return { data: null, error: (e as Error).message }; } }, [text]);
  const mapping = columns ?? autoMetaColumns(parsed.data?.headers ?? []);
  const plan = kind === "batch" ? planMetaBatch(detail, entity, ids, {
    ...(batch.typeId ? { typeId: batch.typeId } : {}), ...(batch.length ? { length: Number(batch.length) } : {}),
    ...(batch.precision ? { precision: Number(batch.precision) } : {}), ...(batch.nullable ? { nullable: batch.nullable === "true" } : {}),
    ...(batch.changeDefault ? { defaultValue: batch.defaultValue } : {}),
  }) : parsed.data ? planMetaPaste(detail, entity, parsed.data, mapping, mode) : { ops: [], errors: [parsed.error!], count: 0 };
  const title = kind === "batch" ? "批量设置字段" : kind === "template" ? "应用字段模板" : "粘贴字段";
  return <MetaOpDialog title={title} ariaLabel={title} path={detail.path} sha={detail.sha256} ops={plan.ops} valid={plan.ops.length > 0 && !plan.errors.length}
    onStage={onStage} draftLabel={`${title} · ${plan.count} 字段`} onClose={onClose} onSaved={onSaved}>
    <p className="meta-note">{entity.displayName || entity.name} · {kind === "batch" ? `选中 ${ids.length} 个字段，未设置的项保持原值。` : "先核对列映射；整批通过检查后加入草稿。"}</p>
    {kind === "batch" ? <div className="meta-form">
      <label><span>类型</span><select aria-label="批量字段类型" value={batch.typeId} onChange={(e) => setBatch((s) => ({ ...s, typeId: e.target.value }))}><option value="">保持原值</option>{BMF_BASE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
      <label><span>允许为空</span><select value={batch.nullable} onChange={(e) => setBatch((s) => ({ ...s, nullable: e.target.value }))}><option value="">保持原值</option><option value="true">允许</option><option value="false">不允许</option></select></label>
      <label><span>长度</span><Input value={batch.length} placeholder="保持原值" inputMode="numeric" onChange={(e) => setBatch((s) => ({ ...s, length: e.target.value }))} /></label>
      <label><span>精度</span><Input value={batch.precision} placeholder="保持原值" inputMode="numeric" onChange={(e) => setBatch((s) => ({ ...s, precision: e.target.value }))} /></label>
      <label className="meta-check"><input type="checkbox" checked={batch.changeDefault} onChange={(e) => setBatch((s) => ({ ...s, changeDefault: e.target.checked }))} /><span>设置默认值（留空会清除）</span></label>
      <Input aria-label="批量默认值" disabled={!batch.changeDefault} value={batch.defaultValue} onChange={(e) => setBatch((s) => ({ ...s, defaultValue: e.target.value }))} />
    </div> : <>
      {kind === "template" && <label className="meta-bulk-label">字段模板<select aria-label="字段模板" onChange={(e) => { setText(META_TEMPLATES[e.target.value]); setColumns(null); }}>{Object.keys(META_TEMPLATES).map((name) => <option key={name}>{name}</option>)}</select></label>}
      <label className="meta-bulk-label">含表头的 CSV / TSV<textarea aria-label="粘贴字段内容" className="meta-bulk-input" value={text} spellCheck={false}
        placeholder={"字段名\t显示名\t类型\ncode\t编码\tString"} onChange={(e) => { setText(e.target.value); setColumns(null); }} /></label>
      <label className="meta-bulk-label">写入方式<select value={mode} onChange={(e) => setMode(e.target.value as "add" | "update")}><option value="add">新增字段</option><option value="update">按字段名更新已有字段</option></select></label>
      {parsed.data && <div className="meta-paste-mapping">{parsed.data.headers.map((header, i) => <label key={i}><span>{header || `第 ${i + 1} 列`}</span><select aria-label={`映射 ${header}`} value={mapping[i]}
        onChange={(e) => setColumns(mapping.map((value, n) => n === i ? e.target.value as MetaColumn : value))}><option value="skip">不使用</option>{META_COLUMNS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><small>{parsed.data!.rows[0]?.[i]}</small></label>)}</div>}
    </>}
    {!!plan.errors.length && <div className="meta-error-box" role="alert"><strong>请修正预检问题</strong>{plan.errors.slice(0, 8).map((error, i) => <p key={i}>{error}</p>)}{plan.errors.length > 8 && <p>还有 {plan.errors.length - 8} 项问题</p>}</div>}
    {!plan.errors.length && plan.ops.length > 0 && <p className="meta-note" role="status">{plan.count} 个字段通过输入检查；加入草稿时还会校验模型依赖。</p>}
  </MetaOpDialog>;
}
