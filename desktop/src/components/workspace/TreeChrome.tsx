import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/icon";
import { baseName } from "../../lib/workspace";
import { deleteDescription } from "../../lib/treeDeleteText";
import type { PendingDelete } from "./useTreeDelete";

/**
 * 文件树的两块"外框"：speed search 的筛选条与删除确认框。
 *
 * 单独拆出来是因为 FileTree 已经贴着单文件体量上限，而这两块都只是纯展示——
 * 判断逻辑分别在 `lib/treeNav`（筛选）与 `lib/treeDeleteText`（措辞）里，可单测。
 */
export function TreeFilterBar({
  filter,
  count,
  onClear,
}: {
  filter: string;
  count: number;
  onClear: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 6px",
        fontSize: 12,
        borderBottom: "1px solid var(--border)",
        color: "var(--muted-foreground)",
      }}
    >
      <Icon name="search" size={12} />
      <span style={{ flex: 1 }}>
        筛选：{filter}（{count} 项）
      </span>
      <button type="button" className="wb-icon-btn" title="清除筛选（Esc）" onClick={onClear}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

export function TreeViewFilters({ mode, onToggle }: {
  mode: "problems" | "changes" | null;
  onToggle: (mode: "problems" | "changes") => void;
}) {
  return <div className="wb-tree-problem-tools">
    <button type="button" className="wb-status-btn" aria-pressed={mode === "problems"}
      title="只显示有错误或警告的文件及所在目录" onClick={() => onToggle("problems")}>
      <Icon name="alertTriangle" size={13} />只看问题
    </button>
    <button type="button" className="wb-status-btn" aria-pressed={mode === "changes"}
      title="只显示有 SVN 改动的文件及所在目录" onClick={() => onToggle("changes")}>
      <Icon name="gitBranch" size={13} />只看改动
    </button>
  </div>;
}

/** 删除确认：正文由 `deleteDescription` 生成（文件数 / 打开中的标签 / 未保存 / 引用数）。 */
export function TreeDeleteConfirm({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingDelete | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open={pending !== null}
      title={`删除${pending?.isDir ? "文件夹" : "文件"} ${baseName(pending?.path ?? "")}？`}
      description={pending ? deleteDescription(pending) : undefined}
      variant="destructive"
      confirmLabel="删除"
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <div className="wb-danger-note">
        <Icon name="alertTriangle" size={13} />
        直接删除，不进回收站，无法撤销
      </div>
    </ConfirmDialog>
  );
}
