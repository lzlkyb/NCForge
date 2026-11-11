import type { MetaEditorState, MetaMode } from "../../lib/metaEditor";
import { Icon, type IconName } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import type { MetaView } from "./MetaViewPanel";

const MODES: [MetaMode, string][] = [["linked", "联动"], ["model", "模型"], ["fields", "字段"]];
const TOOLS: [MetaView, string, string, IconName][] = [["compare", "对比", "字段差异", "copy"], ["history", "历史", "SVN", "clock"], ["generate", "生成中心", "DDL / VO", "code"], ["excel", "导入导出", "Excel", "file"], ["publish", "发布 POC", "实验功能", "upload"]];

export function MetaToolbar({ state, mode, locked, dirty = false, resourceDrawer, inspectorDrawer, resourceOpen, inspectorOpen, focused, onState, onResources, onInspector, onFocus }: {
  state: MetaEditorState; mode: MetaMode; locked: boolean; resourceDrawer: boolean; inspectorDrawer: boolean;
  resourceOpen: boolean; inspectorOpen: boolean;
  focused: boolean; onFocus: () => void;
  dirty?: boolean;
  onState: (patch: Partial<MetaEditorState>) => void; onResources: () => void; onInspector: () => void;
}) {
  const tool = TOOLS.find(([key]) => key === state.view);
  return <div className="meta-editor-toolbar">
    {resourceDrawer && <button type="button" className="meta-link" onClick={onResources} aria-haspopup="dialog" aria-expanded={resourceOpen}><Icon name="folder" size={13} />资源</button>}
    <div className="meta-mode-switch" role="group" aria-label="元数据工作模式">{MODES.map(([key, label]) => <button type="button" key={key}
      disabled={locked} aria-pressed={state.view === "detail" && mode === key} className={state.view === "detail" && mode === key ? "is-active" : ""}
      onClick={() => onState({ view: "detail", mode: key, modeChosen: true })}>{label}</button>)}</div>
    {tool && <span className="meta-active-tool">{tool[1]}</span>}
    {locked && <span className="meta-edit-status" role="status">编辑中 · 预览后保存</span>}
    <div className="meta-toolbar-spacer" />
    <div className="meta-task-actions" role="group" aria-label="元数据任务">
      {([["detail", "编辑"], ["generate", "生成中心"], ["excel", "导入导出"]] as const).map(([key, label]) => <button type="button" className="meta-link" key={key}
        aria-pressed={state.view === key} disabled={locked || dirty && key !== "detail"} title={locked ? "请先完成当前编辑" : dirty && key !== "detail" ? "先预览并保存草稿" : undefined}
        onClick={() => onState({ view: key })}>{label}</button>)}
    </div>
    <button type="button" className="meta-link" disabled={locked} onClick={onFocus} aria-pressed={focused}
      aria-label={focused ? "退出元数据专注模式" : "进入元数据专注模式"} title={focused ? "恢复资源栏和属性栏" : "专注当前文档：收起资源栏和属性栏"}>
      <Icon name={focused ? "collapse" : "expand"} size={14} />
    </button>
    <Menu portal trigger={(open, toggle) => <button type="button" className="meta-link" disabled={locked} onClick={toggle} aria-expanded={open} aria-haspopup="menu"><Icon name="sliders" size={13} />工具<Icon name="chevronDown" size={11} /></button>}>
      {(close) => <>{TOOLS.map(([key, label, hint, icon]) => <MenuItem key={key} label={label} hint={dirty && ["generate", "excel", "publish"].includes(key) ? "先保存草稿" : hint} icon={icon} active={state.view === key}
        disabled={dirty && ["generate", "excel", "publish"].includes(key)} onClick={() => { onState({ view: key }); close(); }} />)}
        <MenuItem label="引用" hint="跨工程" icon="arrowRight" onClick={() => { onState({ view: "detail", pane: "refs", mode: mode === "model" ? "linked" : state.mode }); close(); }} />
        <MenuItem label="校验问题" icon="shield" onClick={() => { onState({ view: "detail", pane: "issues", mode: mode === "model" ? "linked" : state.mode }); close(); }} />
      </>}
    </Menu>
    {inspectorDrawer && state.view === "detail" && <button type="button" className="meta-link" onClick={onInspector} aria-haspopup="dialog" aria-expanded={inspectorOpen}><Icon name="panel" size={13} />属性</button>}
  </div>;
}
