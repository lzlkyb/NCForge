import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { bmfIndexScan, type BmfIndex } from "../../lib/bmf";
import { normalizeBmfPath } from "../../lib/bmfPath";
import { severityCounts } from "../../lib/bmfSummary";
import { selectedMetaEntity, semanticPane, type MetaEditorState } from "../../lib/metaEditor";
import { draftChanged, newMetaDraft } from "../../lib/metaDraft";
import { useMetaDraft } from "../../hooks/useMetaDraft";
import { useMetaDocuments } from "../../hooks/useMetaDocuments";
import { useMetaLayout } from "../../hooks/useMetaLayout";
import { toast } from "../ui/toast";
import { EmptyState } from "../ui/EmptyState";
import { DockRegion } from "../workspace/WorkbenchDock";
import { MetaDocumentTabs } from "./MetaDocumentTabs";
import { MetaDraftBar } from "./MetaDraftBar";
import { MetaDraftDialogs } from "./MetaDraftDialogs";
import { MetaEditor } from "./MetaEditor";
import { MetaHead } from "./MetaHead";
import { MetaNewDialog } from "./MetaNewDialog";
import { MetaPanel } from "./MetaPanel";
import { MetaSplitter } from "./MetaSplitter";
import { MetaToolbar } from "./MetaToolbar";
import { MetaTree } from "./MetaTree";
import { MetaViewPanel } from "./MetaViewPanel";
import "../../meta.css";
import "../../meta-editor.css";

