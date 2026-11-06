import { getModel } from "../../lib/editorStore";
import { languageOf } from "../../lib/workspace";
import type { TabMeta } from "../../lib/workspaceSession";
import { useCursor } from "../../lib/cursorStore";
import { requestSettingsSection } from "../../lib/settingsJump";
import { Menu, MenuItem } from "../ui/Menu";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";

export function FileStatusMenu({ active }: { active: TabMeta }) {
  const cursor = useCursor();
  const language = active.virtual ? "java" : getModel(active.path)?.getLanguageId() ?? languageOf(active.path);
  const details = `${language} · ${active.encoding}${active.hasBom ? " BOM" : ""} · ${active.eol} · 第 ${cursor.line} 行，第 ${cursor.column} 列`;
  return <Menu portal width="w-72" trigger={(open, toggle) => <button type="button" className="wb-status-btn wb-file-status" aria-label="当前文件状态" title={details} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
    <span className="wb-file-status-details">{active.encoding} · {cursor.line}:{cursor.column}</span><span className="wb-file-status-short">文件状态</span><Icon name="chevronDown" size={11} />
  </button>}>
    {close => <>
      <dl className="wb-file-status-list"><div><dt>语言</dt><dd>{language}</dd></div><div><dt>编码</dt><dd>{active.encoding}{active.hasBom ? " BOM" : ""}</dd></div><div><dt>行尾</dt><dd>{active.eol}{active.eolChanged ? " · 已修改" : ""}</dd></div><div><dt>光标</dt><dd>第 {cursor.line} 行，第 {cursor.column} 列</dd></div><div><dt>文件</dt><dd>{active.readOnly ? "只读" : active.dirty || active.eolChanged ? "未保存" : "已保存"}</dd></div></dl>
      <div className="wb-menu-separator" role="separator" />
      <MenuItem label="复制文件路径" icon="copy" onClick={() => { close(); void navigator.clipboard.writeText(active.path).then(() => toast("已复制文件路径", "success"), error => toast(`复制失败：${String(error)}`, "error")); }} />
      <MenuItem label="编辑器设置" icon="settings" onClick={() => { close(); requestSettingsSection("编辑器"); window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "settings" })); }} />
    </>}
  </Menu>;
}
