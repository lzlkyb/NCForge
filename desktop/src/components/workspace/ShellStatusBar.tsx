import { type EncodingMark } from "../../lib/workspace";
import type { TabMeta } from "../../lib/workspaceSession";
import { WORKSPACE_LABELS } from "../layout/SideNav";
import { LangBadge } from "./LangBadge";
import { ServiceStatusButton } from "./ServiceStatusButton";
import { HotswapStatusChip } from "./HotswapStatusChip";
import { OperationStatus } from "../ui/OperationStatus";
import { StatusContributions } from "./StatusContributions";
import { FileStatusMenu } from "./FileStatusMenu";

/**
 * 外壳状态栏（工作台里只有这一条）。
 *
 * 左边是「你在哪」（工程 / 当前文件或当前工具页），中间是当前页的贡献
 * （编译、问题、SVN 改动、数据库连接，见 StatusContributions），右边是全局
 * 入口（NC 服务、底部面板）与代码页自己的编码 / 行尾 / 光标。
 *
 * 「Eclipse 按 GBK 读」这条只在树里标了号的 SQL 上出现：它的意义是提醒
 * 「用 Eclipse 编译这个文件会烂」，而工作台自己的产物是对的。
 */
export function ShellStatusBar({
  root,
  active,
  mark,
  saving,
  panelOpen,
  onTogglePanel,
  activeTool,
}: {
  root: string;
  active: TabMeta | null;
  mark: EncodingMark | undefined;
  /** 正在写盘。大文件保存要几秒，没有进行态就像「按了没反应」。 */
  saving: boolean;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** 当前页 key：文件页展示编辑器信息，工具页只留全局信息 + 该页贡献。 */
  activeTool: string;
}) {
  // 光标自己订阅（lib/cursorStore）：它每秒可能变几十次，
  // 挂在父组件上会拖着整棵文件树一起重渲染。
  const toolMode = activeTool !== "files";
  const toolLabel = WORKSPACE_LABELS[activeTool];
  return (
    <footer className="wb-status">
      {toolMode ? (
        <>
          <span className="wb-status-path" title={root}>{root || "尚未打开工程"}</span>
          {toolLabel && <span className="wb-status-mode">{toolLabel}</span>}
        </>
      ) : (
        <>
          <span className="wb-status-path" title={active?.path}>
            {active ? (active.virtual ? `${active.name} · jar 内` : active.path) : root}
          </span>
          {active && (active.dirty || active.eolChanged) && <span className="wb-status-unsaved" title="当前文件有未保存修改">未保存</span>}
          <LangBadge activePath={active && !active.virtual ? active.path : null} />
        </>
      )}
      <StatusContributions activeTool={activeTool} />
      <OperationStatus compact />
      <span className="wb-status-sp" />
      {saving && <span className="wb-status-warn">保存中…</span>}
      <HotswapStatusChip />
      <ServiceStatusButton />
      <button type="button" className="wb-status-btn" onClick={onTogglePanel}>
        {panelOpen ? "隐藏面板" : "显示面板"}
      </button>
      {!toolMode && active && (
        <>
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
          <FileStatusMenu active={active} />
        </>
      )}
    </footer>
  );
}
