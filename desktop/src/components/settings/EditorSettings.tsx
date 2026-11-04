// 设置 → 编辑器：字号 / 字体 / 换行 / 缩进 / 小地图 / 粘性滚动 / 行尾诊断 / 自动保存。
//
// 全部落在 localStorage（`lib/editorPrefs`），不进 AppConfig：这些是本机显示习惯，
// 跟着配置导入导出跑到同事机器上没有意义。改完立即生效（编辑器订阅同一个事件）。
//
// 一页 9 个控件按用途折成三组（渐进披露）：折叠时摘要行仍写着当前值，
// 打开就要看「改哪个」而不是「现在是什么」时才展开。
import { useId, useState } from "react";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { SettingsRow } from "../ui/SettingsRow";
import { ToggleRow } from "../ui/ToggleRow";
import { SettingsField, integerRange } from "./SettingsField";
import { EditorPreview } from "./EditorPreview";
import { SettingsGroup } from "./SettingsGroup";
import { useEditorPrefs, setEditorPrefs, type EditorPrefs } from "../../lib/editorPrefs";
import { TEMPLATE_PREFIXES } from "../../lib/liveTemplates";

const onOff = (v: boolean) => (v ? "开" : "关");

export function EditorSettings() {
  const p = useEditorPrefs();
  const fontFamilyId = useId();
  const [feedback, setFeedback] = useState<{ key: string; error?: string }>();
  const save = (patch: Partial<EditorPrefs>) => {
    if (!setEditorPrefs(patch)) throw new Error("已在本次会话生效，但无法保存到本机。可重试保存，重启前请勿丢弃当前设置。");
    setFeedback(undefined);
  };
  const apply = (patch: Partial<EditorPrefs>, key: string) => {
    try { save(patch); setFeedback({ key }); }
    catch (e) { setFeedback({ key, error: String(e instanceof Error ? e.message : e) }); }
  };
  const toggleFeedback = (key: string) => ({
    saved: feedback?.key === key && !feedback.error,
    error: feedback?.key === key ? feedback.error : undefined,
  });
  return (
    <Card className="flex flex-col gap-1 p-2">
      <EditorPreview prefs={p} />
      {feedback?.error && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>当前编辑器设置尚未保存到本机</span>
        <Button variant="ghost" size="sm" onClick={() => apply({}, feedback.key)}>重试保存</Button>
      </div>}
      <SettingsGroup
        title="显示与排版"
        defaultOpen
        summary={`${p.fontSize}px · Tab ${p.tabSize} ${
          p.insertSpaces ? "空格" : "制表符"
        } · 自动换行 ${onOff(p.wordWrap)} · ${p.fontFamily.trim() || "默认字体"}`}
      >
        <SettingsRow
          id="editor-size" keywords={["字号", "font size"]} valueText={`${p.fontSize}px`}
          label="字号"
          sub="只影响代码编辑器（不影响界面其它文字）"
          control={<SettingsField value={p.fontSize} type="number" min={9} max={28} unit="px"
            ariaLabel="代码字号" validate={integerRange(9, 28, "px")}
            onSave={value => save({ fontSize: Number(value) })} />}
        />
        <SettingsRow
          id="editor-font" keywords={["字体", "font", "Consolas", "Cascadia"]}
          valueText={p.fontFamily.trim() || "默认字体"}
          label="字体"
          controlId={fontFamilyId}
          sub="留空用默认（Cascadia Mono → Consolas）"
          control={
            <SettingsField
              id={fontFamilyId}
              ariaLabel="代码字体"
              value={p.fontFamily}
              placeholder="留空用默认"
              validate={value => value.length > 200 ? "字体名称请控制在 200 个字符以内" : undefined}
              onSave={value => save({ fontFamily: value })}
            />
          }
        />
        <SettingsRow
          id="editor-indent" keywords={["缩进", "Tab", "空格", "indent"]}
          valueText={`Tab ${p.tabSize} · ${p.insertSpaces ? "空格" : "制表符"}`}
          label="缩进"
          sub="NC 源码是制表符，默认不转空格"
          control={
            <span className="flex flex-wrap items-center gap-2">
              <SettingsField value={p.tabSize} type="number" min={1} max={12} unit="列"
                ariaLabel="缩进宽度" validate={integerRange(1, 12, "列")}
                onSave={value => save({ tabSize: Number(value) })} />
              <label className="flex items-center gap-1 whitespace-nowrap text-sm">
                <input
                  type="checkbox"
                  checked={p.insertSpaces}
                  onChange={(e) => apply({ insertSpaces: e.target.checked }, "indent")}
                />
                用空格缩进
              </label>
            </span>
          }
          {...toggleFeedback("indent")}
        />
        <ToggleRow
          id="editor-wrap" keywords={["自动换行", "word wrap"]}
          label="自动换行"
          sub="长行折到下一行显示（不改文件内容）"
          last
          checked={p.wordWrap}
          onChange={(v) => apply({ wordWrap: v }, "wrap")}
          {...toggleFeedback("wrap")}
        />
      </SettingsGroup>

      <SettingsGroup
        title="编辑器辅助"
        summary={`小地图 ${onOff(p.minimap)} · 粘性滚动 ${onOff(
          p.stickyScroll,
        )} · Error Lens ${onOff(p.errorLens)}`}
      >
        <ToggleRow
          id="editor-minimap" keywords={["小地图", "minimap"]}
          label="小地图"
          sub="右侧缩略图；大文件会自动关掉"
          checked={p.minimap}
          onChange={(v) => apply({ minimap: v }, "minimap")}
          {...toggleFeedback("minimap")}
        />
        <ToggleRow
          id="editor-sticky" keywords={["粘性滚动", "sticky scroll"]}
          label="粘性滚动"
          sub="滚动时把外层类/方法名钉在顶部"
          checked={p.stickyScroll}
          onChange={(v) => apply({ stickyScroll: v }, "sticky")}
          {...toggleFeedback("sticky")}
        />
        <ToggleRow
          id="editor-diagnostics" keywords={["诊断", "Error Lens", "错误提示"]}
          label="行尾显示诊断（Error Lens）"
          sub="在行末显示报错；问题面板始终保留完整清单"
          last
          checked={p.errorLens}
          onChange={(v) => apply({ errorLens: v }, "diagnostics")}
          {...toggleFeedback("diagnostics")}
        />
      </SettingsGroup>

      <SettingsGroup
        title="保存"
        summary={`${
          p.autoSave ? `自动保存 ${p.autoSaveDelayMs}ms` : "自动保存关"
        } · 保存时格式化 ${onOff(p.formatOnSave)}`}
      >
        <ToggleRow
          id="editor-autosave" keywords={["自动保存", "auto save"]}
          label="自动保存"
          sub="停止输入后保存文件，默认关闭"
          info="调 NC 时常需要改一半就编译，自动保存可能打断这个节奏。开启前请按自己的调试习惯选择。"
          checked={p.autoSave}
          onChange={(v) => apply({ autoSave: v }, "autosave")}
          {...toggleFeedback("autosave")}
        />
        <SettingsRow
          id="editor-autosave-delay" keywords={["自动保存延迟", "delay"]}
          valueText={`${p.autoSaveDelayMs}ms${p.autoSave ? "" : " · 自动保存关闭"}`}
          label="自动保存延迟"
          sub="停止输入多久后保存"
          control={
            <SettingsField
              value={p.autoSaveDelayMs}
              min={500}
              max={60000}
              type="number"
              ariaLabel="自动保存延迟"
              disabled={!p.autoSave}
              disabledReason={!p.autoSave ? "开启自动保存后可调整延迟" : undefined}
              unit="ms"
              validate={integerRange(500, 60000, "ms")}
              onSave={value => save({ autoSaveDelayMs: Number(value) })}
            />
          }
        />
        <ToggleRow
          id="editor-format" keywords={["保存时格式化", "format on save"]}
          label="保存时格式化"
          sub="保存前整理 Java 格式"
          info="Ctrl+S 与自动保存前先格式化。语言服务未就绪时直接保存原文，不阻挡保存。"
          last
          checked={p.formatOnSave}
          onChange={(v) => apply({ formatOnSave: v }, "format")}
          {...toggleFeedback("format")}
        />
      </SettingsGroup>

      <SettingsRow
        id="editor-templates" keywords={["代码模板", "template", "sout", "psvm", "fori"]}
        label="代码模板"
        last
        sub={`敲这些前缀按 Tab/回车展开：${TEMPLATE_PREFIXES.slice(0, 8).join(" ")} …`}
        info="模板是编辑器自带能力，不依赖代码智能服务：sout、souf、serr、psvm、fori、forr、iter、ifn、inn、tryc、tryf、th、swi、strnull 等。"
      />
    </Card>
  );
}
