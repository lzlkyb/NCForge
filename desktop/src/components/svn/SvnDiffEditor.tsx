import { useEffect, useRef, useState, type ReactNode } from "react";
import { initMonaco } from "../../lib/monacoSetup";
import { useSvnDiffPrefs } from "../../lib/svnDiffPrefs";
import { changedLine, diffSummary, emptyDiffSummary } from "../../lib/svnDiffState";
import { Icon } from "../ui/icon";
import { SvnDiffTools } from "./SvnDiffTools";
import "../../svn-diff.css";

type Monaco = ReturnType<typeof initMonaco>;
type DiffEditor = ReturnType<Monaco["editor"]["createDiffEditor"]>;
type TextModel = ReturnType<Monaco["editor"]["createModel"]>;
type DiffViewModel = ReturnType<DiffEditor["createViewModel"]>;
type ComparisonModels = { original: TextModel; modified: TextModel; viewModel: DiffViewModel };
type SavedView = { view: ReturnType<DiffEditor["saveViewState"]>; at: number };
const views = new Map<string, SavedView>();

function retireModels(models: ComparisonModels): void {
  // 最后一对模型同步释放会让 Monaco 销毁尚在启动的 worker。
  // 自持公开 viewModel，让差异实际计算完，再释放模型；UI 可立即切走。
  void models.viewModel.waitForDiff().then(() => {
    models.viewModel.dispose();
    models.original.dispose(); models.modified.dispose();
  });
}

function saveView(editor: DiffEditor, key: string, at: number): void {
  const view = editor.saveViewState();
  if (!view) return;
  views.delete(key);
  views.set(key, { view, at });
  if (views.size > 50) views.delete(views.keys().next().value!);
}

