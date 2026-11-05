import { Icon } from "../ui/icon";
import { useWorkbenchDock } from "./WorkbenchDock";

/**
 * 当前工具的文档标签（SVN / 元数据 / 设置 / 日志排查）。
 *
 * 它渲染在**文档面自己的标签条**里（`wb-doc-tabs`），不再和文件标签挤在同一条：
 * 文件标签属于代码面，工具标签属于文档面，两个面互斥显示，两套标签就不可能同屏。
 *
 * 多文档工具（数据库）`custom`：它的标签条由工具自己停靠进 `doctabs` 区，
 * 这里返回 null 让位（以前这里给个空宿主 div，于是数据库标签和文件标签成了
 * 同一个 flex 行里的兄弟节点）。
 */
export function ToolTab() {
  const dock = useWorkbenchDock();
  const tab = dock?.toolTab;
  if (!dock || !tab) return null;
  if (tab.custom) return null;
  return (
    <div className="wb-tabs" role="tablist">
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
    </div>
  );
}
