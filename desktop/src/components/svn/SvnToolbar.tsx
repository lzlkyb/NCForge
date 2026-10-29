import { Icon } from "../ui/icon";
import { formatRevTime } from "../../lib/svn";

/**
 * 版本控制页顶部工具条。
 *
 * 从 `SvnTab` 抽出来的原因很实在：那一页已经贴着 300 行门禁，而这里要塞第 5 个
 * 按钮（维护）。顺带把「按钮什么时候禁用、title 说什么」集中到一处——以前散在
 * 150 行 JSX 里，改一个禁用条件要在三处找。
 *
 * 窄窗口径保持原样（见 svn.css 末尾的 1180 / 1000 两档）：扫描时间先隐藏、
 * URL 再隐藏，五个按钮一个都不收——维护做成纯图标按钮就是为了这一刻。
 */
export function SvnToolbar({
  rev,
  url,
  generatedAtMs,
  shown,
  fetching,
  scanned,
  busy,
  canRevert,
  revertTitle,
  committable,
  conflicts,
  hkOpen,
  onRefresh,
  onUpdate,
  onRevert,
  onCommit,
  onHousekeeping,
}: {
  rev: number;
  url: string | null;
  /** 上次扫描时间（毫秒）；没有扫描结果时不显示那行提示。 */
  generatedAtMs: number | null;
  shown: number | null;
  fetching: boolean;
  scanned: number | null;
  busy: string | null;
  canRevert: boolean;
  revertTitle: string;
  committable: number;
  conflicts: number;
  hkOpen: boolean;
  onRefresh: () => void;
  onUpdate: () => void;
  onRevert: () => void;
  onCommit: () => void;
  onHousekeeping: () => void;
}) {
  return (
    <div className="vc-head">
      <h1>版本控制</h1>
      <span className="vc-rev">r{rev > 0 ? rev : "?"}</span>
      <span className="vc-url" title={url ?? ""}>
        {url ?? "正在识别工作副本…"}
      </span>
      <span className="vc-sp" />
      {generatedAtMs !== null && shown !== null && (
        <span className="vc-hint">
          {shown} 处改动 · 扫于 {formatRevTime(generatedAtMs)}
        </span>
      )}
      <button type="button" className="vc-btn" disabled={fetching} onClick={onRefresh}>
        <Icon name="refresh" size={13} className={fetching ? "animate-spin" : undefined} />
        {fetching ? (scanned === null ? "扫描中…" : `已扫 ${scanned} 条…`) : "刷新"}
      </button>
      <button type="button" className="vc-btn" disabled={busy !== null} onClick={onUpdate}>
        <Icon name="download" size={13} />
        {busy === "update" ? "更新中…" : "更新"}
      </button>
      <button
        type="button"
        className="vc-btn"
        disabled={!canRevert}
        onClick={onRevert}
        title={revertTitle}
      >
        <Icon name="trash" size={13} />
        撤销
      </button>
      <button
        type="button"
        className="vc-btn vc-btn-primary"
        // 有冲突时不再禁用：提交面板本来就会把冲突文件从清单里剔掉
        //（「将提交 N 个文件（不含 M 个冲突）」），按钮一禁，那套逻辑全成了不可达。
        disabled={busy !== null || committable === 0}
        onClick={onCommit}
        title={
          committable === 0
            ? "没有可提交的文件（只有冲突文件时要先解决冲突）"
            : conflicts > 0
              ? `可提交 ${committable} 个；${conflicts} 个冲突会被自动排除`
              : "勾选要提交的文件"
        }
      >
        <Icon name="upload" size={13} />
        提交 {committable}
      </button>
      {/* 维护：备份目录只增不删，得有个能删的入口（审查报告 P2-18 ⑧） */}
      <button
        type="button"
        className="vc-btn vc-btn-icon"
        data-on={hkOpen || undefined}
        onClick={onHousekeeping}
        title="备份与审查标记维护"
        aria-label="备份与审查标记维护"
      >
        <Icon name="settings" size={14} />
      </button>
    </div>
  );
}
