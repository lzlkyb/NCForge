import { useState } from "react";
import { getKeymap, setKeymap, workspaceSearchLabel, type Keymap } from "../../lib/keymap";
import { Card } from "../ui/card";
import { KeybindingEditor } from "./KeybindingEditor";
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
      <KeybindingEditor keymap={value} />
      <p className="text-sm text-muted-foreground">保存（Ctrl+S）与调用层级（Ctrl+Alt+H）是固定键；定义跳转、补全、类型层级依赖 Java 语言服务。</p>
    </Card>
  );
}
