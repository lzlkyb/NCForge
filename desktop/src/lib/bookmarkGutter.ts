// 行号槽里的书签小旗。
//
// 数据源与底部「书签」面板、F11 同一个快照（`lib/bookmarks`），这里只做
// 「快照 → Monaco 装饰」，不发起任何请求。
//
// 行号左边那一格（宽度 = 行高）是 Monaco 的 `glyphMargin`，编辑器创建时已显式打开
// （ESM 版默认关，见 EditorPane）。小旗画在这格正中，不挤占代码宽度，
// 也不和 Error Lens 的行尾文字抢位置。
import { monaco } from "./monacoSetup";
import { pathOfModel } from "./editorStore";
import { bookmarkLinesIn, subscribeBookmarks } from "./bookmarks";

type Editor = ReturnType<typeof monaco.editor.create>;

/**
 * 给一个编辑器挂上行号槽书签，返回清理函数。
 *
 * 监听书签变化与切 model（换文件）。切 model 必须重算——装饰挂在具体 model 上，
 * 换文件后旧装饰不会跟着走。
 */
export function attachBookmarkGutter(editor: Editor): () => void {
  // 装饰集合只有 clear / set（没有 dispose）：清空即释放
  let current: { clear(): void } | null = null;

  const clear = () => {
    current?.clear();
    current = null;
  };

  const apply = () => {
    clear();
    const model = editor.getModel();
    if (!model) return;
    const path = pathOfModel(model);
    if (!path) return;
    // 书签存的是加书签时的行号；磁盘上的文件可能已经变短，越界的跳过而不是抛错
    const lastLine = model.getLineCount();
    const marks = bookmarkLinesIn(path).filter((m) => m.line <= lastLine);
    if (marks.length === 0) return;
    const collection = editor.createDecorationsCollection();
    collection.set(
      marks.map((m) => ({
        range: new monaco.Range(m.line, 1, m.line, 1),
        options: {
          glyphMarginClassName: "ncforge-bookmark-glyph",
          glyphMarginHoverMessage: {
            value: m.note ? `书签 · 第 ${m.line} 行\n${m.note}` : `书签 · 第 ${m.line} 行`,
          },
          // 在行首换行时不把新行也染成书签：行号跟着原位置走
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
    current = collection;
  };

  apply();
  const offStore = subscribeBookmarks(apply);
  const offModel = editor.onDidChangeModel(apply);
  return () => {
    offStore();
    offModel.dispose();
    clear();
  };
}
