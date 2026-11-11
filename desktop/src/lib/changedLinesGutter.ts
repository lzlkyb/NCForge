/**
 * 代码区改动装饰：行号槽右侧 3px 窄条 + 删除三角 + 点击看基线 + 单块还原 + Alt+↑/↓。
 *
 * 挂在 `EditorPane` 创建编辑器时（与书签/断点槽并列），不新增 React state。
 * 装饰只认 `linesDecorationsClassName`，不整行着色——NC 中文注释密集，行背景会挡看代码。
 *
 * 基线来自 `getEffectiveBaseline`：选中一轮后画「这一轮」的改动，切回则画 SVN BASE。
 * 重算触发：切 model、模型内容防抖 800ms、基线到位/刷新、轮基线切换。
 *
 * 浮层拆到 changedLinesPeek.ts（不静态 import monaco 进 jsdom 测试链路）。
 */
import { monaco } from "./monacoSetup";
import { pathOfModel } from "./editorStore";
import { getSession } from "./workspaceSession";
import { blockAtLine, computeChanged, EMPTY_CHANGED, type ChangedBlock, type ChangedSnapshot } from "./changedLines";
import { locateBlock, revertEdit } from "./changedLinesRestore";
import {
  getEffectiveBaseline, initChangedLines, publishSnapshot, requestBaseline,
  setChangedJumpHandler, subscribeBaseline,
} from "./changedLinesStore";
import { copyReviewNotes } from "./reviewNotes";
import { closeChangedPeek, openChangedPeek, peekAnchor } from "./changedLinesPeek";
import {
  isBlockReviewed, markBlockReviewed, roundForPath, selectRound,
  setJumpToRoundFirst, subscribeReviewSession,
} from "./reviewSession";
import { toast } from "../components/ui/toast";

type Editor = ReturnType<typeof monaco.editor.create>;
type Decorations = ReturnType<Editor["createDecorationsCollection"]>;

const snapshots = new Map<Editor, ChangedSnapshot>();
let activeEditor: Editor | null = null;
const RECOMPUTE_MS = 800;

/** 跳「下一处未审」，不是无差别下一处；全审完才退化为按全部改动循环。 */
export function jumpChanged(step: number): void {
  const editor = activeEditor ?? snapshots.keys().next().value ?? null;
  const snap = editor ? snapshots.get(editor) : undefined;
  const model = editor?.getModel();
  const path = model ? pathOfModel(model) : undefined;
  if (!editor || !model || !path || !snap?.blocks.length) return;
  const pending = snap.blocks.filter((b) => !isBlockReviewed(path, b));
  if (!pending.length) toast("这一轮的改动块都已审完，跳转按全部改动循环", "info");
  const targets = (pending.length ? pending : snap.blocks).map((b) => b.startLine);
  const at = editor.getPosition()?.lineNumber ?? 0;
  const next = step > 0
    ? targets.find((t) => t > at) ?? targets[0]
    : [...targets].reverse().find((t) => t < at) ?? targets[targets.length - 1];
  const line = Math.min(Math.max(1, next), model.getLineCount());
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column: 1 });
  editor.focus();
}

