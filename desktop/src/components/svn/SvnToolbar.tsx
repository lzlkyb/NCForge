import { Icon } from "../ui/icon";
import { FreshnessBadge } from "../ui/FreshnessBadge";
import { Menu, MenuItem } from "../ui/Menu";
import type { SvnInfo } from "../../lib/svn";
import { SvnContextMenu } from "./SvnContextMenu";
import { openPatchPage } from "../../lib/svnSession";

/**
 * 版本控制页顶部工具条。
 *
 * 从 `SvnTab` 抽出来的原因很实在：那一页已经贴着 300 行门禁，而这里要塞第 5 个
 * 按钮（维护）。顺带把「按钮什么时候禁用、title 说什么」集中到一处——以前散在
 * 150 行 JSX 里，改一个禁用条件要在三处找。
 *
 * 窄窗口径保持原样（见 svn.css 末尾的 1180 / 1000 两档）：扫描时间先隐藏、
 * URL 再隐藏；刷新、更新、提交直接可达，撤销与维护放进更多菜单。
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
  info,
  pickedCount = committable,
  onHistory,
  onFiles,
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
  info?: SvnInfo;
  pickedCount?: number;
  onHistory?: () => void;
  onFiles?: () => void;
}) {
  return (
    <div className="vc-head">
      <div className="vc-heading"><h1>版本控制</h1><span className="vc-heading-rev">本地 r{rev > 0 ? rev : "?"}</span></div>
      {onFiles && <button type="button" className="vc-btn vc-btn-icon vc-files-toggle" aria-label="显示改动清单" title="显示改动清单" onClick={onFiles}><Icon name="panel" size={14} /></button>}
      <SvnContextMenu info={info} url={url} />
      <span className="vc-sp" />
      {shown !== null && <span className="vc-hint">{shown} 处改动</span>}
      {generatedAtMs !== null && (
        <FreshnessBadge
          state={fetching ? "loading" : "live"}
          at={generatedAtMs}
          label="扫描"
          staleAfterMs={300_000}
          className="vc-scan-freshness"
        />
      )}
      <button type="button" className="vc-btn" disabled={fetching} onClick={onRefresh}>
        <Icon name="refresh" size={13} className={fetching ? "animate-spin" : undefined} />
        {fetching ? (scanned === null ? "扫描中…" : `已扫 ${scanned} 条…`) : "刷新"}
      </button>
      {busy === "update" && <button type="button" className="vc-btn" disabled onClick={onUpdate}>
        <Icon name={busy === "update" ? "spinner" : "download"} size={13} className={busy === "update" ? "animate-spin" : undefined} />
        {busy === "update" ? "更新中…" : "更新"}
      </button>}
      <button
        type="button"
        className="vc-btn"
        data-commit-trigger
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
        准备提交 {pickedCount}
      </button>
      <Menu portal width="w-56" trigger={(open, toggle) => (
        <button
          type="button"
          className="vc-btn vc-btn-icon"
          data-on={open || hkOpen || undefined}
          aria-label="更多版本控制操作"
          aria-haspopup="menu"
          aria-expanded={open}
          title="撤销与备份维护"
          onClick={toggle}
        >
          <Icon name="more" size={14} />
        </button>
      )}>
        {(close) => (
          <>
            <MenuItem label="更新工作副本" icon="download" disabled={busy !== null} onClick={()=>{close();onUpdate();}} />
            {onHistory && <MenuItem label="工作副本历史" icon="history" onClick={() => { close(); onHistory(); }} />}
            <MenuItem label="打包 NC 补丁" icon="package" onClick={() => { close(); openPatchPage(); }} />
            <MenuItem
              label={<span title={revertTitle}>撤销当前改动</span>}
              icon="trash"
              disabled={!canRevert}
              onClick={() => { close(); onRevert(); }}
            />
            <MenuItem
              label="备份与审查标记维护"
              icon="settings"
              active={hkOpen}
              onClick={() => { close(); onHousekeeping(); }}
            />
          </>
        )}
      </Menu>
    </div>
  );
}
