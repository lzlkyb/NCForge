import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bmfDetailText,
  bmfHistory,
  bmfRevisionText,
  type BmfDetail,
  type BmfRevisionText,
} from "../../lib/bmf";
import { diffDetails, summarize } from "../../lib/bmfDiff";
import { formatHistoryTime } from "../../lib/historyFormat";
import type { HistoryEntry } from "../../lib/svnHistory";
import { Button } from "../ui/button";
import { MetaDiffRows } from "./MetaDiffRows";

const HISTORY_LIMIT = 50;

interface ListState {
  entries: HistoryEntry[];
  repositoryPath: string;
  loading: boolean;
  error: string | null;
}

interface RevisionState {
  revision: number | null;
  detail: BmfDetail | null;
  empty: boolean;
  loading: boolean;
  error: string | null;
}

const EMPTY_LIST: ListState = { entries: [], repositoryPath: "", loading: true, error: null };
const EMPTY_REVISION: RevisionState = {
  revision: null,
  detail: null,
  empty: false,
  loading: false,
  error: null,
};

/**
 * 版本历史（M7）：列出组件在 SVN 里的修订，选中一个就把该修订的 BMF 正文解析回来，
 * 用与「对比」页相同的字段级 diff 展示 **历史 → 当前**。
 *
 * 方向刻意是「旧 → 新」：新增 = 当前比这个修订多出来的，删除 = 当前已经没有了。
 * 历史正文只解析、不落盘；写回仍需走结构页的编辑弹框。
 */
export function MetaHistory({ current }: { current: BmfDetail }) {
  const [list, setList] = useState<ListState>(EMPTY_LIST);
  const [rev, setRev] = useState<RevisionState>(EMPTY_REVISION);
  const listSeq = useRef(0);
  const revSeq = useRef(0);

  const loadList = useCallback(async () => {
    const seq = ++listSeq.current;
    setList((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = await bmfHistory(current.path, HISTORY_LIMIT);
      if (seq === listSeq.current) {
        setList({ entries: result.entries, repositoryPath: result.repositoryPath, loading: false, error: null });
      }
    } catch (e) {
      if (seq === listSeq.current) {
        setList({ entries: [], repositoryPath: "", loading: false, error: String(e) });
      }
    }
  }, [current.path]);

  useEffect(() => {
    setRev(EMPTY_REVISION);
    void loadList();
  }, [loadList]);

  const pick = useCallback(
    async (entry: HistoryEntry) => {
      const seq = ++revSeq.current;
      setRev({ revision: entry.revision, detail: null, empty: false, loading: true, error: null });
      try {
        const text: BmfRevisionText = await bmfRevisionText(current.path, list.repositoryPath, entry.revision);
        if (seq !== revSeq.current) return;
        if (text.empty) {
          setRev({ revision: entry.revision, detail: null, empty: true, loading: false, error: null });
          return;
        }
        const detail = await bmfDetailText(current.path, text.text);
        if (seq === revSeq.current) {
          setRev({ revision: entry.revision, detail, empty: false, loading: false, error: null });
        }
      } catch (e) {
        if (seq === revSeq.current) {
          setRev({ revision: entry.revision, detail: null, empty: false, loading: false, error: String(e) });
        }
      }
    },
    [current.path, list.repositoryPath],
  );

  const rows = useMemo(() => (rev.detail ? diffDetails(rev.detail, current) : []), [rev.detail, current]);
  const sum = summarize(rows);
  const currentName = current.component.name;
  const pickedEntry = list.entries.find((e) => e.revision === rev.revision) ?? null;

  return (
    <div className="meta-history">
      <div className="meta-history-bar">
        <span className="meta-export-label">SVN 历史</span>
        <span className="meta-note m-0">
          选中一个修订，与当前 {currentName} 做字段级对比（历史 → 当前）。只读，不写任何文件。
        </span>
        {!list.loading && !list.error && (
          <Button size="sm" variant="outline" onClick={() => void loadList()}>
            刷新
          </Button>
        )}
      </div>

      {list.loading && <p className="meta-note">正在读取 SVN 历史…</p>}
      {list.error && (
        <div className="meta-error-box">
          <strong>读不到这个组件的历史</strong>
          <pre>{list.error}</pre>
          <p className="meta-note m-0">
            组件必须在 SVN 工作副本内（工作副本根由文件路径向上查找 `.svn`）；未纳管或桥不可用时会显示这条。
          </p>
        </div>
      )}

      {!list.loading && !list.error && (
        <div className="meta-history-body">
          <ol className="meta-history-list" aria-label="组件修订列表">
            {list.entries.length === 0 && <li className="meta-note">这个文件还没有提交记录。</li>}
            {list.entries.map((e) => {
              const when = formatHistoryTime(e.date);
              const copied = e.paths.find((p) => p.copyFromPath);
              return (
                <li key={e.revision}>
                  <button
                    type="button"
                    className={`meta-history-item${rev.revision === e.revision ? " is-active" : ""}`}
                    aria-pressed={rev.revision === e.revision}
                    onClick={() => void pick(e)}
                  >
                    <span className="meta-history-rev">r{e.revision}</span>
                    <span className="meta-history-msg">{e.message.split("\n")[0] || "（无提交说明）"}</span>
                    <span className="meta-history-meta" title={when.title}>
                      {e.author || "未知作者"} · {when.label}
                    </span>
                    {copied && (
                      <span className="meta-history-copy" title={`从 ${copied.copyFromPath}@r${copied.copyFromRevision} 复制`}>
                        复制自 {copied.copyFromPath}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>

          <section className="meta-history-diff" aria-label="历史版本与当前的结构差异">
            {!rev.revision && <p className="meta-note">从左边选一个修订。</p>}
            {rev.loading && <p className="meta-note">正在读取 r{rev.revision} 的正文并解析…</p>}
            {rev.error && <p className="meta-error">{rev.error}</p>}
            {rev.empty && (
              <p className="meta-note">r{rev.revision} 里没有这个文件（通常是该修订中它被删除了）。</p>
            )}
            {rev.detail && rev.revision !== null && (
              <>
                <div className="meta-compare-bar">
                  <span className="meta-note m-0">
                    r{rev.revision}
                    {pickedEntry ? `（${formatHistoryTime(pickedEntry.date).title}）` : ""} → 当前
                  </span>
                  {rows.length > 0 && (
                    <span className="meta-compare-sum">
                      <span className="is-added">+{sum.added}</span>
                      <span className="is-removed">−{sum.removed}</span>
                      <span className="is-changed">~{sum.changed}</span>
                    </span>
                  )}
                </div>
                {rows.length === 0 ? (
                  <p className="meta-note">r{rev.revision} 与当前文件的语义结构一致。</p>
                ) : (
                  <>
                    <p className="meta-note m-0">新增 = 当前比这个修订多出来的；删除 = 当前已经没有。</p>
                    <MetaDiffRows rows={rows} />
                  </>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
