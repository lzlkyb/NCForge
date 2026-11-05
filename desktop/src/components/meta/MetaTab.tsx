import { useCallback, useEffect, useRef, useState } from "react";
import {
  bmfDetail,
  bmfIndexScan,
  bmfValidate,
  type BmfDetail,
  type BmfEntry,
  type BmfIndex,
  type BmfIssue,
} from "../../lib/bmf";
import { normalizeBmfPath } from "../../lib/bmfPath";
import { severityCounts } from "../../lib/bmfSummary";
import { toast } from "../ui/toast";
import { EmptyState } from "../ui/EmptyState";
import { DockRegion } from "../workspace/WorkbenchDock";
import { MetaCanvas } from "./MetaCanvas";
import { MetaCompare } from "./MetaCompare";
import { MetaDetails } from "./MetaDetails";
import { MetaGenerate } from "./MetaGenerate";
import { MetaHead } from "./MetaHead";
import { MetaIssues } from "./MetaIssues";
import { MetaNewDialog } from "./MetaNewDialog";
import { MetaPublish } from "./MetaPublish";
import { MetaRefs } from "./MetaRefs";
import { MetaTree } from "./MetaTree";
import "../../meta.css";

type View = "detail" | "canvas" | "compare" | "refs" | "issues" | "generate" | "publish";

interface IndexState {
  data: BmfIndex | null;
  loading: boolean;
}

interface DocState {
  entry: BmfEntry | null;
  detail: BmfDetail | null;
  error: string | null;
  busy: boolean;
  issues: BmfIssue[];
  issueBusy: boolean;
  issueError: string | null;
}

const EMPTY_DOC: DocState = {
  entry: null,
  detail: null,
  error: null,
  busy: false,
  issues: [],
  issueBusy: false,
  issueError: null,
};

const samePath = (a: string, b: string) => normalizeBmfPath(a) === normalizeBmfPath(b);
const sameEntry = (a: BmfEntry | null, b: BmfEntry) => !!a && samePath(a.path, b.path);

/**
 * 元数据页（Ctrl+6；键位排在设置之后，见 App.tsx 的 HOTKEY_TABS）。
 *
 * 左侧组件清单、中间结构/校验/生成。检查器挂在字段表下方而不是常驻第三栏——
 * 「看字段」和「看某个字段的全部属性」是同一件事，常驻第三栏只会挤窄字段表。
 *
 * 读取全链路只读；唯一的写入口是编辑弹框与新建向导，两者都要用户点「保存」。
 *
 * 内容停靠进 `document` 区：本页以前直接返回 `.meta-page`，在 WorkbenchFrame 里
 * 会变成 `.wb-content-frame` 的兄弟节点（占满整列、把工具栏顶走），而不是文档区内容。
 */
