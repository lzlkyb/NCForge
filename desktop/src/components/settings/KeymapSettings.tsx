import { useState } from "react";
import { getKeymap, setKeymap, workspaceSearchLabel, type Keymap } from "../../lib/keymap";
import { PAGES } from "../../lib/pages";
import { Card } from "../ui/card";
import { KeybindingEditor } from "./KeybindingEditor";
import { SettingsRow } from "../ui/SettingsRow";
import { SettingsChoice } from "../ui/SettingsChoice";

export function KeymapSettings() {
  const [value, setValue] = useState<Keymap>(getKeymap);
  const [error, setError] = useState<{ text: string; next: Keymap }>();
  const change = (next: Keymap) => {
    // setKeymap 返回是否真的写进了本机存储：写入失败还 setValue 会让单选态显示成
    // 已切换，下次进来又变回去（用户看不到任何失败反馈）。
    if (!setKeymap(next)) {
      setError({ text: "无法保存快捷键方案：本机存储不可写，原方案仍然有效。请重试。", next });
      return;
    }
    setValue(next);
    setError(undefined);
  };
  // Ctrl+1~9 由 App 的 capture 监听消费（页面切换），登记为自定义键永远不会生效；
  // 本页的冲突检查覆盖不到它们，一览显示「无冲突」是假象（P1-16）。映射由 PAGES 派生。
  const pageHotkeys = PAGES.filter((p) => p.hotkey != null)
    .sort((a, b) => a.hotkey! - b.hotkey!)
    .map((p) => `Ctrl+${p.hotkey}=${p.label}`)
    .join("、");
  return (
    <Card className="flex flex-col gap-3 p-4">
      <SettingsRow id="keymap-scheme" label="快捷键方案" sub={`全工程搜索：${workspaceSearchLabel(value)}`} error={error?.text} onRetry={error ? () => change(error.next) : undefined} keywords={["Eclipse", "IDEA", "方案"]} valueText={value === "eclipse" ? "Eclipse" : "IntelliJ IDEA"}
        control={<SettingsChoice label="快捷键方案" value={value} options={[{ value: "eclipse", label: "Eclipse" }, { value: "idea", label: "IntelliJ IDEA" }]} onChange={(next) => change(next as Keymap)} />} />
      <div role="note" className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
        <p className="mb-1 font-medium text-foreground">Ctrl+1~9 为页面切换保留键，不能登记为自定义键</p>
        <p>
          这些组合由应用全局捕获（{pageHotkeys}），即使登记也不会生效，且本页的冲突检查无法覆盖它们。
          按 ? 打开「快捷键一览」，在「页面切换」组查看固定映射。
        </p>
      </div>
      <KeybindingEditor keymap={value} />
      <p className="text-sm text-muted-foreground">保存（Ctrl+S）与调用层级（Ctrl+Alt+H）是固定键；定义跳转、补全、类型层级依赖 Java 语言服务。</p>
    </Card>
  );
}
