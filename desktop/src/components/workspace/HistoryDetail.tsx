// 预览、确认和差异展开量属于所选版本；写盘锁属于整个工作台，卸载也必须最终解锁。
// 嵌入模式比较当前编辑内容，恢复仍以磁盘 mtime 为基准并要求没有未保存修改。
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
import { getSession } from "../../lib/workspaceSession";
import { isUnsaved } from "../../lib/tabDirty";
import { isModelDirty } from "../../lib/editorStore";
import { useHistoryEditorText } from "../../hooks/useHistoryEditorText";
import { operationActive } from "../../lib/operations";
import { beginHistoryRestore, endHistoryRestore, useHistoryRestorePath, isHistoryRestoring } from "../../lib/historyRestoreGuard";

/** diff 最多渲染这么多行（折叠后通常远少于这个数；防超大文件卡死渲染）。 */
const MAX_DIFF_ITEMS = 400;

/** readFile 会把换行归一成 \n，历史版本是原字节——比之前必须两边都归一，否则 CRLF 文件每行都像改过。 */
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const scrollPositions = new Map<string, number>();

interface Props {
  embedded?: boolean;
  path: string;
  versionId: string;
  /** 磁盘快照：恢复 mtime 基准；没有编辑模型时也作为比较右侧。 */
  current: FileContent;
  /** 文件有未保存修改：禁用恢复（先保存或还原） */
  dirty: boolean;
  /** 恢复写盘中：外层据此禁用关闭与切换版本 */
  onBusyChange: (busy: boolean) => void;
  /** 恢复成功后立刻调用（父组件重载编辑器文件） */
  onFileChanged: () => Promise<void> | void;
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
  embedded = false,
}: Props) {
  const [preview, setPreview] = useState<VersionPreview | null>(null);
  const [phase, setPhase] = useState<"idle" | "confirm" | "restoring">("idle");
  const [error, setError] = useState<string | null>(null);
  const [diffLimit, setDiffLimit] = useState(MAX_DIFF_ITEMS);
  const restoring = useRef(false);
  const editorText = useHistoryEditorText(path, embedded);
  useHistoryRestorePath();
  const busy = phase === "restoring" || isHistoryRestoring(path);

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
    const tab = getSession().tabs.find(t => t.path === path);
    if (dirty || (tab && isUnsaved(tab)) || isModelDirty(path) || restoring.current) return;
    if (operationActive("workspace.switch") || operationActive(`file.save:${path.toLowerCase()}`) || operationActive(`file.reload:${path.toLowerCase()}`)) { setError("工程或文件正在切换、保存或重新加载，请完成后再恢复"); return; }
    if (!beginHistoryRestore(path)) return;
    // 同一帧的重复点击也必须锁住，不能只依赖下一次渲染的按钮状态。
    restoring.current = true;
    setPhase("restoring");
    setError(null);
    onBusyChange(true);
    try {
      await restoreLocalHistory(path, versionId, current.mtimeMs);
      toast("已恢复历史版本", "success");
      await onFileChanged();
      // 恢复前后端会把「恢复前的内容」也归档一版，列表和磁盘快照都要重取
      const [vs, fc] = await Promise.all([listLocalHistory(path), readFile(path)]);
      onRestored(vs, fc);
    } catch (e) {
      setError(String(e));
      setPhase("idle");
      onBusyChange(false);
    } finally {
      restoring.current = false;
      onBusyChange(false);
      endHistoryRestore();
    }
  };

  const diff =
    preview?.text != null ? diffLines(norm(preview.text), norm(editorText ?? current.text)) : null;
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
          <span>{embedded && editorText !== undefined ? "与当前编辑内容的差异" : "与当前磁盘内容的差异"}</span>
          <span className="wb-hist-changes">
            <em className="wb-hist-add">+{changes.added}</em>
            <em className="wb-hist-del">−{changes.removed}</em>
          </span>
        </div>
      )}
      {diff?.tooBig && <div className="wb-hist-note">差异太大，只显示版本大小，可直接恢复。</div>}
      <div className="wb-hist-diff" ref={node => { if (node && embedded) node.scrollTop = scrollPositions.get(`${path}:${versionId}`) ?? 0; }} onScroll={event => { if (embedded) scrollPositions.set(`${path}:${versionId}`, event.currentTarget.scrollTop); }}>
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
        {busy ? <span className="wb-hist-note">恢复中…</span> : dirty ? (
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