/** 只读比较器：本地审查、固定历史版本和冲突预览共用同一套阅读行为。 */
export function SvnDiffEditor({ original, modified, language = "plaintext", sourceKey, root = null,
  originalLabel = "原版本", modifiedLabel = "新版本", footer, toolbar, actions, disabled = false }: {
  original: string;
  modified: string;
  language?: string;
  sourceKey: string;
  root?: string | null;
  originalLabel?: string;
  modifiedLabel?: string;
  footer?: ReactNode;
  toolbar?: ReactNode;
  actions?: ReactNode;
  disabled?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<DiffEditor | null>(null);
  const modelsRef = useRef<ComparisonModels | null>(null);
  const [summary, setSummary] = useState(emptyDiffSummary);
  const [narrow, setNarrow] = useState(false);
  const prefs = useSvnDiffPrefs(root);
  const summaryRef = useRef(summary); summaryRef.current = summary;
  const key = `${(root ?? "").replace(/\\/g, "/").toLowerCase()}:${sourceKey}`;
  const currentKey = useRef(key);
  const pendingRestore = useRef<SavedView | undefined>();
  const locateFirst = useRef(false);
  const lastWhitespace = useRef(prefs.ignoreWhitespace);

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = initMonaco().editor.createDiffEditor(hostRef.current, {
      readOnly: true, originalEditable: false, automaticLayout: true,
      renderSideBySideInlineBreakpoint: 0, minimap: { enabled: false },
      renderOverviewRuler: false, scrollBeyondLastLine: false,
      fontSize: 12, lineHeight: 20, ignoreTrimWhitespace: false,
    });
    editorRef.current = editor;
    const sub = editor.onDidUpdateDiff(() => {
      if (!modelsRef.current) return;
      const changes = editor.getLineChanges();
      if (!changes) { setSummary(emptyDiffSummary); return; }
      const saved = pendingRestore.current;
      if (saved) { editor.restoreViewState(saved.view); pendingRestore.current = undefined; }
      const first = locateFirst.current && changes.length > 0;
      if (first) {
        locateFirst.current = false;
        const line = Math.min(changedLine(changes[0]), modelsRef.current.modified.getLineCount());
        editor.getModifiedEditor().revealLineInCenter(line);
        editor.getModifiedEditor().setPosition({ lineNumber: line, column: 1 });
      }
      const next = diffSummary(changes, saved?.at ?? (first ? 1 : summaryRef.current.at));
      summaryRef.current = next;
      setSummary(next);
    });
    const cursor = editor.getModifiedEditor().onDidChangeCursorPosition(event => {
      if (!modelsRef.current) return;
      const changes = editor.getLineChanges();
      if (!changes) return;
      const line = event.position.lineNumber;
      const at = changes.findIndex(change => line >= changedLine(change) && line <= Math.max(changedLine(change), change.modifiedEndLineNumber));
      // Monaco 初始化及点击上下文会把光标放在未修改行；保留最近定位的差异。
      if (at < 0) return;
      const next = diffSummary(changes, at + 1);
      summaryRef.current = next;
      setSummary(next);
    });
    return () => {
      if (modelsRef.current && summaryRef.current.ready) saveView(editor, currentKey.current, summaryRef.current.at);
      sub.dispose(); cursor.dispose();
      const models = modelsRef.current;
      modelsRef.current = null;
      editor.setModel(null);
      if (models) retireModels(models);
      editor.dispose(); editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    currentKey.current = key;
    pendingRestore.current = views.get(key);
    locateFirst.current = !pendingRestore.current;
    setSummary(emptyDiffSummary);
    const monaco = initMonaco();
    const models = { original: monaco.editor.createModel(original, language), modified: monaco.editor.createModel(modified, language) };
    const viewModel = editor.createViewModel(models);
    const comparison = { ...models, viewModel };
    modelsRef.current = comparison;
    editor.setModel(viewModel);
    // 初始 onDidUpdateDiff 可能先报告空结果；等待当前 worker 完成再首次定位。
    // 同一个编辑器的布局或偏好变化不触发这段逻辑，返回文件则恢复原视图。
    void viewModel.waitForDiff().then(() => {
      if (modelsRef.current !== comparison || !locateFirst.current) return;
      const changes = editor.getLineChanges();
      if (!changes?.length) return;
      locateFirst.current = false;
      const line = Math.min(changedLine(changes[0]), models.modified.getLineCount());
      editor.getModifiedEditor().revealLineInCenter(line);
      editor.getModifiedEditor().setPosition({ lineNumber: line, column: 1 });
      const next = diffSummary(changes, 1);
      summaryRef.current = next;
      setSummary(next);
    });
    return () => {
      if (!editorRef.current) return;
      // StrictMode 的首次清理或尚未计算完的快速切换，不应缓存空白初始视图。
      if (summaryRef.current.ready) saveView(editor, key, summaryRef.current.at);
      modelsRef.current = null;
      editor.setModel(null);
      retireModels(comparison);
    };
  }, [key, original, modified, language]);

  useEffect(() => {
    if (lastWhitespace.current !== prefs.ignoreWhitespace) {
      setSummary(emptyDiffSummary);
      lastWhitespace.current = prefs.ignoreWhitespace;
    }
    editorRef.current?.updateOptions({
      renderSideBySide: prefs.layout === "sideBySide" || (prefs.layout === "auto" && !narrow),
      ignoreTrimWhitespace: prefs.ignoreWhitespace, diffWordWrap: prefs.wrap ? "on" : "off",
      fontSize: prefs.fontSize, lineHeight: prefs.fontSize + 8,
      hideUnchangedRegions: { enabled: prefs.collapseUnchanged, contextLineCount: 4, minimumLineCount: 12, revealLineCount: 8 },
    });
  }, [prefs, narrow]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setNarrow(width < 560);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const jump = (step: number) => {
    const editor = editorRef.current;
    const changes = editor?.getLineChanges();
    if (disabled || !editor || !summary.ready || !changes?.length) return;
    const at = Math.max(1, Math.min(summary.at + step, changes.length));
    const line = Math.min(changedLine(changes[at - 1]), modelsRef.current?.modified.getLineCount() ?? 1);
    editor.getModifiedEditor().revealLineInCenter(line);
    editor.getModifiedEditor().setPosition({ lineNumber: line, column: 1 });
    setSummary(diffSummary(changes, at));
  };

  return <div className="vc-compare" data-compact={toolbar ? true : undefined}>
    <div className="vc-reading-bar">{toolbar}
      <span className="vc-reading-stats" role="status" aria-live="polite">
        {!summary.ready ? <><Icon name="spinner" size={12} className="animate-spin" />计算差异中…</> : summary.total === 0 ? "当前设置下没有差异" : <><span className="vc-add">+{summary.add}</span><span className="vc-del">−{summary.del}</span><span>{summary.total} 处差异</span></>}
      </span>
      <div className="vc-diff-navigation">
      <button type="button" className="vc-btn vc-btn-sm" aria-label="上一处差异" title="上一处差异" disabled={disabled || !summary.ready || summary.at <= 1} onClick={() => jump(-1)}><Icon name="arrowUp" size={12} /><span className="vc-diff-jump-label">上一处</span></button>
      <button type="button" className="vc-btn vc-btn-sm" aria-label="下一处差异" title="下一处差异" disabled={disabled || !summary.ready || summary.total === 0 || summary.at >= summary.total} onClick={() => jump(1)}><Icon name="chevronDown" size={12} /><span className="vc-diff-jump-label">下一处</span></button>
      <span className="vc-hint">{summary.total > 0 ? summary.at > 0 ? `第 ${summary.at} / ${summary.total} 处` : `尚未定位 · ${summary.total} 处` : ""}</span>
      </div>
      <SvnDiffTools root={root} prefs={prefs} narrow={narrow} disabled={disabled} />{actions}
    </div>
    <div className="vc-compare-sources"><span title={originalLabel}>{originalLabel}</span><span title={modifiedLabel}>{modifiedLabel}</span></div>
    <div className="vc-compare-body"><div className="vc-compare-host" ref={hostRef} /></div>
    {footer && <div className="vc-compare-foot">{footer}</div>}
  </div>;
}
