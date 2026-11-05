import { Fragment } from "react";
import type { BmfDetail, BmfEntry, BmfIssue } from "../../lib/bmf";
import { MetaCanvas } from "./MetaCanvas";
import { MetaCompare } from "./MetaCompare";
import { MetaDetails } from "./MetaDetails";
import { MetaExcel } from "./MetaExcel";
import { MetaGenerate } from "./MetaGenerate";
import { MetaHistory } from "./MetaHistory";
import { MetaIssues } from "./MetaIssues";
import { MetaPublish } from "./MetaPublish";
import { MetaRefs } from "./MetaRefs";

export type MetaView =
  | "detail"
  | "canvas"
  | "compare"
  | "history"
  | "refs"
  | "issues"
  | "generate"
  | "excel"
  | "publish";

interface Props {
  view: MetaView;
  detail: BmfDetail | null;
  error: string | null;
  busy: boolean;
  issues: BmfIssue[];
  issueBusy: boolean;
  issueError: string | null;
  entries: BmfEntry[];
  onEdited: () => void;
  onOpenRefs: (path: string) => void;
}

/**
 * 元数据页的视图面板。每个视图持有自己按组件加载的状态（对比目标、历史、Excel 文件），
 * 所以统一按 `detail.path` 作 key：切换组件时整块重挂，旧组件的数据不会漏到新组件上。
 */
export function MetaViewPanel({
  view,
  detail,
  error,
  busy,
  issues,
  issueBusy,
  issueError,
  entries,
  onEdited,
  onOpenRefs,
}: Props) {
  return (
    <div
      className="meta-main-body"
      id="meta-view-panel"
      role="tabpanel"
      aria-labelledby={`meta-tab-${view}`}
    >
      {busy && <p className="meta-note">正在解析…</p>}
      {error && (
        <div className="meta-error-box">
          <strong>无法解析这个组件</strong>
          <pre>{error}</pre>
          <p className="meta-note m-0">
            文件仍在索引里；修好 XML 后点右上角「校验」重新加载，或在左栏点刷新重新索引。
          </p>
        </div>
      )}
      {!error && detail && (
        <Fragment key={detail.path}>
          {view === "detail" && <MetaDetails detail={detail} onEdited={onEdited} />}
          {view === "canvas" && <MetaCanvas detail={detail} onEdited={onEdited} />}
          {view === "compare" && <MetaCompare current={detail} entries={entries} />}
          {view === "history" && <MetaHistory current={detail} />}
          {view === "excel" && (
            <MetaExcel path={detail.path} component={detail.component.name} onEdited={onEdited} />
          )}
          {view === "refs" && <MetaRefs path={detail.path} onOpen={onOpenRefs} />}
          {view === "issues" && (
            <MetaIssues issues={issues} loading={issueBusy} error={issueError} />
          )}
          {view === "generate" && <MetaGenerate path={detail.path} component={detail.component.name} />}
          {view === "publish" && (
            <MetaPublish
              component={detail.component.name}
              module={detail.component.ownModule || detail.component.namespace}
              path={detail.path}
            />
          )}
        </Fragment>
      )}
    </div>
  );
}
