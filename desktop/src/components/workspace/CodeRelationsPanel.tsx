import { useState } from "react";
import { CallHierarchyPanel } from "./CallHierarchyPanel";
import { TypeHierarchyPanel } from "./TypeHierarchyPanel";
import { useRelationView, selectRelationView, type RelationView } from "../../lib/codeRelations";
import { useNavigationResult, openNavigation, chooseNavigationTarget } from "../../lib/navigationService";
import { filterNavigationTargets } from "../../lib/navigationTargets";
import { openCallHierarchy } from "../../lib/callHierarchy";
import { openTypeHierarchy } from "../../lib/typeHierarchy";
const VIEWS: { id: RelationView; label: string }[] = [{ id: "references", label: "引用" }, { id: "calls", label: "调用" }, { id: "types", label: "继承" }, { id: "assembly", label: "NC 装配" }];
export function CodeRelationsPanel({ legacy }: { legacy?: "calls" | "types" }) {
  const chosen = useRelationView(), view = legacy ?? chosen, state = useNavigationResult(view === "assembly" ? "assembly" : "references");
  const [filter, setFilter] = useState({ query: "", scope: "all", module: "all", access: "all" });
  const refresh = () => view === "calls" ? openCallHierarchy() : view === "types" ? openTypeHierarchy() : openNavigation(view === "assembly" ? "assembly" : "references");
  const targets = state.kind === view ? filterNavigationTargets(state.items, filter.query, filter.scope, filter.module, view === "references" ? filter.access : "all") : [];
  return <div className="wb-panel-body">
    <div className="wb-panel-note" role="group" aria-label="代码关系视图">{VIEWS.map(item => <button key={item.id} type="button" className="wb-status-btn" aria-pressed={view === item.id} onClick={() => selectRelationView(item.id)}>{item.label}</button>)}<button type="button" className="wb-status-btn" onClick={() => void refresh()}>查询当前光标</button></div>
    {view === "calls" ? <CallHierarchyPanel /> : view === "types" ? <TypeHierarchyPanel /> : <>
      <div className="nav-filter"><input aria-label="筛选代码关系" placeholder="筛选类名、模块或路径…" value={filter.query} onChange={event => setFilter(value => ({ ...value, query: event.target.value }))} /><select aria-label="代码关系来源" value={filter.scope} onChange={event => setFilter(value => ({ ...value, scope: event.target.value }))}><option value="all">全部来源</option><option value="source">源码</option><option value="library">依赖库</option><option value="assembly">NC 注册</option></select><select aria-label="代码关系模块" value={filter.module} onChange={event => setFilter(value => ({ ...value, module: event.target.value }))}><option value="all">全部模块</option>{[...new Set(state.items.map(target => target.module).filter(Boolean))].map(module => <option key={module} value={module}>{module}</option>)}</select></div>
      <div className="wb-panel-note">{state.kind === view && state.intent ? `${state.title} · ${targets.length} 处` : "将光标放到类、方法或字段上，点击查询。"}{state.kind === view && state.loading && " · 正在查询…"}</div>
      {view === "references" && state.items.some(target => target.access) && <select aria-label="字段引用读写" value={filter.access} onChange={event => setFilter(value => ({ ...value, access: event.target.value }))}><option value="all">全部读写</option><option value="read">读取（含读写）</option><option value="write">写入（含读写）</option><option value="unknown">未确认读写</option></select>}
      {state.kind === view && state.error && <div role="alert" className="wb-panel-note">{state.error}</div>}
      {state.kind === view && state.note && <div className="wb-panel-note">{state.note}</div>}
      {targets.map((target, index) => <button key={`${target.uri}:${index}`} type="button" className="wb-prow" title={target.source} onClick={() => void chooseNavigationTarget(target, false, state.intent)}><span className="wb-prow-msg">{target.label}<span className="wb-diag-path"> · {target.module ?? target.origin}{target.access && ` · ${{ read: "读取", write: "写入", readWrite: "读写", unknown: "读写未确认" }[target.access]}`}</span></span><span className="wb-prow-loc">{target.source}:{target.range.start.line + 1}</span></button>)}
    </>}
  </div>;
}
