import { useState } from "react";
import { EDITOR_KEYS, getKeymap, paletteKeysLabel, setKeymap, workspaceSearchLabel, type Keymap } from "../../lib/keymap";
import { Card } from "../ui/card";
import { toast } from "../ui/toast";

export function KeymapSettings() {
  const [value, setValue] = useState<Keymap>(getKeymap);
  const change = (next: Keymap) => {
    try { setKeymap(next); setValue(next); }
    catch { toast("无法保存快捷键方案", "error"); }
  };
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div><h2 className="font-medium">快捷键方案</h2><p className="text-sm text-muted-foreground">选择习惯的键位，立即生效并自动记住。</p></div>
      <fieldset className="wb-keymap-choices" aria-label="快捷键方案">
        <label className="flex items-center gap-2"><input type="radio" name="keymap" checked={value === "eclipse"} onChange={() => change("eclipse")} />Eclipse（默认）</label>
        <label className="flex items-center gap-2"><input type="radio" name="keymap" checked={value === "idea"} onChange={() => change("idea")} />IntelliJ IDEA</label>
      </fieldset>
      <p className="text-sm text-muted-foreground">全工程搜索：{workspaceSearchLabel(value)}</p>
      <table className="wb-keymap-table"><thead><tr><th>操作</th><th>当前快捷键</th></tr></thead><tbody>
        <tr><td>保存</td><td><kbd>Ctrl+S</kbd></td></tr>
        <tr><td>转到文件</td><td><kbd>{paletteKeysLabel("file", value)}</kbd></td></tr>
        <tr><td>转到类型</td><td><kbd>{paletteKeysLabel("type", value)}</kbd></td></tr>
        <tr><td>当前文件符号</td><td><kbd>{paletteKeysLabel("symbol", value)}</kbd></td></tr>
        <tr><td>命令面板</td><td><kbd>{paletteKeysLabel("cmd", value)}</kbd></td></tr>
        <tr><td>切换侧栏 / 底部面板</td><td><kbd>Ctrl+B</kbd> / <kbd>Ctrl+J</kbd></td></tr>
        <tr><td>调用层级</td><td><kbd>Ctrl+Alt+H</kbd></td></tr>
        <tr><td>类型层级</td><td><kbd>{value === "idea" ? "Ctrl+H" : "Ctrl+T"}</kbd></td></tr>
        {EDITOR_KEYS.map(row => <tr key={row.action}><td>{row.label}</td><td><kbd>{row[value]}</kbd></td></tr>)}
      </tbody></table>
      <p className="text-sm text-muted-foreground">定义跳转、补全、调用层级与类型层级依赖 Java 语言服务。格式化尚未接入，不列为可用快捷键。</p>
    </Card>
  );
}
