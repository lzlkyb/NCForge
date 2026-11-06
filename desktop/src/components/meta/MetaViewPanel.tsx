import { lazy, Suspense, type ReactNode } from "react";
import type { BmfDetail, BmfEntry } from "../../lib/bmf";

const MetaCompare = lazy(() => import("./MetaCompare").then((m) => ({ default: m.MetaCompare })));
const MetaHistory = lazy(() => import("./MetaHistory").then((m) => ({ default: m.MetaHistory })));
const MetaExcel = lazy(() => import("./MetaExcel").then((m) => ({ default: m.MetaExcel })));
const MetaGenerate = lazy(() => import("./MetaGenerate").then((m) => ({ default: m.MetaGenerate })));
const MetaPublish = lazy(() => import("./MetaPublish").then((m) => ({ default: m.MetaPublish })));

export type MetaView = "detail" | "compare" | "history" | "generate" | "excel" | "publish";

/** 高频编辑区保留文档状态；低频工具按需加载，切组件时隔离工具内部输入。 */
export function MetaViewPanel({ view, detail, error, busy, entries, editor, onEdited }: {
  view: MetaView; detail: BmfDetail | null; error: string | null; busy: boolean; entries: BmfEntry[];
  editor: ReactNode; onEdited: () => void;
}) {
  return <div className={`meta-main-body ${view === "detail" ? "meta-main-editor" : ""}`} id="meta-view-panel" aria-label={view === "detail" ? "元数据编辑工作区" : "元数据工具"} aria-busy={busy}>
    {busy && <p className="meta-loading-note" role="status">正在解析…</p>}
    {error && <div className="meta-error-box"><strong>无法解析这个组件</strong><pre>{error}</pre><p className="meta-note m-0">修好 XML 后点右上角「校验」重新加载，或重新索引。</p></div>}
    {!error && detail && (view === "detail" ? editor : <Suspense key={detail.path} fallback={<p className="meta-note">正在加载工具…</p>}>
      {view === "compare" && <MetaCompare current={detail} entries={entries} />}
      {view === "history" && <MetaHistory current={detail} />}
      {view === "excel" && <MetaExcel path={detail.path} component={detail.component.name} onEdited={onEdited} />}
      {view === "generate" && <MetaGenerate path={detail.path} component={detail.component.name} />}
      {view === "publish" && <MetaPublish component={detail.component.name} module={detail.component.ownModule || detail.component.namespace} path={detail.path} />}
    </Suspense>)}
  </div>;
}
