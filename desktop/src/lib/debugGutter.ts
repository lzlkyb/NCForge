// 行号槽里的断点与「暂停在这一行」。
//
// 两个数据源：断点来自 `lib/breakpoints`（本地清单，`verified` 来自 debugSync），
// 暂停位置来自 `lib/debugSession` 的当前选中帧。这里只做「快照 → Monaco 装饰」，
// 不发起任何请求。
//
// 断点画在 glyphMargin（行号左边那一格，宽度 = 行高）；暂停箭头画在行号槽，
// 两件事不会抢同一格——停在断点上时也要同时看得见红点和箭头。
import { monaco } from "./monacoSetup";
import { pathOfModel } from "./editorStore";
import { breakpointLinesIn, subscribeBreakpoints } from "./breakpoints";
import { isVerified, subscribeVerified } from "./debugSync";
import { getDebugSnapshot, subscribeDebug, toggleBreakpointHere } from "./debugSession";

type Editor = ReturnType<typeof monaco.editor.create>;

const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function applyBreakpoints(editor: Editor): { clear(): void } | null {
  const model = editor.getModel();
  if (!model) return null;
  const path = pathOfModel(model);
  if (!path) return null;
  const lastLine = model.getLineCount();
  const lines = breakpointLinesIn(path).filter((l) => l <= lastLine);
  if (lines.length === 0) return null;
  const collection = editor.createDecorationsCollection();
  collection.set(
    lines.map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: isVerified(path, line)
          ? "ncforge-bp-glyph"
          : "ncforge-bp-glyph ncforge-bp-glyph-unverified",
        glyphMarginHoverMessage: {
          value: isVerified(path, line)
            ? `断点 · 第 ${line} 行`
            : `断点 · 第 ${line} 行（还没落点：源码可能没进影子工程）`,
        },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })),
  );
  return collection;
}

function applyStopped(editor: Editor): { clear(): void } | null {
  const model = editor.getModel();
  if (!model) return null;
  const path = pathOfModel(model);
  const snap = getDebugSnapshot();
  if (!path || !snap.paused || !snap.frameId) return null;
  const frame = snap.frames.find((f) => f.id === snap.frameId);
  if (!frame?.source?.path || norm(frame.source.path) !== norm(path)) return null;
  const line = Math.min(Math.max(1, frame.line), model.getLineCount());
  const collection = editor.createDecorationsCollection();
  collection.set([
    {
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: "ncforge-debug-line",
        linesDecorationsClassName: "ncforge-debug-arrow",
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    },
  ]);
  return collection;
}

/**
 * 给编辑器挂上断点点位与暂停行装饰，返回清理函数。
 *
 * 切 model（换文件）必须重算：装饰挂在具体 model 上，换文件后旧装饰不会跟着走。
 */
export function attachDebugGutter(editor: Editor): () => void {
  let bps: { clear(): void } | null = null;
  let stopped: { clear(): void } | null = null;

  const apply = () => {
    bps?.clear();
    stopped?.clear();
    bps = applyBreakpoints(editor);
    stopped = applyStopped(editor);
  };

  apply();
  const offBp = subscribeBreakpoints(apply);
  const offVerified = subscribeVerified(apply);
  const offDebug = subscribeDebug(apply);
  const offModel = editor.onDidChangeModel(apply);
  // 点击行号槽空白处 = 加/去断点（IDEA 同行为）；有断点时点红点也是同一个动作
  const offClick = editor.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = e.target.position?.lineNumber;
    const model = editor.getModel();
    if (!line || !model) return;
    const path = pathOfModel(model);
    if (!path) return;
    toggleBreakpointHere(path, line);
  });
  return () => {
    offBp();
    offVerified();
    offDebug();
    offModel.dispose();
    offClick.dispose();
    bps?.clear();
    stopped?.clear();
  };
}