export function MetaTab() {
  const [idx, setIdx] = useState<IndexState>({ data: null, loading: false });
  const [doc, setDoc] = useState<DocState>(EMPTY_DOC);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("detail");
  const [newOpen, setNewOpen] = useState(false);
  // 两个独立令牌：详情加载与索引扫描互不取消，但同类请求只认最后一次。
  const pickSeq = useRef(0);
  const scanSeq = useRef(0);

  const scan = useCallback(async (force: boolean): Promise<BmfIndex | null> => {
    const seq = ++scanSeq.current;
    setIdx((s) => ({ ...s, loading: true }));
    try {
      const data = await bmfIndexScan(force);
      if (seq === scanSeq.current) setIdx({ data, loading: false });
      return data;
    } catch (e) {
      if (seq === scanSeq.current) {
        toast(`索引失败：${e}`, "error");
        setIdx((s) => ({ ...s, loading: false }));
      }
      return null;
    }
  }, []);

  useEffect(() => {
    void scan(false);
  }, [scan]);

  /**
   * 加载详情并校验。`seq` 之外再比对当前选中路径：坏文件与正常文件之间的快速
   * 切换、以及保存后的刷新，都可能让旧请求晚到；只认「还是同一个文件」的结果。
   */
  const loadDetail = useCallback(async (target: BmfEntry) => {
    const seq = ++pickSeq.current;
    setDoc((s) => (sameEntry(s.entry, target) ? { ...s, busy: true, error: null, issueBusy: true, issueError: null } : s));
    try {
      const detail = await bmfDetail(target.path);
      if (seq !== pickSeq.current) return;
      setDoc((s) => (sameEntry(s.entry, target) ? { ...s, detail, busy: false, error: null } : s));
      try {
        const issues = await bmfValidate(target.path);
        if (seq === pickSeq.current) setDoc((s) => (sameEntry(s.entry, target) ? { ...s, issues, issueBusy: false } : s));
      } catch (e) {
        if (seq === pickSeq.current) setDoc((s) => (sameEntry(s.entry, target) ? { ...s, issueError: String(e), issueBusy: false } : s));
      }
    } catch (e) {
      if (seq !== pickSeq.current) return;
      setDoc((s) => (sameEntry(s.entry, target) ? { ...s, detail: null, error: String(e), busy: false, issueBusy: false } : s));
    }
  }, []);

  const pick = useCallback(
    (entry: BmfEntry) => {
      // 坏文件也要推进令牌：否则上一个正常文件的详情请求晚到，会把「解析失败」
      // 的页面覆盖成另一个文件的字段表。
      pickSeq.current++;
      setDoc({ ...EMPTY_DOC, entry, error: entry.error });
      setView("detail");
      if (!entry.error) void loadDetail(entry);
    },
    [loadDetail],
  );

  /**
   * 右上角「校验」= 重新读盘 + 重新校验。只调 bmfValidate 的话，解析失败 / 文件被
   * 删除 / SHA 冲突之后无论如何都恢复不了——用户按提示「修好后点校验」也没用。
   */
  const revalidate = useCallback(() => {
    if (doc.entry) void loadDetail(doc.entry);
  }, [doc.entry, loadDetail]);

  /** 保存后：重扫索引（字段数变了）并刷新详情；选中项按路径对齐，不用旧对象。 */
  const refreshAfterEdit = useCallback(async () => {
    const before = doc.entry;
    if (!before) return;
    const data = await scan(false);
    const fresh = data?.entries.find((e) => samePath(e.path, before.path));
    if (fresh) {
      setDoc((s) => (sameEntry(s.entry, before) ? { ...s, entry: fresh } : s));
      void loadDetail(fresh);
    } else {
      void loadDetail(before);
    }
  }, [doc.entry, scan, loadDetail]);

  const counts = severityCounts(doc.issues);
  const entry = doc.entry;

  return (
    <DockRegion region="document">
      <div className="meta-page">
      <MetaTree
        entries={idx.data?.entries ?? []}
        selected={entry?.path ?? null}
        search={search}
        onSearch={setSearch}
        onSelect={pick}
        onRefresh={() => void scan(true)}
        onNew={() => setNewOpen(true)}
        refreshing={idx.loading}
        elapsedMs={idx.data?.elapsedMs ?? 0}
        cached={idx.data?.cached ?? 0}
        warnings={idx.data?.warnings ?? []}
      />

      <section className="meta-main">
        {!entry ? (
          <EmptyState
            icon="layers"
            bigIconSize={72}
            iconSize={24}
            description="选一个 BMF 组件开始。索引只扫工作区与链接工程，不会碰 NC 安装目录。"
            className="h-full"
          />
        ) : (
          <>
            <MetaHead
              entry={entry}
              counts={counts}
              busy={doc.busy}
              onRevalidate={revalidate}
              onNew={() => setNewOpen(true)}
            />

            <nav className="meta-tabs" role="tablist" aria-label="元数据视图">
              {(
                [
                  ["detail", "结构", doc.detail ? `${doc.detail.entities.length} 实体` : ""],
                  ["canvas", "画布", "ER"],
                  ["compare", "对比", "字段级"],
                  ["refs", "引用", "跨工程"],
                  ["issues", "校验", `${doc.issues.length}`],
                  ["generate", "生成", "DDL / VO"],
                  ["publish", "发布 POC", "M3"],
                ] as [View, string, string][]
              ).map(([key, label, hint]) => (
                <button
                  key={key}
                  id={`meta-tab-${key}`}
                  type="button"
                  role="tab"
                  aria-selected={view === key}
                  aria-controls="meta-view-panel"
                  tabIndex={view === key ? 0 : -1}
                  className={view === key ? "is-active" : ""}
                  onClick={() => setView(key)}
                >
                  {label}
                  {hint && <span>{hint}</span>}
                </button>
              ))}
            </nav>

            <div
              className="meta-main-body"
              id="meta-view-panel"
              role="tabpanel"
              aria-labelledby={`meta-tab-${view}`}
            >
              {doc.busy && <p className="meta-note">正在解析…</p>}
              {doc.error && (
                <div className="meta-error-box">
                  <strong>无法解析这个组件</strong>
                  <pre>{doc.error}</pre>
                  <p className="meta-note m-0">
                    文件仍在索引里；修好 XML 后点右上角「校验」重新加载，或在左栏点刷新重新索引。
                  </p>
                </div>
              )}
              {!doc.error && doc.detail && (
                <>
                  {view === "detail" && <MetaDetails detail={doc.detail} onEdited={() => void refreshAfterEdit()} />}
                  {view === "canvas" && (
                    <MetaCanvas detail={doc.detail} onEdited={() => void refreshAfterEdit()} />
                  )}
                  {view === "compare" && (
                    <MetaCompare current={doc.detail} entries={idx.data?.entries ?? []} />
                  )}
                  {view === "refs" && (
                    <MetaRefs
                      path={doc.detail.path}
                      onOpen={(p) => {
                        const target = idx.data?.entries.find((e) => samePath(e.path, p));
                        if (target) {
                          void loadDetail(target);
                          setView("detail");
                        }
                      }}
                    />
                  )}
                  {view === "issues" && <MetaIssues issues={doc.issues} loading={doc.issueBusy} error={doc.issueError} />}
                  {view === "generate" && (
                    <MetaGenerate path={doc.detail.path} component={doc.detail.component.name} />
                  )}
                  {view === "publish" && (
                    <MetaPublish
                      component={doc.detail.component.name}
                      module={doc.detail.component.ownModule || doc.detail.component.namespace}
                      path={doc.detail.path}
                    />
                  )}
                </>
              )}
            </div>
          </>
        )}
      </section>

      {newOpen && (
        <MetaNewDialog
          open
          onClose={() => setNewOpen(false)}
          onCreated={(path) => {
            setNewOpen(false);
            void scan(false).then((data) => {
              const created = data?.entries.find((e) => samePath(e.path, path));
              if (created) {
                setSearch("");
                pick(created);
              } else {
                toast("文件已创建，但索引里没有找到它；确认它位于 METADATA 目录下", "info");
              }
            });
          }}
        />
      )}
      </div>
    </DockRegion>
  );
}
