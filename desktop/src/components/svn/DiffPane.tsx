import { useEffect, useRef, useState } from "react";
import { initMonaco } from "../../lib/monacoSetup";
import { formatBytes, type ChangeItem, type DiffResult } from "../../lib/svn";
import { Icon } from "../ui/icon";

type Monaco = ReturnType<typeof initMonaco>;
type DiffEditorInstance = ReturnType<Monaco["editor"]["createDiffEditor"]>;
type TextModel = ReturnType<Monaco["editor"]["createModel"]>;

/** 按扩展名给 Monaco 一个语言，拿不到就用 plaintext（至少不影响阅读）。 */
function languageOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    java: "java",
    xml: "xml",
    sql: "sql",
    js: "javascript",
    ts: "typescript",
    tsx: "typescript",
    html: "html",
    css: "css",
    md: "markdown",
    ini: "ini",
    properties: "ini",
  };
  return map[ext] ?? "plaintext";
}

/**
 * 双栏差异（BASE ↔ 工作副本）。
 *
 * 为什么用 Monaco 的 diff editor 而不是解析 unified diff：正文两侧本来就有
 * （BASE 从 SVNKit 取、工作副本从磁盘读），交给 Monaco 直接算词级差异，
 * 比「生成 patch 再反向解析」少一层编码/换行踩坑的机会（NC 源码是 GBK 与 UTF-8 混着的）。
 */
