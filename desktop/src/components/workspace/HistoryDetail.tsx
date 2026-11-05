// 「本地历史」的选中版本详情：与磁盘现状的 diff + 两步确认恢复。
//
// 从 HistoryPanel 拆出来：组件体量门禁限制单文件 useState/useEffect ≤ 8。
// 拆分边界也是状态边界——预览、差异渲染上限、恢复进度都只属于「当前选中那一版」，
// 换版本就该整体重置；父组件用 key={versionId} 让 React 直接重挂，比逐项 reset 可靠。
//
// 三条口径（与 HistoryPanel 文件头一致，动手前先看那段）：
// 1. diff 比的是磁盘现状，不是编辑器里没保存的内容；有未保存修改时禁用恢复。
// 2. 恢复是破坏性操作，但后端会先归档当前内容，所以确认框敢承诺「可再退回来」。
// 3. 恢复成功后父组件负责重载文件并换掉列表 / 磁盘快照。
import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { readFile, type FileContent } from "../../lib/workspace";
import { formatBytes } from "../../lib/utils";
import {
  listLocalHistory,
  readLocalHistory,
  restoreLocalHistory,
  type HistoryVersion,
  type VersionPreview,
} from "../../lib/localHistory";
import { collapseDiff, countChanges, diffLines } from "../../lib/textDiff";

/** diff 最多渲染这么多行（折叠后通常远少于这个数；防超大文件卡死渲染）。 */
const MAX_DIFF_ITEMS = 400;

/** readFile 会把换行归一成 \n，历史版本是原字节——比之前必须两边都归一，否则 CRLF 文件每行都像改过。 */
const norm = (s: string) => s.replace(/\r\n/g, "\n");

interface Props {
  path: string;
  versionId: string;
  /** 磁盘现状：diff 的右侧，也是恢复时的 mtime 冲突基准 */
  current: FileContent;
  /** 文件有未保存修改：禁用恢复（先保存或还原） */
  dirty: boolean;
  /** 恢复写盘中：外层据此禁用关闭与切换版本 */
  onBusyChange: (busy: boolean) => void;
  /** 恢复成功后立刻调用（父组件重载编辑器文件） */
  onFileChanged: () => void;
  /** 恢复成功且重新取数后调用（父组件换列表 / 磁盘快照、清选中） */
  onRestored: (versions: HistoryVersion[], current: FileContent) => void;
}

export function HistoryDetail({
  path,
  versionId,
  current,
  dirty,
  onBusyChange,
  onFileChanged,
  onRestored,
}: Props) {
  const [preview, setPreview] = useState<VersionPreview | null>(null);
  const [phase, setPhase] = useState<"idle" | "confirm" | "restoring">("idle");
  const [error, setError] = useState<string | null>(null);
  const [diffLimit, setDiffLimit] = useState(MAX_DIFF_ITEMS);
  const restoring = useRef(false);

  // 选中某版时读它的内容（组件按 versionId 重挂，这里只跑一次）
  useEffect(() => {
    let alive = true;
    readLocalHistory(path, versionId)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [path, versionId]);

  const doRestore = async () => {
    if (dirty || restoring.current) return;
    // 同一帧的重复点击也必须锁住，不能只依赖下一次渲染的按钮状态。
    restoring.current = true;
    setPhase("restoring");
    setError(null);
    onBusyChange(true);
    try {
      await restoreLocalHistory(path, versionId, current.mtimeMs);
      toast("已恢复历史版本", "success");
      onFileChanged();
      // 恢复前后端会把「恢复前的内容」也归档一版，列表和磁盘快照都要重取
      const [vs, fc] = await Promise.all([listLocalHistory(path), readFile(path)]);
      onRestored(vs, fc);
    } catch (e) {
      setError(String(e));
      setPhase("idle");
      onBusyChange(false);
    } finally {
      restoring.current = false;
    }
  };

  const diff =
    preview?.text != null ? diffLines(norm(preview.text), norm(current.text)) : null;
  const changes = diff ? countChanges(diff.rows) : null;
  const allItems = diff && !diff.tooBig ? collapseDiff(diff.rows) : [];
  const items = allItems.slice(0, diffLimit);

  return (
    <div className="wb-hist-detail">
      {preview === null && !error && <div className="wb-hist-note">读取中…</div>}
      {preview?.truncated && (
        <div className="wb-hist-note">这一版有 {formatBytes(preview.size)}，太大不做对比，可直接恢复。</div>
      )}
      {diff && changes && (
        <div className="wb-hist-diffhead">
          <span>与当前磁盘内容的差异</span>
          <span className="wb-hist-changes">
            <em className="wb-hist-add">+{changes.added}</em>
            <em className="wb-hist-del">−{changes.removed}</em>
          </span>
        </div>
      )}
      {diff?.tooBig && <div className="wb-hist-note">差异太大，只显示版本大小，可直接恢复。</div>}
      <div className="wb-hist-diff">
        {items.map((it, i) =>
          it.kind === "gap" ? (
            <div key={`g${i}`} className="wb-hist-gap">
              ⋯ {it.count} 行相同 ⋯
            </div>
          ) : (
            <div key={`r${i}`} className={`wb-hist-line wb-hist-${it.row.op}`}>
              <span className="wb-hist-ln">{it.row.oldLine ?? it.row.newLine ?? ""}</span>
              <span className="wb-hist-sign">
                {it.row.op === "add" ? "+" : it.row.op === "del" ? "−" : " "}
              </span>
              <span className="wb-hist-text">{it.row.text}</span>
            </div>
          ),
        )}
      </div>

      {allItems.length > diffLimit && <div className="wb-hist-note" role="status">
        仅展示前 {items.length} 项，共 {allItems.length} 项，后续差异尚未显示。
        <button type="button" className="wb-hist-restore" onClick={() => setDiffLimit(n => n + MAX_DIFF_ITEMS)}>继续显示差异</button>
      </div>}

      <div className="wb-hist-actions">
        {dirty ? (
          <span className="wb-hist-warn">文件有未保存的修改，先保存或还原后再恢复历史版本</span>
        ) : phase === "idle" ? (
          <button type="button" className="wb-hist-restore" onClick={() => setPhase("confirm")}>
            <Icon name="restore" size={12} />
            恢复此版本
          </button>
        ) : phase === "confirm" ? (
          <>
            <button type="button" className="wb-hist-restore" onClick={() => void doRestore()}>
              确认恢复？（当前内容会先自动存档）
            </button>
            <button type="button" className="wb-hist-cancel" onClick={() => setPhase("idle")}>
              取消
            </button>
          </>
        ) : (
          <span className="wb-hist-note">恢复中…</span>
        )}
      </div>

      {error && <div className="wb-hist-error">{error}</div>}
    </div>
  );
}
