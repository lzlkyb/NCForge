import { listCommands } from "../../lib/commandRegistry";
import { APP_INFO } from "../../lib/about";
import { toggleRail, toggleSide, useRailExpanded, useSideOpen } from "../../lib/layoutStore";
import { openPalette } from "../../lib/paletteStore";
import { requestSettingsSection } from "../../lib/settingsJump";
import { setSession, useWorkspaceSelector } from "../../lib/workspaceSession";
import { Menu, MenuItem } from "../ui/Menu";
import { Icon, type IconName } from "../ui/icon";

const navigate = (tab: string) => window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: tab }));
const APPLICATION_ACTIONS: { label: string; icon: IconName; tab: string }[] = [
  { label: "全工程搜索", icon: "search", tab: "search" },
  { label: "NC 服务", icon: "power", tab: "services" },
  { label: "补丁打包", icon: "package", tab: "patch" },
  { label: "工程关联", icon: "plug", tab: "linked" },
  { label: "数据字典", icon: "database", tab: "dict" },
  { label: "日志排查", icon: "log", tab: "logs" },
];

export function ApplicationMenu() {
  const settings = (section: string) => { requestSettingsSection(section); navigate("settings"); };
  return <Menu align="left" portal trigger={(open, toggle) => <button type="button" className="wb-header-icon" aria-label="应用菜单"
    title="应用菜单" aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Icon name="more" size={17} /></button>}>
    {(close) => <>
      <MenuItem label="命令面板" icon="terminal" onClick={() => { close(); openPalette("cmd"); }} />
      {APPLICATION_ACTIONS.map((action) => <MenuItem key={action.tab} label={action.label} icon={action.icon}
        onClick={() => { close(); navigate(action.tab); }} />)}
      <div className="wb-menu-separator" role="separator" />
      <MenuItem label="设置" icon="settings" onClick={() => { close(); navigate("settings"); }} />
      <MenuItem label="快捷键" icon="keyboard" onClick={() => { close(); settings("快捷键"); }} />
      <MenuItem label={`关于 ${APP_INFO.name}`} icon="info" onClick={() => { close(); settings("关于"); }} />
    </>}
  </Menu>;
}

export function LayoutMenu({ activeTool = "files" }: { activeTool?: string }) {
  const sideOpen = useSideOpen();
  const railExpanded = useRailExpanded();
  const panelOpen = useWorkspaceSelector((s) => s.panelOpen);
  const splitPath = useWorkspaceSelector((s) => s.splitPath);
  const check = (active: boolean) => active ? <Icon name="check" size={13} /> : undefined;
  return <Menu portal trigger={(open, toggle) => <button type="button" className="wb-header-icon" aria-label="工作台布局"
    title="工作台布局" aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Icon name="panel" size={16} /></button>}>
    {(close) => {
      const split = listCommands().find((command) => command.id === (splitPath ? "tab.splitClose" : "tab.split"));
      return <>
        {activeTool !== "logs" && <MenuItem label={activeTool === "settings" ? "设置分类" : "资源侧栏"} active={sideOpen} trailing={check(sideOpen)} onClick={() => { close(); toggleSide(); }} />}
        <MenuItem label="展开主导航" active={railExpanded} trailing={check(railExpanded)} onClick={() => { close(); toggleRail(); }} />
        <MenuItem label={activeTool === "files" ? "底部面板" : "代码底部面板"} active={panelOpen} trailing={check(panelOpen)} onClick={() => { close(); setSession({ panelOpen: (v) => !v }); if (activeTool !== "files") navigate("files"); }} />
        <div className="wb-menu-separator" role="separator" />
        <MenuItem label={splitPath ? "关闭代码分屏" : "代码左右分屏"} disabled={!split} onClick={() => { close(); split?.run(); if (activeTool !== "files") navigate("files"); }} />
      </>;
    }}
  </Menu>;
}
