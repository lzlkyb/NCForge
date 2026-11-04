import { Icon } from "../ui/icon";
import { useWorkbenchDock } from "./WorkbenchDock";

/**
 * 当前工具的文档页标签（SVN 差异 / 补丁 / SQL / 设置）。
 *
 * 以前是标签条右上角的「工具 / 源码」开关，打开后整块编辑器被替换。现在它是和文件标签
 * 并排的一个标签：点它看工具页，点文件标签回源码，两边随时来回。
 */
export function ToolTab() {
  const dock = useWorkbenchDock();
  const tab = dock?.toolTab;
  if (!dock || !tab) return null;
  // 数据库这类多文档工具：标签由工具停靠进来，这里只留宿主
  if (tab.custom) return <div ref={dock.bindHost("tabs")} className="wb-tool-tabs-host" />;
  return (
    <div
      role="tab"
      aria-selected={dock.documentOpen}
      className="wb-tab wb-tool-tab"
      data-active={dock.documentOpen || undefined}
      tabIndex={0}
      onClick={dock.showDocument}
      onAuxClick={(e) => { if (e.button === 1) tab.onClose?.(); }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Delete" && tab.onClose) { e.preventDefault(); tab.onClose(); return; }
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          dock.showDocument();
        }
      }}
    >
      <Icon name={tab.icon} size={13} />
      <span className="wb-tab-name">{tab.label}</span>
      {tab.onClose && <button type="button" className="wb-tab-x" aria-label={`关闭${tab.label}`}
        onClick={(e) => { e.stopPropagation(); tab.onClose?.(); }}><Icon name="close" size={12} /></button>}
    </div>
  );
}
