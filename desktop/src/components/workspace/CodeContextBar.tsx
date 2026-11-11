import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { moduleOf } from "../../lib/ncModule";
import { dirName } from "../../lib/workspace";
import { useSidebarView } from "../../lib/sidebarView";
import { Icon } from "../ui/icon";

export function CodeContextBar({ root, compiling, canCompile, onCompile }: {
  root: string; compiling: boolean; canCompile: boolean; onCompile: () => void;
}) {
  const activePath = useWorkspaceSelector(s => s.activePath);
  const dirty = useWorkspaceSelector(s => s.tabs.some(t => t.dirty));
  const sidebar = useSidebarView();
  const module = activePath ? moduleOf(root, dirName(activePath)) : null;
  const reason = !root ? "请先打开工程" : !canCompile ? "请先打开可编辑的工程文件" : !module ? "当前文件不属于工作区模块" : null;
  return <div className="wb-code-context">
    <div className="wb-current-object" title={root}><Icon name="folder" size={14} /><strong>{root.split(/[\\/]/).filter(Boolean).pop() || "未打开工程"}</strong><span>{module ? `${module} 模块` : "未选择模块"}</span></div>
    <div className="wb-context-actions">
      <span className="wb-draft-state" role="status">{dirty ? "有未保存修改" : "文件已保存"}</span>
      <button type="button" className="ux-btn" aria-pressed={sidebar === "search"} onClick={() => window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "search" }))}><Icon name="search" size={13} />工程搜索</button>
      <button type="button" className="ux-btn ux-primary" disabled={compiling || !!reason} title={reason ?? `编译 ${module} 模块，未保存修改会先提示确认`} onClick={onCompile}><Icon name={compiling ? "spinner" : "hammer"} size={13} />{compiling ? "编译中…" : module ? `编译 ${module} 模块` : "编译当前模块"}</button>
    </div>
  </div>;
}
