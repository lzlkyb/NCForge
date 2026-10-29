import { languageOf, type EncodingMark } from "../../lib/workspace";
import type { TabMeta } from "../../lib/workspaceSession";
import { useCursor } from "../../lib/cursorStore";
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
  saving,
  panelOpen,
  onTogglePanel,
}: {
  root: string;
  active: TabMeta | null;
  mark: EncodingMark | undefined;
  /** 正在写盘。大文件保存要几秒，没有进行态就像「按了没反应」。 */
  saving: boolean;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  // 光标自己订阅（lib/cursorStore）：它每秒可能变几十次，
  // 挂在父组件上会拖着整棵文件树一起重渲染。
  const cursor = useCursor();
  return (
    <footer className="wb-status">
      <span className="wb-status-path" title={active?.path}>
        {active ? (active.virtual ? `${active.name} · jar 内` : active.path) : root}
      </span>
      <LangBadge activePath={active && !active.virtual ? active.path : null} />
      <span className="wb-status-sp" />
      {saving && <span className="wb-status-warn">保存中…</span>}
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
