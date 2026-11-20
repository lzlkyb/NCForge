import { useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { addSnippet, type QueryParameterType } from "../../lib/dbSnippets";
import type { BoundCell } from "../../lib/dbApi";
import { parameterizeLiteral, queryParameters } from "../../lib/sqlQueryParameters";
import { toast } from "../ui/toast";
import "./sql-parameters.css";

export function SaveQueryTemplate({ sql, connId, schema, onClose }: { sql: string; connId: string; schema?: string; onClose: () => void }) {
  const [draft, setDraft] = useState(sql);
  const selection = useRef<[number, number]>([0, 0]);
  const [parameter, setParameter] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [types, setTypes] = useState<Record<string, QueryParameterType>>({});
  const replace = () => {
    const next = parameterizeLiteral(draft, ...selection.current, parameter.trim());
    if (next === null) return setError("请选中一个完整的字符串（含引号）或数字，并输入有效的参数名。");
    setDraft(next);
    selection.current = [0, 0];
    setError("");
  };
  return <Modal open onClose={onClose} ariaLabel="保存为查询模板" className="modal-surface dbx-parameter-dialog">
    <form onSubmit={event => { event.preventDefault(); addSnippet({ name: title, sql: draft, connId, schema, parameterTypes: types }); toast("已保存到 SQL 片段", "success"); onClose(); }}>
      <h2>保存为查询模板</h2>
      <label>模板名称 <input autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder="如：按单号查采购订单" /></label>
      <p className="dbx-muted">选中要换成参数的值。字符串需连引号一起选中。</p>
      <textarea aria-label="模板 SQL" className="dbx-mono" rows={7} readOnly value={draft}
        onSelect={event => { selection.current = [event.currentTarget.selectionStart, event.currentTarget.selectionEnd]; }} />
      <div className="dbx-parameter-field">
        <label>参数名 <input placeholder="如 bill_no" value={parameter} onChange={event => setParameter(event.target.value)} /></label>
        <button type="button" className="dbx-btn" onClick={replace}>替换为参数</button>
      </div>
      {queryParameters(draft).map(name => <label key={name}>:{name} 类型 <ParameterTypeSelect name={name} value={types[name] ?? "text"}
        onChange={type => setTypes(current => ({ ...current, [name]: type }))} /></label>)}
      {error && <p className="dbx-parameter-error" role="alert">{error}</p>}
      <div className="dbx-parameter-footer">
        <button type="button" className="dbx-btn" onClick={onClose}>取消</button>
        <button type="submit" className="dbx-btn pri" disabled={!title.trim() || draft === sql}>保存模板</button>
      </div>
    </form>
  </Modal>;
}

function ParameterTypeSelect({ name, value, onChange }: { name: string; value: QueryParameterType; onChange: (type: QueryParameterType) => void }) {
  return <select aria-label={`参数 ${name} 类型`} value={value} onChange={event => onChange(event.target.value as QueryParameterType)}>
    <option value="text">文本</option><option value="number">数字</option><option value="null">NULL</option>
  </select>;
}

export function SqlParameterDialog({ names, target, onClose, onRun, initialTypes, onSaveTypes }: {
  names: string[]; target: string; onClose: () => void; onRun: (values: Map<string, BoundCell>) => void;
  initialTypes?: Record<string, QueryParameterType>;
  onSaveTypes?: (types: Record<string, QueryParameterType>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(names.map(name => [name, ""])));
  const [types, setTypes] = useState<Record<string, QueryParameterType>>(() => Object.fromEntries(names.map(name =>
    [name, initialTypes && Object.prototype.hasOwnProperty.call(initialTypes, name) ? initialTypes[name] : "text"])));
  const [remember, setRemember] = useState(false);
  const invalid = names.some(name => types[name] === "number" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(values[name]?.trim() ?? ""));
  return <Modal open onClose={onClose} ariaLabel="填写查询参数" className="modal-surface dbx-parameter-dialog">
    <form onSubmit={event => {
      event.preventDefault();
      if (invalid) return;
      if (remember) onSaveTypes?.(types);
      onRun(new Map(names.map(name => [name, types[name] === "null" ? null : types[name] === "number" ? { number: values[name].trim() } : values[name] ?? ""])));
    }}>
      <h2>填写查询参数</h2>
      <p className="dbx-parameter-target"><span>执行目标</span><strong>{target}</strong></p>
      {names.map((name, index) => <div className="dbx-parameter-field" key={name}>
        <label><code>:{name}</code> <input autoFocus={index === 0} disabled={types[name] === "null"} value={values[name] ?? ""}
          onChange={event => setValues({ ...values, [name]: event.target.value })} /></label>
        <ParameterTypeSelect name={name} value={types[name] ?? "text"} onChange={type => setTypes({ ...types, [name]: type })} />
      </div>)}
      {onSaveTypes && <label><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} /> 保存参数类型到模板</label>}
      {invalid && <p className="dbx-parameter-error" role="alert">请填写有效数字。</p>}
      <div className="dbx-parameter-footer">
        <button type="button" className="dbx-btn" onClick={onClose}>取消</button>
        <button type="submit" className="dbx-btn pri" disabled={invalid}>执行查询</button>
      </div>
    </form>
  </Modal>;
}