/** 已审块只把色条压暗，不隐藏：审过的位置仍要看得见、能点开复查。 */
function decorate(editor: Editor, snap: ChangedSnapshot, collection: Decorations, path: string): void {
  const byLine = new Map<number, "add" | "mod" | "del">();
  for (const line of snap.addedLines) byLine.set(line, "add");
  for (const line of snap.deletedLines) byLine.set(line, byLine.has(line) ? "mod" : "del");
  const dim = new Set<number>();
  for (const b of snap.blocks) {
    if (!isBlockReviewed(path, b)) continue;
    const lo = Math.min(b.startLine, b.deletedAt || b.startLine);
    const hi = Math.max(b.endLine, b.deletedAt);
    for (let line = lo; line <= hi; line += 1) dim.add(line);
  }
  const items = [...byLine.entries()].map(([line, kind]) => ({
    range: new monaco.Range(line, 1, line, 1),
    options: {
      linesDecorationsClassName: `ncf-chg-${kind}${dim.has(line) ? " ncf-chg-reviewed" : ""}`,
      linesDecorationsTooltip: kind === "del" ? "这里有删除 · 点击查看基线" : "这里被改过 · 点击查看基线",
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  }));
  collection.set(items);
  void editor;
}

/** 还原前必须用「当前模型」重算快照并按内容重定位，绝不拿浮层打开时的旧行号盲写（P0-6）。 */
function applyRevert(editor: Editor, path: string, block: ChangedBlock): void {
  const model = editor.getModel();
  if (!model) return;
  const baseline = getEffectiveBaseline(path);
  if (!baseline || baseline.state !== "ok") {
    toast("基线已失效，请重新打开这个文件", "warning");
    return;
  }
  const text = model.getValue(monaco.editor.EndOfLinePreference.LF);
  const fresh = computeChanged(baseline.baseText, text);
  const located = locateBlock(block, fresh);
  if (!located) {
    toast("文件已变化，请重新点击色条再还原", "warning");
    return;
  }
  const edit = revertEdit(located, model.getLinesContent());
  const range = new monaco.Range(edit.startLine, edit.startColumn, edit.endLine, edit.endColumn);
  editor.executeEdits("ncforge.revertChangedBlock", [{ range, text: edit.text, forceMoveMarkers: true }]);
  editor.pushUndoStop();
  toast("已还原这一块为基线内容，保存后落盘", "info");
}

function showPeek(editor: Editor, path: string, block: ChangedBlock, line: number, refresh: () => void): void {
  const dom = editor.getDomNode();
  const visible = editor.getScrolledVisiblePosition({ lineNumber: line, column: 1 });
  const round = roundForPath(path);
  openChangedPeek({
    anchor: peekAnchor(dom?.getBoundingClientRect(), visible?.top),
    head: block.baseLines.length
      ? `基线原内容 · 第 ${block.oldStart}–${block.oldEnd} 行`
      : "基线中没有这一块（新增）",
    code: block.baseLines.length
      ? block.baseLines.join("\n")
      : "（新增块；还原会删除这些行）",
    tip: "还原会把这一块恢复为基线内容，编辑器里这一块的未保存改动会丢失。写回按 LF 归一，保存时按文件原换行落盘。",
    reviewed: isBlockReviewed(path, block),
    roundLabel: round
      ? `可能属于：${round.label ?? "改动轮"} · ${new Date(round.at).toLocaleTimeString("zh-CN", { hour12: false })}`
      : null,
    actions: {
      onMark: () => { markBlockReviewed(path, block); refresh(); },
      onNext: () => { closeChangedPeek(); jumpChanged(1); },
      onCopy: () => {
        void copyReviewNotes([{
          path,
          line: block.startLine,
          text: block.currentLines.join("\n") || "(这一块是删除)",
        }], getSession().root).then((ok) => toast(ok ? "已复制带 file:line 的批注" : "复制失败，请手动选中代码", ok ? "info" : "error"));
        closeChangedPeek();
      },
      onRevert: () => { applyRevert(editor, path, block); closeChangedPeek(); },
      onSelectRound: round ? () => void selectRound(round) : null,
    },
  });
}

/** 给一个编辑器挂改动装饰，返回清理函数。分屏两个编辑器各挂一次。 */
export function attachChangedLines(editor: Editor): () => void {
  // 组件测试里的 Monaco 是最小桩（没有 onDidScrollChange / getDomNode）。
  // 探测后直接降级：加一层装饰不该让已有的 6 个 EditorPane 用例全炸。
  if (typeof editor.onDidScrollChange !== "function" || typeof editor.getDomNode !== "function") {
    return () => {};
  }
  initChangedLines();
  const collection = editor.createDecorationsCollection();
  let timer: number | undefined;
  let lastText = "";
  let lastBase = "";
  let lastPath = "";

  const clear = () => { collection.clear(); };
  const refresh = () => {
    const model = editor.getModel();
    const path = model ? pathOfModel(model) : undefined;
    const snap = snapshots.get(editor);
    if (path && snap) decorate(editor, snap, collection, path);
  };

  const apply = () => {
    const model = editor.getModel();
    const path = model ? pathOfModel(model) : undefined;
    if (!model || !path) {
      clear();
      snapshots.set(editor, EMPTY_CHANGED);
      return;
    }
    const baseline = getEffectiveBaseline(path);
    if (!baseline) {
      requestBaseline(path);
      clear();
      snapshots.set(editor, EMPTY_CHANGED);
      // 基线失效（提交后清缓存）时也要清掉旧改动行，否则清单会拿上一个文件的文本
      publishSnapshot(path, EMPTY_CHANGED, []);
      return;
    }
    if (baseline.state !== "ok") {
      clear();
      snapshots.set(editor, EMPTY_CHANGED);
      publishSnapshot(path, EMPTY_CHANGED, []);
      return;
    }
    const text = model.getValue(monaco.editor.EndOfLinePreference.LF);
    if (text === lastText && baseline.baseText === lastBase && path === lastPath) return;
    lastText = text;
    lastBase = baseline.baseText;
    lastPath = path;
    const snap = computeChanged(baseline.baseText, text);
    // 改动行文本一起交给 store：审查清单据此核对表名，不必静态 import editorStore
    // （那条链会把 monaco-editor 拖进 BottomPanel 的 jsdom 测试）。
    const rows = snap.touchedLines.map((line) => ({
      line,
      text: model.getLineContent(Math.min(Math.max(1, line), model.getLineCount())),
    }));
    snapshots.set(editor, snap);
    decorate(editor, snap, collection, path);
    publishSnapshot(path, snap, rows);
  };

  const schedule = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => { timer = undefined; apply(); }, RECOMPUTE_MS);
  };

  apply();
  // 基线广播是全局的（任何一个文件取到 BASE 都会通知所有编辑器），这里靠
  // apply() 自己的去重（文本 + 基线文本 + 路径都没变就 return）挡住无关文件的重算。
  // 早先额外把 lastText 清空来「强制重算」，等于每次广播都全量 diff 一遍——
  // 几十个编辑器 × 大文件时能卡住输入，且去重逻辑本就够用。
  const offBase = subscribeBaseline(apply);
  const offReview = subscribeReviewSession(refresh);
  const offContent = editor.onDidChangeModelContent(schedule);
  const offModel = editor.onDidChangeModel(() => { closeChangedPeek(); lastText = ""; apply(); });
  const offFocus = editor.onDidFocusEditorText(() => { activeEditor = editor; });
  const offScroll = editor.onDidScrollChange(() => closeChangedPeek());
  const offMouse = editor.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
    const line = e.target.position?.lineNumber;
    const path = editor.getModel() ? pathOfModel(editor.getModel()!) : undefined;
    const snap = snapshots.get(editor);
    if (!line || !path || !snap) return;
    const block = blockAtLine(snap, line);
    if (block) showPeek(editor, path, block, line, refresh);
  });
  const offKey = editor.onKeyDown((e) => {
    if (!e.altKey || (e.keyCode !== monaco.KeyCode.DownArrow && e.keyCode !== monaco.KeyCode.UpArrow)) return;
    // 干净文件里放行 Monaco 默认的「移动行」：AI 时代不常写代码，但不等于可以
    // 静默吞掉一个标准编辑键（P0-5）。
    if (!snapshots.get(editor)?.blocks.length) return;
    e.preventDefault();
    e.stopPropagation();
    jumpChanged(e.keyCode === monaco.KeyCode.DownArrow ? 1 : -1);
  });
  setChangedJumpHandler(jumpChanged);
  setJumpToRoundFirst(() => {
    const target = activeEditor ?? snapshots.keys().next().value ?? null;
    const snap = target ? snapshots.get(target) : undefined;
    const model = target?.getModel();
    if (!target || !model || !snap?.blocks.length) return;
    const line = Math.min(Math.max(1, snap.blocks[0].startLine), model.getLineCount());
    target.revealLineInCenter(line);
    target.setPosition({ lineNumber: line, column: 1 });
  });
  if (document.activeElement && editor.getDomNode()?.contains(document.activeElement)) activeEditor = editor;

  return () => {
    if (timer !== undefined) window.clearTimeout(timer);
    offBase(); offReview(); offContent.dispose(); offModel.dispose(); offFocus.dispose();
    offScroll.dispose(); offMouse.dispose(); offKey.dispose();
    closeChangedPeek();
    clear();
    snapshots.delete(editor);
    if (activeEditor === editor) activeEditor = null;
  };
}
