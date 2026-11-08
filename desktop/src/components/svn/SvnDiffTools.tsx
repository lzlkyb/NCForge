import { setSvnDiffPrefs, type SvnDiffPrefs } from "../../lib/svnDiffPrefs";
import { Icon } from "../ui/icon";
import { Menu } from "../ui/Menu";

export function SvnDiffTools({ root, prefs, narrow, disabled = false }: {
  root: string | null;
  prefs: SvnDiffPrefs;
  narrow: boolean;
  disabled?: boolean;
}) {
  return <div className="vc-reading-tools">
    <Menu portal width="w-64" trigger={(open, toggle) => <button type="button" className="vc-btn vc-btn-sm"
      disabled={disabled} aria-label="显示设置" aria-haspopup="menu" aria-expanded={open} onClick={toggle} title="显示方式、换行与字号">
      <Icon name="settings" size={13} /><span className="vc-display-label">显示设置</span>
    </button>}>
      {() => <div className="vc-reading-menu">
    <label>显示方式<select aria-label="差异显示方式" className="vc-reading-select" value={prefs.layout} disabled={disabled}
      onChange={e => setSvnDiffPrefs(root, { layout: e.target.value as SvnDiffPrefs["layout"] })}>
      <option value="auto">自动 · {narrow ? "单栏" : "双栏"}</option>
      <option value="sideBySide">左右双栏</option>
      <option value="inline">单栏内联</option>
    </select></label>
        <label><input type="checkbox" checked={prefs.ignoreWhitespace} disabled={disabled}
          onChange={e => setSvnDiffPrefs(root, { ignoreWhitespace: e.target.checked })} />忽略行首尾空白差异</label>
        <label><input type="checkbox" checked={prefs.wrap} disabled={disabled}
          onChange={e => setSvnDiffPrefs(root, { wrap: e.target.checked })} />长行自动换行</label>
        <label><input type="checkbox" checked={prefs.collapseUnchanged} disabled={disabled}
          onChange={e => setSvnDiffPrefs(root, { collapseUnchanged: e.target.checked })} />折叠长段未修改代码</label>
        <label>阅读字号<select aria-label="差异字号" className="vc-reading-select" value={prefs.fontSize} disabled={disabled}
          onChange={e => setSvnDiffPrefs(root, { fontSize: Number(e.target.value) })}>
          {[12, 13, 14, 16].map(size => <option key={size} value={size}>{size}px</option>)}
        </select></label>
        <p>偏好仅影响阅读，按工作副本保存。</p>
      </div>}
    </Menu>
    {prefs.ignoreWhitespace && <span className="vc-reading-warning">已忽略行首尾空白</span>}
  </div>;
}
