import { getRecentRoots } from "../../lib/recentRoots";
import { setSideOpen } from "../../lib/layoutStore";
import { setSidebarView } from "../../lib/sidebarView";
import { baseName } from "../../lib/workspace";
import { requestWorkspacePicker } from "../../lib/workspacePicker";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { Menu, MenuItem } from "../ui/Menu";
import { Icon } from "../ui/icon";

export function WorkspaceMenu() {
  const root = useWorkspaceSelector((s) => s.root);
  const choose = (path?: string) => {
    if (path && path.toLowerCase() === root?.toLowerCase()) return;
    requestWorkspacePicker(path);
    setSideOpen(true);
    setSidebarView("files");
    window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "files" }));
  };
  return <Menu align="left" width="w-80" portal
    trigger={(open, toggle) => <button type="button" className="wb-workspace-pick" aria-label="选择工作区" aria-haspopup="menu" aria-expanded={open}
      title={root || "选择工作区"} onClick={toggle}>
      <Icon name="folder" size={14} /><span>{root ? baseName(root) || root : "选择工作区"}</span><Icon name="chevronDown" size={12} />
    </button>}>
    {(close) => <>
      <MenuItem label="打开其他工作区…" icon="folder" onClick={() => { close(); choose(); }} />
      {getRecentRoots().length > 0 && <div className="wb-menu-caption">最近工作区</div>}
      {getRecentRoots().map((path) => <MenuItem key={path}
        active={path.toLowerCase() === root?.toLowerCase()}
        label={<span className="wb-workspace-option"><span>{baseName(path) || path}</span><small title={path}>{path}</small></span>}
        onClick={() => { close(); choose(path); }} />)}
    </>}
  </Menu>;
}