export function DiffPane({
  file,
  data,
  reviewed,
  onToggleReviewed,
  onOpenInEditor,
  onShowLog,
  onShowBlame,
  onMarkAndNext,
}: {
  file: ChangeItem;
  data: DiffResult;
  reviewed: boolean;
  onToggleReviewed: () => void;
  onOpenInEditor: () => void;
  onShowLog: () => void;
  onShowBlame: () => void;
  onMarkAndNext: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<DiffEditorInstance | null>(null);
  const modelsRef = useRef<{ base: TextModel | null; work: TextModel | null }>({ base: null, work: null });
  const [stats, setStats] = useState<{ add: number; del: number } | null>(null);
  const [pos, setPos] = useState<{ at: number; total: number }>({ at: 0, total: 0 });

  // 建编辑器只做一次；内容变化走后面的 effect
  useEffect(() => {
    if (!hostRef.current) return;
    const monaco = initMonaco();
    const diff = monaco.editor.createDiffEditor(hostRef.current, {
      readOnly: true,
      renderSideBySide: true,
      // 默认 900px 以下 Monaco 会自动退化成 inline（单栏内联）视图。
      // 右栏实际只有 620–700px，不设 0 就永远看不到双栏——审查时左右对照才是重点。
      renderSideBySideInlineBreakpoint: 0,
      automaticLayout: true,
      minimap: { enabled: false },
      renderOverviewRuler: false,
      scrollBeyondLastLine: false,
      // 不忽略空白差异：NC 里改一个缩进是常事，掩盖掉反而看不见改动
      ignoreTrimWhitespace: false,
      diffWordWrap: "on",
      fontSize: 12,
      lineHeight: 20,
    });
    editorRef.current = diff;
    const sub = diff.onDidUpdateDiff(() => {
      const changes = diff.getLineChanges() ?? [];
      let add = 0;
      let del = 0;
      for (const c of changes) {
        add += Math.max(0, c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1);
        del += Math.max(0, c.originalEndLineNumber - c.originalStartLineNumber + 1);
      }
      setStats({ add, del });
      setPos((p) => ({ at: p.at === 0 ? 0 : Math.min(p.at, changes.length), total: changes.length }));
    });
    return () => {
      sub.dispose();
      diff.dispose();
      editorRef.current = null;
    };
  }, []);

  // 换文件/换内容：重建两个 model（旧的必须 dispose，否则每次点文件都漏一份）
  useEffect(() => {
    const diff = editorRef.current;
    if (!diff) return;
    const monaco = initMonaco();
    const lang = languageOf(file.path);
    modelsRef.current.base?.dispose();
    modelsRef.current.work?.dispose();
    const base = monaco.editor.createModel(data.baseText, lang);
    const work = monaco.editor.createModel(data.workingText, lang);
    modelsRef.current = { base, work };
    diff.setModel({ original: base, modified: work });
    setStats(null);
    setPos({ at: 0, total: 0 });
  }, [file.path, data.baseText, data.workingText]);

  const jump = (dir: "next" | "prev") => {
    const diff = editorRef.current;
    if (!diff) return;
    const total = diff.getLineChanges()?.length ?? 0;
    if (total === 0) return;
    const next = dir === "next" ? Math.min(pos.at + 1, total) : Math.max(pos.at - 1, 1);
    setPos({ at: next, total });
    // Monaco 自己知道每一处改动的行号；没有 goToDiff 的版本就按改动块首行定位
    const changes = diff.getLineChanges() ?? [];
    const c = changes[next - 1];
    if (c) {
      diff.getModifiedEditor().revealLineInCenter(c.modifiedStartLineNumber);
      diff.getModifiedEditor().setPosition({ lineNumber: c.modifiedStartLineNumber, column: 1 });
    }
  };

  const dirName = file.rel.includes("/") ? file.rel.slice(0, file.rel.lastIndexOf("/") + 1) : "";

  return (
    <section className="vc-main">
      <div className="vc-bar">
        <span className="vc-badge" data-st={file.letter === "M" ? "mod" : file.letter === "A" ? "add" : file.letter === "C" ? "conflict" : file.letter === "D" ? "del" : "untracked"}>
          {file.letter}
        </span>
        <b>{file.rel.slice(file.rel.lastIndexOf("/") + 1)}</b>
        <span className="vc-path">{dirName}</span>
        <span className="vc-sp" />
        <button type="button" className="vc-btn vc-btn-sm" onClick={onShowLog}>
          历史
        </button>
        <button type="button" className="vc-btn vc-btn-sm" onClick={onShowBlame}>
          Blame
        </button>
        <button
          type="button"
          className="vc-review-toggle"
          data-on={reviewed || undefined}
          onClick={onToggleReviewed}
          title={reviewed ? "已审（点击取消）" : "标记为已审"}
        >
          <Icon name="check" size={12} />
          {reviewed ? "已审" : "标记已审"}
        </button>
        <button type="button" className="vc-btn vc-btn-sm" onClick={onOpenInEditor}>
          在文件中打开
        </button>
      </div>
      <div className="vc-meta">
        <span className="mono">
          {data.baseEmpty ? "新文件（无 BASE）" : `BASE r${file.revision > 0 ? file.revision : "?"} → 工作副本`}
        </span>
        <span>{data.encoding}</span>
        <span>{data.eol}</span>
        {stats && (
          <>
            <span className="vc-add">+{stats.add}</span>
            <span className="vc-del">−{stats.del}</span>
          </>
        )}
        <span className="vc-sp" />
        <span>
          {data.baseSize !== data.workingSize
            ? `${formatBytes(data.baseSize)} → ${formatBytes(data.workingSize)}`
            : formatBytes(data.workingSize)}
        </span>
        {pos.total > 0 && (
          <span>
            第 {pos.at || 1} / {pos.total} 处
          </span>
        )}
      </div>
      <div className="vc-diff-body" ref={hostRef} />
      <div className="vc-diff-foot">
        <button type="button" className="vc-btn vc-btn-sm" onClick={() => jump("prev")}>
          <Icon name="arrowUp" size={12} />
          上一处
        </button>
        <button type="button" className="vc-btn vc-btn-sm" onClick={() => jump("next")}>
          <Icon name="chevronDown" size={12} />
          下一处
        </button>
        <span className="vc-sp" />
        {!data.editable && <span className="vc-hint">此文件为混合换行或含不可无损往返的字符，编辑器只读</span>}
        <span className="vc-hint">
          <kbd>Alt</kbd>+<kbd>↓</kbd> 标记已审并下一个
        </span>
        <button type="button" className="vc-btn vc-btn-sm" onClick={onMarkAndNext}>
          <Icon name="check" size={12} />
          标记已审并下一个
        </button>
      </div>
    </section>
  );
}
