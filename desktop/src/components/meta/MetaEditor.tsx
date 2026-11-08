import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { BmfDetail, BmfIssue } from "../../lib/bmf";
import { locateMetaIssue, selectedMetaEntity, semanticPane, type MetaCanvasState, type MetaEditorState, type MetaMode, type MetaPane, type MetaSelection } from "../../lib/metaEditor";
import type { MetaStage } from "../../lib/metaDraft";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { MetaCanvas } from "./MetaCanvas";
import { MetaEditorDialogs, type MetaEditSession } from "./MetaEditorDialogs";
import { MetaEditDialog } from "./MetaEditDialog";
import { MetaEnumRelationSection } from "./MetaEnumRelationSection";
import { MetaFieldTable } from "./MetaFieldTable";
import { MetaInspector, type MetaEditTarget } from "./MetaInspector";
import { MetaIssues } from "./MetaIssues";
import { MetaOverview } from "./MetaOverview";
import { MetaPanel } from "./MetaPanel";
import { MetaSplitter } from "./MetaSplitter";
import { MetaSemanticPanel } from "./MetaSemanticPanel";

const MetaRefs = lazy(() => import("./MetaRefs").then((m) => ({ default: m.MetaRefs })));
const PANES: [MetaPane, string][] = [["fields", "属性字段"], ["interfaces", "接口与映射"], ["relations", "枚举与关系"], ["issues", "校验问题"], ["refs", "引用"], ["overview", "组件概览"]];

