import { languageOf, type EncodingMark } from "../../lib/workspace";
import type { TabMeta } from "../../lib/workspaceSession";
import { LangBadge } from "./LangBadge";

/**
 * 编辑器底部状态栏。
 *
 * 「Eclipse 按 GBK 读」这条只在树里标了号的 SQL 上出现：它的意义是提醒
 * 「用 Eclipse 编译这个文件会烂」，而工作台自己的产物是对的。
 */
export function EditorStatus({
  root,
  active,
  mark,
  cursor,
  panelOpen,
  onTogglePanel,
}: {
  root: string;
  active: TabMeta | null;
  mark: EncodingMark | undefined;
  cursor: { line: number; column: number };
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  return (
    <footer className="wb-status">
      <span className="wb-status-path" title={active?.path}>
        {active ? (active.virtual ? `${active.name} · jar 内` : active.path) : root}
      </span>
      <LangBadge activePath={active && !active.virtual ? active.path : null} />
      <span className="wb-status-sp" />
      <button type="button" className="wb-status-btn" onClick={onTogglePanel}>
        {panelOpen ? "隐藏面板" : "显示面板"}
      </button>
      {active && (
        <>
          <span>{active.virtual ? "java" : languageOf(active.path)}</span>
          {mark && (
            <span
              className="wb-status-enc"
              title={
                mark.registered
                  ? `磁盘内容是 UTF-8，但 Eclipse 偏好里登记为 ${mark.registered}`
                  : "磁盘内容是 UTF-8，但 Eclipse 偏好里没有登记，Eclipse 按工程默认的 GBK 读"
              }
            >
              Eclipse 按 GBK 读
            </span>
          )}
          <span>{active.encoding}{active.hasBom ? " BOM" : ""}</span>
          <span className={active.eolChanged ? "wb-status-warn" : undefined}>{active.eol}</span>
          <span>
            第 {cursor.line} 行，第 {cursor.column} 列
          </span>
        </>
      )}
    </footer>
  );
}