/** 保留 document 停靠区；所有编辑沿用预览、SHA 核对与备份链路。 */
export function MetaTab() {
  const [idx, setIdx] = useState<{ data: BmfIndex | null; loading: boolean }>({ data: null, loading: false });
  const [search, setSearch] = useState("");
  const [panels, setPanels] = useState({ resources: false, inspector: false, new: false, editing: false, review: false, closing: null as string | null, closeAfterSave: null as string | null });
  const scanSeq = useRef({ value: 0 });
  const docs = useMetaDocuments();
  const layout = useMetaLayout();
  const doc = docs.active;
  const detail = doc?.draft.preview?.detail ?? doc?.detail ?? null;
  const issues = doc?.draft.preview?.detail.issues ?? doc?.issues ?? [];
  const locked = panels.editing || !!doc?.draft.busy;
  const current = useRef({ docs, doc, panels });
  current.current = { docs, doc, panels };
  const scan = useCallback(async (force: boolean): Promise<BmfIndex | null> => {
    const seq = ++scanSeq.current.value;
    setIdx((s) => ({ ...s, loading: true }));
    try {
      const data = await bmfIndexScan(force);
      if (seq === scanSeq.current.value) setIdx({ data, loading: false });
      return data;
    } catch (e) {
      if (seq === scanSeq.current.value) { toast(`索引失败：${e}`, "error"); setIdx((s) => ({ ...s, loading: false })); }
      return null;
    }
  }, []);
  useEffect(() => { const token = scanSeq.current; void scan(false); return () => { token.value++; }; }, [scan]);
  const draftActions = useMetaDraft({ base: doc?.detail ?? null, draft: doc?.draft ?? newMetaDraft(),
    onChange: (draft) => !!doc && docs.updateDraft(doc.key, draft, doc.instance),
    onSaved: (saved) => {
      if (!doc) return;
      docs.applyDraftSaved(doc.key, saved, doc.instance);
      setPanels((s) => ({ ...s, review: false, closeAfterSave: null }));
      if (panels.closeAfterSave === doc.key) docs.close(doc.key);
      void scan(false);
    }, onDiscard: () => { if (doc) void docs.refresh(doc.entry); },
  });
  const reviewDraft = async () => {
    if (locked || doc?.busy || !doc?.draft.steps.length) return;
    if (await draftActions.review()) setPanels((s) => ({ ...s, review: true }));
  };
  const closeDocument = (key: string) => {
    const target = docs.documents.find((d) => d.key === key);
    if (target && draftChanged(target.draft)) { docs.open(target.entry); setPanels((s) => ({ ...s, closing: key })); }
    else docs.close(key);
  };
  const updateState = useCallback((patch: Partial<MetaEditorState>, render = true) => {
    const currentDoc = current.current.doc;
    if (currentDoc) current.current.docs.updateUi(currentDoc.key, patch, render);
  }, []);
  const onEditingChange = useCallback((editing: boolean) => setPanels((s) => s.editing === editing ? s : { ...s, editing }), []);
  const onInspectorOpen = useCallback((inspector: boolean) => setPanels((s) => ({ ...s, inspector, resources: inspector ? false : s.resources })), []);
  const beforeEdit = doc?.entry;
  const refreshAfterEdit = useCallback(async () => {
    if (!beforeEdit) return;
    const data = await scan(false);
    const fresh = data?.entries.find((e) => normalizeBmfPath(e.path) === normalizeBmfPath(beforeEdit.path));
    // 回调捕获被编辑的文档；扫描期间切到其它标签也只刷新原文档。
    void current.current.docs.refresh(fresh ?? beforeEdit, true);
  }, [beforeEdit, scan]);
  const mode = doc ? layout.compact && !doc.ui.modeChosen && doc.ui.mode === "linked" ? "fields" : doc.ui.mode : "linked";
  const openRefs = (path: string) => {
    if (locked) return;
    const target = idx.data?.entries.find((entry) => normalizeBmfPath(entry.path) === normalizeBmfPath(path));
    if (target) { docs.open(target); docs.updateUi(normalizeBmfPath(target.path), { view: "detail", pane: "fields" }); }
    else toast("引用文件不在当前索引中，请重新索引后再试", "info");
  };
  const entity = detail && doc ? selectedMetaEntity(detail, doc.ui.selection) : null;
  return <DockRegion region="document"><div className="meta-page meta-workbench" ref={layout.ref}
    data-size={layout.compact ? "compact" : layout.resourceDrawer ? "small" : layout.inspectorDrawer ? "medium" : "wide"}
    style={{ "--meta-resource-width": `${layout.widths.resource}px`, "--meta-inspector-width": `${layout.widths.inspector}px` } as CSSProperties}
    onKeyDown={(e) => { if (!e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!locked) void reviewDraft(); } }}>
    <MetaPanel side="resource" label="元数据资源" drawer={layout.resourceDrawer} open={panels.resources} onClose={() => setPanels((s) => ({ ...s, resources: false }))}>
      <MetaTree entries={idx.data?.entries ?? []} selected={doc?.entry.path ?? null} search={search} onSearch={setSearch}
        onSelect={(entry) => { if (!locked) { docs.open(entry); setPanels((s) => ({ ...s, resources: false })); } }}
        onRefresh={() => void scan(true)} onNew={() => setPanels((s) => ({ ...s, new: true }))} refreshing={idx.loading}
        elapsedMs={idx.data?.elapsedMs ?? 0} cached={idx.data?.cached ?? 0} warnings={idx.data?.warnings ?? []}
        detail={detail} selection={doc?.ui.selection} locked={locked}
        onSelectObject={(selection) => updateState({ selection, view: "detail", fieldScroll: { top: 0, left: 0 }, pane: semanticPane(selection) })} />
    </MetaPanel>
    {!layout.resourceDrawer && <MetaSplitter label="调整资源栏宽度" value={layout.widths.resource} min={190} max={320} onChange={(resource) => layout.setWidths((s) => ({ ...s, resource }))} onReset={() => layout.setWidths((s) => ({ ...s, resource: 224 }))} />}
    <section className="meta-main">
      {!doc ? <><div className="meta-empty-toolbar"><button type="button" className="meta-link" onClick={() => setPanels((s) => ({ ...s, resources: true }))}>打开元数据资源</button></div>
        <EmptyState icon="layers" bigIconSize={72} iconSize={24} description="选一个 BMF 组件开始。索引只扫工作区与链接工程，不会碰 NC 安装目录。" className="h-full" /></> : <>
        <MetaDocumentTabs documents={docs.documents} active={doc.key} locked={locked} onSelect={(item) => docs.open(item.entry)} onClose={closeDocument} />
        <MetaHead entry={doc.entry} counts={severityCounts(issues)} busy={doc.busy} editing={locked}
          onRevalidate={() => void docs.refresh(doc.entry, true)} onNew={() => setPanels((s) => ({ ...s, new: true }))}
          onIssues={() => updateState({ view: "detail", pane: "issues", mode: mode === "model" ? "linked" : doc.ui.mode })} />
        <MetaToolbar state={doc.ui} mode={mode} locked={locked} dirty={draftChanged(doc.draft)} resourceDrawer={layout.resourceDrawer} inspectorDrawer={layout.inspectorDrawer} resourceOpen={panels.resources} inspectorOpen={panels.inspector}
          onState={updateState} onResources={() => setPanels((s) => ({ ...s, resources: true, inspector: false }))} onInspector={() => onInspectorOpen(true)} />
        <MetaDraftBar draft={doc.draft} locked={locked || doc.busy} onUndo={() => void draftActions.undo()} onRedo={() => void draftActions.redo()} onReview={() => void reviewDraft()} onDiscard={draftActions.discard} />
        <MetaViewPanel view={doc.ui.view} detail={detail} error={doc.error} busy={doc.busy} entries={idx.data?.entries ?? []} onEdited={() => void refreshAfterEdit()}
          editor={detail && <MetaEditor key={doc.key} detail={detail} sourceSha={doc.detail?.sha256} state={doc.ui} mode={mode} issues={issues} issueBusy={doc.issueBusy} issueError={doc.issueError}
            inspectorDrawer={layout.inspectorDrawer} inspectorOpen={panels.inspector} inspectorWidth={layout.widths.inspector}
            onInspectorOpen={onInspectorOpen} onInspectorWidth={(inspector) => layout.setWidths((s) => ({ ...s, inspector }))}
            onState={updateState} onEdited={() => void refreshAfterEdit()} onOpenRefs={openRefs} onEditingChange={onEditingChange} readBusy={doc.busy || doc.draft.busy} onStage={draftActions.stage} />} />
        <footer className="meta-document-status"><span>{doc.entry.origin} · {doc.entry.module || "未知模块"}</span><span>{doc.detail ? `${doc.detail.encoding} · ${doc.detail.eol}${doc.detail.bom ? " · BOM" : ""}` : ""}</span>
          <span>{panels.editing ? "当前操作编辑中" : doc.draft.busy ? "正在处理草稿" : draftChanged(doc.draft) ? `${doc.draft.steps.length} 步待保存` : doc.busy ? "正在读取文件" : doc.error ? "解析失败" : "与文件同步"}</span><span className="meta-status-object">{entity?.displayName || entity?.name || doc.entry.name}</span></footer>
        <MetaDraftDialogs draft={doc.draft} reviewOpen={panels.review} closing={docs.documents.find((d) => d.key === panels.closing) ?? null} locked={!!doc.draft.busy}
          onCancelReview={() => setPanels((s) => ({ ...s, review: false, closeAfterSave: null }))} onSave={() => void draftActions.save()}
          onCancelClose={() => setPanels((s) => ({ ...s, closing: null }))}
          onDiscardClose={() => { if (panels.closing) docs.close(panels.closing, true); setPanels((s) => ({ ...s, closing: null })); }}
          onReviewClose={() => { setPanels((s) => ({ ...s, closing: null, closeAfterSave: s.closing })); void reviewDraft(); }} />
      </>}
    </section>
    {panels.new && <MetaNewDialog open onClose={() => setPanels((s) => ({ ...s, new: false }))} onCreated={(path) => {
      setPanels((s) => ({ ...s, new: false }));
      void scan(false).then((data) => {
        const created = data?.entries.find((e) => normalizeBmfPath(e.path) === normalizeBmfPath(path));
        if (created) { setSearch(""); current.current.docs.open(created); }
        else toast("文件已创建，但索引里没有找到它；确认它位于 METADATA 目录下", "info");
      });
    }} />}
  </div></DockRegion>;
}