export function MetaEditor({ detail, sourceSha = detail.sha256, state, mode, issues, issueBusy, issueError, inspectorDrawer, inspectorOpen, inspectorWidth, onInspectorOpen, onInspectorWidth, onState, onEdited, onOpenRefs, onEditingChange, readBusy = false, onStage }: {
  detail: BmfDetail; state: MetaEditorState; mode: MetaMode; issues: BmfIssue[]; issueBusy: boolean; issueError: string | null;
  inspectorDrawer: boolean; inspectorOpen: boolean; inspectorWidth: number;
  onInspectorOpen: (open: boolean) => void; onInspectorWidth: (width: number) => void;
  onState: (patch: Partial<MetaEditorState>, render?: boolean) => void; onEdited: () => void; onOpenRefs: (path: string) => void;
  onEditingChange: (editing: boolean) => void;
  readBusy?: boolean;
  sourceSha?: string;
  onStage?: MetaStage;
}) {
  const [edit, setEdit] = useState<MetaEditSession | null>(null);
  const [subEditing, setSubEditing] = useState(false);
  const locked = !!edit || readBusy || subEditing;
  const editingCallback = useRef(onEditingChange);
  editingCallback.current = onEditingChange;
  useEffect(() => { editingCallback.current(!!edit || subEditing); return () => editingCallback.current(false); }, [edit, subEditing]);
  const entity = selectedMetaEntity(detail, state.selection);
  const selection = state.selection;
  const attrId = selection.kind === "attr" ? selection.attrId : selection.kind === "relation" ? detail.relations.find((r) => r.id === selection.relationId)?.srcAttrId ?? null : null;
  const callbacks = useRef({ onState, onInspectorOpen, locked, state, entity, detail });
  callbacks.current = { onState, onInspectorOpen, locked, state, entity, detail };
  const select = useCallback((selection: MetaSelection) => {
    const current = callbacks.current;
    if (current.locked) return;
    const previous = selectedMetaEntity(current.detail, current.state.selection);
    const next = selectedMetaEntity(current.detail, selection);
    const semantic = semanticPane(selection);
    current.onState({ selection, ...(semantic === "interfaces" || current.state.pane === "interfaces" ? { pane: semantic } : {}),
      ...(previous?.id !== next?.id ? { fieldScroll: { top: 0, left: 0 }, selectedFields: [] } : {}) });
  }, []);
  const inspect = useCallback(() => callbacks.current.onInspectorOpen(true), []);
  const editField = useCallback((id: string) => {
    const current = callbacks.current;
    const attr = current.entity?.attrs.find((a) => a.id === id);
    if (!attr || !current.entity || current.locked) return;
    select({ kind: "attr", entityId: current.entity.id, attrId: attr.id });
    setEdit({ kind: "field", entity: current.entity, attr });
    current.onInspectorOpen(true);
  }, [select]);
  const begin = (target: MetaEditTarget) => {
    if (locked) return;
    if (target === "field" && attrId) { editField(attrId); return; }
    if (target === "addField" && entity) { setEdit({ kind: "field", entity, attr: null }); onInspectorOpen(true); }
    if (target === "entity" && entity) setEdit({ kind: "entity", entity });
    if (target === "addEntity") setEdit({ kind: "entity", entity: null });
    if (target === "copy") setEdit({ kind: "copy" });
    if (target === "relation") {
      const relationId = state.selection.kind === "relation" ? state.selection.relationId : null;
      setEdit({ kind: "relation", relation: detail.relations.find((r) => r.id === relationId) });
    }
    if (target === "enum") {
      const id = state.selection.kind === "enum" ? state.selection.enumId : null;
      setEdit({ kind: "enum", en: detail.enums.find((e) => e.id === id) ?? null });
    }
  };
  const finish = () => { setEdit(null); if (!onStage) onEdited(); };
  const edited = () => { if (!onStage) onEdited(); };
  const reload = () => { setEdit(null); onEdited(); };
  const rememberCanvas = useCallback((canvas: MetaCanvasState) => callbacks.current.onState({ canvas }, false), []);
  const rememberScroll = useCallback((fieldScroll: { top: number; left: number }) => callbacks.current.onState({ fieldScroll }, false), []);
  const pane = (next: MetaPane) => { if (!locked) onState({ pane: next }); };
  const inspector = edit?.kind === "field" ? <>
    <div className="meta-inline-notice" role="status">{onStage ? "应用到当前文档草稿，可撤销；预览保存后写入文件。" : "编辑当前操作。预览后才能保存；取消会放弃本次输入。"}</div>
    <MetaEditDialog inline path={detail.path} sha={detail.sha256} entity={edit.entity} attr={edit.attr} detail={detail} onStage={onStage} onClose={() => setEdit(null)} onSaved={finish} onReload={reload} />
  </> : <MetaInspector detail={detail} sourceSha={sourceSha} selection={state.selection} issues={issues} onEdit={begin} onEdited={edited} onSelect={select} onStage={onStage} locked={readBusy}
    onEditingChange={setSubEditing} onOpenRefs={onOpenRefs} onReload={reload} />;

  const entityControl = <div className="meta-entity-switch"><label>实体<select aria-label="当前实体" value={entity?.id ?? ""} disabled={locked} onChange={(e) => select({ kind: "entity", entityId: e.target.value })}>
    {!detail.entities.length && <option value="">没有实体</option>}{detail.entities.map((e) => <option key={e.id} value={e.id}>{e.displayName || e.name} · {e.name}{e.isPrimary ? " · 主" : ""}</option>)}
    </select></label><Menu portal trigger={(open, toggle) => <button type="button" className="meta-link" disabled={locked} onClick={toggle} aria-label="实体操作" title="新增实体 / 实体属性" aria-haspopup="menu" aria-expanded={open}><Icon name="more" size={14} /></button>}>
      {close => <><MenuItem label="新增实体" icon="plus" onClick={() => { close(); begin("addEntity"); }} />
        <MenuItem label="实体属性" icon="sliders" disabled={!entity} onClick={() => { close(); if (entity) { select({ kind: "entity", entityId: entity.id }); inspect(); } }} /></>}
    </Menu></div>;
  return <div className={`meta-editor meta-mode-${mode}`} data-editing={!!edit || undefined}>
    <div className="meta-editor-content">
      {mode !== "fields" && <div className="meta-model-region" style={mode === "linked" ? { flexBasis: `${state.split * 100}%` } : undefined}>
        <MetaCanvas detail={detail} linked selection={state.selection} onSelect={select} initialState={state.canvas} onStateChange={rememberCanvas}
          locked={locked} onEdited={onEdited} onCreateRelation={(source, target) => setEdit({ kind: "relation", initial: { source, target: target ?? "" } })} />
      </div>}
      {mode === "linked" && <MetaSplitter label="调整模型和字段区域" value={state.split} min={0.25} max={0.75} horizontal ratio onChange={(split) => onState({ split })} onReset={() => onState({ split: 0.52 })} />}
      {mode !== "model" && <div className="meta-data-region">
        <nav className="meta-data-tabs" aria-label="元数据内容">{PANES.map(([key, title]) => <button type="button" key={key} disabled={locked} className={state.pane === key ? "is-active" : ""} aria-pressed={state.pane === key} onClick={() => pane(key)}>{title}{key === "issues" && issues.length > 0 && <span>{issues.length}</span>}</button>)}</nav>
        {state.pane === "fields" && <>
          {!entity && <div className="meta-fields-head">{entityControl}</div>}
          {entity ? <MetaFieldTable entity={entity} entityControl={entityControl} selectedAttrId={attrId} filter={state.filter} scroll={state.fieldScroll} locked={locked}
            onFilter={(filter) => onState({ filter, fieldScroll: { top: 0, left: 0 } })} onSelect={(id) => select({ kind: "attr", entityId: entity.id, attrId: id })}
            onInspect={inspect} onEdit={editField} onAdd={() => begin("addField")} onScroll={rememberScroll} detail={detail} onStage={onStage}
            selectedIds={state.selectedFields} onSelectedIds={(selectedFields) => onState({ selectedFields })} onEditingChange={setSubEditing}
            onBulk={onStage ? (action, ids, text) => setEdit({ kind: "bulk", action, entity, ids, text }) : undefined} /> : <div className="meta-editor-empty"><Icon name="layers" size={30} /><p>这个组件没有实体。可以查看接口、枚举与关系，或新增实体。</p><button type="button" className="meta-link" onClick={() => pane(detail.interfaces?.length ? "interfaces" : "relations")}>查看模型定义</button></div>}
        </>}
        {state.pane !== "fields" && <div className="meta-data-scroll">
          {state.pane === "relations" && <MetaEnumRelationSection detail={detail} onEdited={edited} selection={state.selection} onSelect={select} onStage={onStage} locked={readBusy} onEditingChange={setSubEditing} onReload={reload} />}
          {state.pane === "interfaces" && <MetaSemanticPanel detail={detail} selection={state.selection} onSelect={select} onStage={onStage} onEdited={edited} locked={readBusy} onEditingChange={setSubEditing} onOpenRefs={onOpenRefs} onReload={reload} />}
          {state.pane === "issues" && <MetaIssues issues={issues} loading={issueBusy} error={issueError}
            onLocate={(issue) => { const target = locateMetaIssue(detail, issue); if (target) { select(target); onState({ pane: semanticPane(target) }); inspect(); } }}
            canLocate={(issue) => !!locateMetaIssue(detail, issue)} />}
          {state.pane === "overview" && <><MetaOverview detail={detail} /><p className="meta-note">路径：{detail.path}</p><p className="meta-note">{detail.entities.length} 实体 · {detail.enums.length} 枚举 · {detail.relations.length} 关系</p></>}
          {state.pane === "refs" && <Suspense fallback={<p className="meta-note">正在加载引用工具…</p>}><MetaRefs path={detail.path} onOpen={onOpenRefs} /></Suspense>}
        </div>}
      </div>}
    </div>
    {!inspectorDrawer && <MetaSplitter label="调整属性检查器宽度" value={inspectorWidth} min={260} max={400} reverse onChange={onInspectorWidth} onReset={() => onInspectorWidth(280)} />}
    <MetaPanel side="inspector" label="属性检查器" drawer={inspectorDrawer} open={inspectorOpen} onClose={() => onInspectorOpen(false)}>
      <div ref={(node) => { if (node) node.inert = readBusy; }} aria-busy={readBusy}>{inspector}</div>
    </MetaPanel>
    <MetaEditorDialogs session={edit} detail={detail} onClose={() => setEdit(null)} onSaved={finish} onStage={onStage} onReload={reload} />
  </div>;
}
