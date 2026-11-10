import { CodePreview } from "./CodePreview";
import { useId, useState, type ReactNode } from "react";
import type { BoundCell, ColumnInfo } from "../../lib/dbApi";
import { compileFilter, emptyFilter, loadFilter, saveFilter, type TableFilter } from "../../lib/dbConditions";
import { loadFilterView, saveFilterView } from "../../lib/dbTableView";
import { toast } from "../ui/toast";
import { Icon } from "../ui/icon";

export function TableFilterBar({ connId, table, cols, disabled, busy = disabled, transactions, onApply, timeoutSec, onTimeout }: {
  connId: string; table: string; cols: ColumnInfo[]; disabled: boolean;
  busy?: boolean; transactions?: ReactNode;
  onApply: (where: string, order: string, params: BoundCell[]) => void;
  /** 表页读取的等待上限（秒）。只作用于下一次查询，不重查、不丢未写回的改动。 */
  timeoutSec?: number; onTimeout?: (seconds: number) => void;
}) {
  // 上次编辑状态与上次查询结果成对恢复：切到「结构」再回来时，条件框和表格里的数据一致。
  const [savedView] = useState(() => loadFilterView(connId, table));
  const [filter, setFilter] = useState<TableFilter>(() => savedView?.filter ?? loadFilter(connId, table));
  const [advanced, setAdvanced] = useState(() => savedView?.advanced ?? false);
  const [raw, setRaw] = useState(savedView?.raw ?? { where:"", order:"" });
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const [error, setError] = useState("");
  const apply = () => {
    if (disabled) return;
    try { const q = advanced ? { ...raw, params:[] } : compileFilter(filter, cols); setError(""); onApply(q.where, q.order, q.params); saveFilterView(connId, table, { filter, advanced, raw }); }
    catch (e) { setExpanded(true); setError(String(e instanceof Error ? e.message : e)); }
  };
  let sql="", params="";
  try {const q=advanced ? {...raw,params:[]} : compileFilter(filter,cols);sql=`select * from ${table}${q.where ? " where "+q.where : ""}${q.order ? " order by "+q.order : ""}`;params=JSON.stringify(q.params);}catch{/* 未填完的条件由查询按钮报告。 */}
  const options = cols.map(c => <option key={c.name} value={c.name}>{c.zh ? `${c.zh} · ` : ""}{c.name.toLowerCase()}</option>);
  const quick = (column: string, value: string) => setFilter(f => ({...f, conditions:[...f.conditions, {column,op:"eq",value,end:""}]}));
  const summary = advanced
    ? `手写条件：${raw.where.trim() || "无 WHERE"}${raw.order.trim() ? ` · 排序 ${raw.order.trim()}` : ""}`
    : `${filter.conditions.length ? `${filter.conditions.length} 项条件 · ${filter.join === "and" ? "全部满足" : "任一满足"}` : "无筛选条件"} · ${filter.sort || "主键"}${filter.descending ? "降序" : "升序"}`;
  return <div className="dbx-filterbar" data-expanded={expanded}>
    <div className="dbx-filter-header">
      <button type="button" className="dbx-btn ghost" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(v => !v)}><Icon name={expanded ? "chevronDown" : "sliders"} size={14} />{expanded ? "收起筛选" : "展开筛选"}</button>
      <span className="dbx-filter-summary" title={`待查询：${summary}`}>待查询：{summary}</span>
      {onTimeout && <label className="dbx-muted" title="表页查询等多久没返回就中断；只对下一次查询生效">等待上限
        <select aria-label="表页查询等待上限" value={timeoutSec ?? 60} onChange={e => onTimeout(Number(e.target.value))}>
          {[30, 60, 120, 300, 600].map(s => <option key={s} value={s}>{s}s</option>)}
        </select>
      </label>}
      <button type="button" className="dbx-btn pri" disabled={disabled} aria-busy={busy} onClick={apply}><Icon name={busy ? "spinner" : "play"} size={12} />查询</button>
      {transactions}
    </div>
    <div id={bodyId} className="dbx-filter-body" hidden={!expanded}>
    <div className="dbx-filter-actions" role="group" aria-label="筛选方式">
      <button type="button" className="dbx-btn ghost" aria-pressed={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? "切换可视化条件" : "手写 WHERE"}</button>
    </div>
    {!advanced && <div className="dbx-filter-actions" role="group" aria-label="编辑筛选条件">
      <button type="button" className="dbx-btn" disabled={!cols.length || disabled} onClick={() => quick(cols[0].name, "")}>添加条件</button>
      <select aria-label="条件组合" value={filter.join} onChange={e => setFilter({...filter,join:e.target.value as TableFilter["join"]})}><option value="and">全部满足 AND</option><option value="or">任一满足 OR</option></select>
      {(cols.some(c => ["dr", "pk_org", "code", "ts"].includes(c.name.toLowerCase()))) && <details className="dbx-filter-shortcuts">
        <summary>常用字段</summary>
        <div className="dbx-filter-actions">
          {cols.find(c => c.name.toLowerCase() === "dr") && <button type="button" className="dbx-btn" onClick={() => quick(cols.find(c => c.name.toLowerCase() === "dr")!.name, "0")}>未删除 dr=0</button>}
          {cols.filter(c => ["pk_org","code","ts"].includes(c.name.toLowerCase())).map(c => <button key={c.name} type="button" className="dbx-btn" onClick={() => quick(c.name, "")}>{c.zh || c.name.toLowerCase()}</button>)}
        </div>
      </details>}
    </div>}
    {advanced ? <div className="dbx-condition"><label>WHERE<input className="dbx-inp mono" value={raw.where} onChange={e => setRaw({...raw,where:e.target.value})} onKeyDown={e => e.key === "Enter" && apply()} /></label><label>ORDER BY<input className="dbx-inp mono" value={raw.order} onChange={e => setRaw({...raw,order:e.target.value})} onKeyDown={e => e.key === "Enter" && apply()} /></label></div> : <>
      {filter.conditions.map((c,i) => {
        const update = (patch: Partial<typeof c>) => setFilter({...filter,conditions:filter.conditions.map((v,k) => k===i ? {...v,...patch} : v)});
        const type = cols.find(v => v.name === c.column)?.type ?? "";
        const input = /^(DATE|TIMESTAMP)/i.test(type) ? "datetime-local" : /^(NUMBER|INTEGER|DECIMAL|FLOAT)/i.test(type) ? "number" : "text";
        return <div className="dbx-condition" key={i}>
          <select aria-label={`条件 ${i+1} 字段`} value={c.column} onChange={e => update({column:e.target.value})}>{options}</select>
          <select aria-label={`条件 ${i+1} 运算符`} value={c.op} onChange={e => update({op:e.target.value as typeof c.op})}><option value="eq">等于</option><option value="ne">不等于</option><option value="gt">大于</option><option value="gte">大于等于</option><option value="lt">小于</option><option value="lte">小于等于</option><option value="in">属于 IN</option><option value="contains" disabled={input !== "text"}>包含（文本）</option><option value="between">区间</option><option value="null">为空 NULL</option><option value="notnull">非空 NOT NULL</option><option value="today" disabled={input !== "datetime-local"}>今天（本机日期）</option><option value="last7days" disabled={input !== "datetime-local"}>近7天（含今天）</option></select>
          {!["null","notnull","today","last7days"].includes(c.op) && <input aria-label={`条件 ${i+1} 值`} className="dbx-inp" type={c.op === "in" ? "text" : input} placeholder={c.op === "in" ? "多个值用逗号分隔" : undefined} value={c.value} onChange={e => update({value:e.target.value})} onKeyDown={e => e.key === "Enter" && apply()} />}
          {c.op === "between" && <input aria-label={`条件 ${i+1} 区间终点`} className="dbx-inp" type={input} value={c.end} onChange={e => update({end:e.target.value})} />}
          <button type="button" className="dbx-ibtn" title={`删除条件 ${i+1}`} aria-label={`删除条件 ${i+1}`} onClick={() => setFilter({...filter,conditions:filter.conditions.filter((_,k) => k!==i)})}><Icon name="trash" size={14} /></button>
        </div>;
      })}
      <div className="dbx-condition"><label>排序<select aria-label="排序字段" value={filter.sort} onChange={e => setFilter({...filter,sort:e.target.value})}><option value="">默认主键排序</option>{options}</select></label><select aria-label="排序方向" value={filter.descending ? "desc" : "asc"} onChange={e => setFilter({...filter,descending:e.target.value === "desc"})}><option value="asc">升序</option><option value="desc">降序</option></select></div>
    </>}
    <div className="dbx-filter-actions dbx-filter-secondary" role="group" aria-label="筛选管理">
      <button type="button" className="dbx-btn ghost" onClick={() => { setFilter(emptyFilter()); setRaw({where:"",order:""}); setError(""); }}>清空条件</button>
      {!advanced && <button type="button" className="dbx-btn ghost" onClick={() => { try { compileFilter(filter,cols); saveFilter(connId,table,filter); toast("已保存常用筛选", "success"); } catch(e) { setError(String(e instanceof Error ? e.message : e)); } }}>保存常用筛选</button>}
    </div>
    <details className="dbx-filter-sql"><summary>查看查询 SQL 与绑定参数</summary><CodePreview text={sql || "请先补全条件"} label="筛选 SQL" connId={connId}/>{params && <code>绑定参数：{params}</code>}</details>
    </div>
    {error && <p className="dbx-err" role="alert">{error}</p>}
  </div>;
}
