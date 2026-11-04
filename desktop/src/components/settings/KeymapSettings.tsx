import { useState } from "react";
import { getKeymap, setKeymap, workspaceSearchLabel, type Keymap } from "../../lib/keymap";
import { Card } from "../ui/card";
import { KeybindingEditor } from "./KeybindingEditor";
import { toast } from "../ui/toast";
import { SettingsRow } from "../ui/SettingsRow";
import { SettingsChoice } from "../ui/SettingsChoice";

export function KeymapSettings() {
  const [value, setValue] = useState<Keymap>(getKeymap);
  const change = (next: Keymap) => {
    try { setKeymap(next); setValue(next); }
    catch { toast("无法保存快捷键方案", "error"); }
  };
  return (
    <Card className="flex flex-col gap-3 p-4">
      <SettingsRow id="keymap-scheme" label="快捷键方案" sub={`全工程搜索：${workspaceSearchLabel(value)}`} keywords={["Eclipse", "IDEA", "方案"]} valueText={value === "eclipse" ? "Eclipse" : "IntelliJ IDEA"}
        control={<SettingsChoice label="快捷键方案" value={value} options={[{ value: "eclipse", label: "Eclipse" }, { value: "idea", label: "IntelliJ IDEA" }]} onChange={(next) => change(next as Keymap)} />} />
      <KeybindingEditor keymap={value} />
      <p className="text-sm text-muted-foreground">保存（Ctrl+S）与调用层级（Ctrl+Alt+H）是固定键；定义跳转、补全、类型层级依赖 Java 语言服务。</p>
    </Card>
  );
}
