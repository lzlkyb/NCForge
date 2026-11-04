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
import { toast } from "../ui/toast";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/EmptyState";
import { Icon } from "../ui/icon";
import { MetaDetails } from "./MetaDetails";
import { MetaGenerate } from "./MetaGenerate";
import { MetaIssues } from "./MetaIssues";
import { MetaNewDialog } from "./MetaNewDialog";
import { MetaPublish } from "./MetaPublish";
import { MetaTree } from "./MetaTree";
import "../../meta.css";

type View = "detail" | "issues" | "generate" | "publish";

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

/**
 * 元数据页（Ctrl+6；键位排在设置之后，见 App.tsx 的 HOTKEY_TABS）。
 *
 * 左侧组件清单、中间结构/校验/生成。检查器挂在字段表下方而不是常驻第三栏——
 * 「看字段」和「看某个字段的全部属性」是同一件事，常驻第三栏只会挤窄字段表。
 *
 * 读取全链路只读；唯一的写入口是编辑弹框与新建向导，两者都要用户点「保存」。
 */
export function MetaTab() {
  const [idx, setIdx] = useState<IndexState>({ data: null, loading: false });
  const [doc, setDoc] = useState<DocState>(EMPTY_DOC);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("detail");
  const [newOpen, setNewOpen] = useState(false);
  const pickSeq = useRef(0);

  const scan = useCallback(async (force: boolean): Promise<BmfIndex | null> => {
    setIdx((s) => ({ ...s, loading: true }));
    try {
      const data = await bmfIndexScan(force);
      setIdx({ data, loading: false });
      return data;
    } catch (e) {
      toast(`索引失败：${e}`, "error");
      setIdx((s) => ({ ...s, loading: false }));
      return null;
    }
  }, []);

  useEffect(() => {
    void scan(false);
  }, [scan]);

  const loadDetail = useCallback(async (entry: BmfEntry) => {
    const seq = ++pickSeq.current;
    setDoc((s) => ({ ...s, busy: true, error: null, issueBusy: true, issueError: null }));
    try {
      const detail = await bmfDetail(entry.path);
      if (seq !== pickSeq.current) return;
      setDoc((s) => ({ ...s, detail, busy: false }));
      try {
        const issues = await bmfValidate(entry.path);
        if (seq === pickSeq.current) setDoc((s) => ({ ...s, issues, issueBusy: false }));
      } catch (e) {
        if (seq === pickSeq.current) setDoc((s) => ({ ...s, issueError: String(e), issueBusy: false }));
      }
    } catch (e) {
      if (seq !== pickSeq.current) return;
      setDoc((s) => ({ ...s, detail: null, error: String(e), busy: false, issueBusy: false }));
    }
  }, []);

  const pick = (entry: BmfEntry) => {
    setDoc({ ...EMPTY_DOC, entry, error: entry.error });
    setView("detail");
    if (!entry.error) void loadDetail(entry);
  };

  const revalidate = async () => {
    if (!doc.entry) return;
    setDoc((s) => ({ ...s, issueBusy: true, issueError: null }));
    try {
      const issues = await bmfValidate(doc.entry.path);
      setDoc((s) => ({ ...s, issues, issueBusy: false }));
    } catch (e) {
      setDoc((s) => ({ ...s, issueError: String(e), issueBusy: false }));
    }
  };

  const counts = scoreboard(doc.issues);
  const entry = doc.entry;

  return (
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
            <header className="meta-main-head">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-[15px] font-semibold">{entry.displayName || entry.name}</h2>
                  <span className="meta-mono text-[11px] text-muted-foreground">{entry.name}</span>
                  {entry.error && <span className="meta-tag meta-tag-danger">解析失败</span>}
                </div>
                <div className="meta-path" title={entry.path}>
                  {entry.path}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="meta-sev-summary">
                  <span className="sev-error">{counts.error} 错误</span>
                  <span className="sev-warn">{counts.warn} 警告</span>
                  <span className="sev-info">{counts.info} 提示</span>
                </div>
                <Button size="sm" variant="outline" onClick={() => void revalidate()} disabled={doc.issueBusy}>
                  <Icon name="shield" size={13} /> 校验
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setNewOpen(true)}>
                  <Icon name="filePlus" size={13} /> 新建
                </Button>
              </div>
            </header>

            <nav className="meta-tabs">
              {(
                [
                  ["detail", "结构", doc.detail ? `${doc.detail.entities.length} 实体` : ""],
                  ["issues", "校验", `${doc.issues.length}`],
                  ["generate", "生成", "DDL / VO"],
                  ["publish", "发布 POC", "M3"],
                ] as [View, string, string][]
              ).map(([key, label, hint]) => (
                <button key={key} type="button" className={view === key ? "is-active" : ""} onClick={() => setView(key)}>
                  {label}
                  {hint && <span>{hint}</span>}
                </button>
              ))}
            </nav>

            <div className="meta-main-body">
              {doc.busy && <p className="meta-note">正在解析…</p>}
              {!doc.busy && doc.error && (
                <div className="meta-error-box">
                  <strong>无法解析这个组件</strong>
                  <pre>{doc.error}</pre>
                  <p className="meta-note m-0">文件仍在索引里；修好 XML 后点右上角「校验」或重新索引。</p>
                </div>
              )}
              {!doc.busy && !doc.error && doc.detail && (
                <>
                  {view === "detail" && <MetaDetails detail={doc.detail} onEdited={() => void loadDetail(entry)} />}
                  {view === "issues" && <MetaIssues issues={doc.issues} loading={doc.issueBusy} error={doc.issueError} />}
                  {view === "generate" && <MetaGenerate path={doc.detail.path} />}
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
              const created = data?.entries.find((e) => e.path === path);
              if (created) pick(created);
            });
          }}
        />
      )}
    </div>
  );
}

function scoreboard(issues: BmfIssue[]) {
  const c = { error: 0, warn: 0, info: 0 };
  for (const i of issues) {
    if (i.severity in c) c[i.severity as keyof typeof c]++;
  }
  return c;
}
