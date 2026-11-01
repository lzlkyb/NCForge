// 设置 → 编辑器：字号 / 字体 / 换行 / 缩进 / 小地图 / 粘性滚动 / 行尾诊断 / 自动保存。
//
// 全部落在 localStorage（`lib/editorPrefs`），不进 AppConfig：这些是本机显示习惯，
// 跟着配置导入导出跑到同事机器上没有意义。改完立即生效（编辑器订阅同一个事件）。
import { Card } from "../ui/card";
import { SettingsRow } from "../ui/SettingsRow";
import { ToggleRow } from "../ui/ToggleRow";
import { NumBox } from "../ui/NumBox";
import { Input } from "../ui/input";
import { useEditorPrefs, setEditorPrefs } from "../../lib/editorPrefs";
import { TEMPLATE_PREFIXES } from "../../lib/liveTemplates";

export function EditorSettings() {
  const p = useEditorPrefs();
  return (
    <Card className="flex flex-col gap-1 p-2">
      <SettingsRow
        label="字号"
        sub="只影响代码编辑器（不影响界面其它文字）"
        control={<NumBox value={p.fontSize} min={9} unit="px" onCommit={(n) => setEditorPrefs({ fontSize: Math.min(28, n) })} />}
      />
      <SettingsRow
        label="字体"
        sub="留空用默认（Cascadia Mono → Consolas）"
        control={
          <Input
            className="w-64"
            value={p.fontFamily}
            placeholder="留空用默认"
            onChange={(e) => setEditorPrefs({ fontFamily: e.target.value })}
          />
        }
      />
      <SettingsRow
        label="缩进"
        sub="NC 源码是制表符，默认不转空格"
        control={
          <span className="flex items-center gap-2">
            <NumBox value={p.tabSize} min={1} unit="空格" onCommit={(n) => setEditorPrefs({ tabSize: Math.min(12, n) })} />
            <label className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={p.insertSpaces}
                onChange={(e) => setEditorPrefs({ insertSpaces: e.target.checked })}
              />
              用空格缩进
            </label>
          </span>
        }
      />
      <ToggleRow
        label="自动换行"
        sub="长行折到下一行显示（不改文件内容）"
        checked={p.wordWrap}
        onChange={(v) => setEditorPrefs({ wordWrap: v })}
      />
      <ToggleRow
        label="小地图"
        sub="右侧缩略图；大文件会自动关掉"
        checked={p.minimap}
        onChange={(v) => setEditorPrefs({ minimap: v })}
      />
      <ToggleRow
        label="粘性滚动"
        sub="滚动时把外层类/方法名钉在顶部"
        checked={p.stickyScroll}
        onChange={(v) => setEditorPrefs({ stickyScroll: v })}
      />
      <ToggleRow
        label="行尾显示诊断（Error Lens）"
        sub="把报错直接写在行末；嫌吵可以关掉，问题面板仍有完整清单"
        checked={p.errorLens}
        onChange={(v) => setEditorPrefs({ errorLens: v })}
      />
      <ToggleRow
        label="自动保存"
        sub="停止输入后自动落盘。默认关：调 NC 时常要「改一半就编译」，自动保存会打断这个节奏"
        checked={p.autoSave}
        onChange={(v) => setEditorPrefs({ autoSave: v })}
      />
      <SettingsRow
        label="自动保存延迟"
        sub="停止输入多久后保存"
        control={
          <NumBox
            value={p.autoSaveDelayMs}
            min={500}
            unit="ms"
            onCommit={(n) => setEditorPrefs({ autoSaveDelayMs: Math.min(60_000, n) })}
          />
        }
      />
      <SettingsRow
        label="代码模板"
        last
        sub={`敲这些前缀按 Tab/回车展开：${TEMPLATE_PREFIXES.slice(0, 8).join(" ")} …`}
        info="模板是编辑器自带能力，不依赖代码智能服务：sout、souf、serr、psvm、fori、forr、iter、ifn、inn、tryc、tryf、th、swi、strnull 等。"
      />
    </Card>
  );
}
