import { useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import { initMonaco } from "../../lib/monacoSetup";
import { Button } from "../ui/button";

interface Props { id: string; text: string; original?: string; language: string; scrollTop: number; onScroll: (top: number) => void; onCompared?: (ready: boolean) => void }

/** 只挂载活动文件；切文件/比较模式时释放旧模型，复用已有 Monaco 和 worker。 */
export function GenTextPreview({ id, text, original, language, scrollTop, onScroll, onCompared }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | Monaco.editor.IStandaloneDiffEditor | null>(null);
  const saveScroll = useRef(onScroll);
  saveScroll.current = onScroll;
  const compared = useRef(onCompared);
  compared.current = onCompared;
  const initialScroll = useRef(scrollTop);
  initialScroll.current = scrollTop;
  const [summary, setSummary] = useState({ at: 0, total: 0, done: false, limited: false });
  const diff = original !== undefined;
  useEffect(() => {
    const monaco = initMonaco();
    if (!host.current) return;
    const options = { readOnly: true, domReadOnly: true, theme: "nc-forge", automaticLayout: true, fontSize: 13, lineHeight: 22,
      minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 12 }, ariaLabel: diff ? "生成文件差异" : "生成文件内容" };
    const instance = diff ? monaco.editor.createDiffEditor(host.current, { ...options, originalEditable: false,
      ignoreTrimWhitespace: false, renderSideBySide: host.current.clientWidth >= 680, maxComputationTime: 5000 }) : monaco.editor.create(host.current, options);
    editor.current = instance;
    const resized = new ResizeObserver((entries) => {
      if (diff) (instance as Monaco.editor.IStandaloneDiffEditor).updateOptions({ renderSideBySide: (entries[0]?.contentRect.width ?? 0) >= 680 });
    });
    resized.observe(host.current);
    return () => { resized.disconnect(); editor.current = null; instance.dispose(); };
  }, [diff]);
  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    setSummary({ at: 0, total: 0, done: false, limited: false });
    compared.current?.(false);
    const monaco = initMonaco();
    const modified = monaco.editor.createModel(text, language);
    const before = diff ? monaco.editor.createModel(original ?? "", language) : null;
    const comparison = before ? (instance as Monaco.editor.IStandaloneDiffEditor).createViewModel({ original: before, modified }) : null;
    const code = diff ? (instance as Monaco.editor.IStandaloneDiffEditor).getModifiedEditor() : instance as Monaco.editor.IStandaloneCodeEditor;
    let restore = initialScroll.current;
    const changes = diff ? (instance as Monaco.editor.IStandaloneDiffEditor).onDidUpdateDiff(() => {
      const lineChanges = (instance as Monaco.editor.IStandaloneDiffEditor).getLineChanges();
      // Monaco 0.52 exposes line changes; the old computation-result method is unavailable at runtime.
      const limited = lineChanges === null || (!lineChanges.length && before?.getValue() !== modified.getValue());
      setSummary({ at: 0, total: lineChanges?.length ?? 0, done: true, limited });
      compared.current?.(!limited);
      code.setScrollTop(restore); restore = code.getScrollTop();
    }) : null;
    if (comparison) (instance as Monaco.editor.IStandaloneDiffEditor).setModel(comparison);
    else (instance as Monaco.editor.IStandaloneCodeEditor).setModel(modified);
    code.setScrollTop(initialScroll.current);
    const scrolled = code.onDidScrollChange((event) => { restore = event.scrollTop; saveScroll.current(event.scrollTop); });
    return () => {
      changes?.dispose(); scrolled.dispose(); if (editor.current === instance) instance.setModel(null);
      comparison?.dispose(); before?.dispose(); modified.dispose();
    };
  }, [id, text, original, language, diff]);
  const move = (direction: number) => {
    const instance = editor.current as Monaco.editor.IStandaloneDiffEditor | null;
    const changes = instance?.getLineChanges();
    if (!changes?.length || !instance) return;
    const at = summary.at === 0 ? (direction > 0 ? 0 : changes.length - 1) : (summary.at - 1 + direction + changes.length) % changes.length;
    const line = Math.max(1, changes[at].modifiedStartLineNumber);
    instance.getModifiedEditor().revealLineInCenter(line);
    instance.getModifiedEditor().setPosition({ lineNumber: line, column: 1 });
    setSummary({ at: at + 1, total: changes.length, done: true, limited: summary.limited });
  };
  return <div className="gen-editor-wrap">
    {diff && <div className="gen-diff-tools"><span role="status">{summary.limited ? "差异未完全算出，请在文件编辑器中核对" : summary.total ? `${summary.at || "—"} / ${summary.total} 处差异` : summary.done ? "内容一致" : "正在比较…"}</span>
      <Button size="sm" variant="ghost" disabled={!summary.total} onClick={() => move(-1)}>上一处</Button><Button size="sm" variant="ghost" disabled={!summary.total} onClick={() => move(1)}>下一处</Button>
      <small>原文件 → 生成内容</small></div>}
    <div className="gen-monaco" ref={host} />
  </div>;
}
