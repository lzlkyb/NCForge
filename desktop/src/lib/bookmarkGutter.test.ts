import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachBookmarkGutter } from "./bookmarkGutter";
import { clearBookmarks, loadBookmarks, toggleBookmark } from "./bookmarks";

/**
 * 行号槽装饰：数据源是书签存储，这里只验「快照 → 装饰」的映射与清理，
 * 不启动 Monaco（真实编辑器由 EditorPane 挂，单测里用替身）。
 */
const mocks = vi.hoisted(() => ({ modelPath: "C:\\work\\A.java" }));

vi.mock("./monacoSetup", () => ({
  monaco: {
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    editor: { TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 0 } },
  },
}));

vi.mock("./editorStore", () => ({ pathOfModel: () => mocks.modelPath }));

type Editor = Parameters<typeof attachBookmarkGutter>[0];

function fakeEditor(lineCount = 100) {
  const collections: { set: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> }[] = [];
  const modelListeners: (() => void)[] = [];
  const editor = {
    getModel: () => ({ getLineCount: () => lineCount }),
    createDecorationsCollection: () => {
      const c = { set: vi.fn(), clear: vi.fn() };
      collections.push(c);
      return c;
    },
    onDidChangeModel: (cb: () => void) => {
      modelListeners.push(cb);
      return { dispose: vi.fn() };
    },
  };
  return { editor: editor as unknown as Editor, collections, modelListeners };
}

let n = 0;
const freshRoot = () => `C:\\work\\ws${(n += 1)}`;

describe("attachBookmarkGutter", () => {
  beforeEach(() => {
    mocks.modelPath = "C:\\work\\A.java";
  });

  it("把当前文件的书签铺成 glyph 装饰（行号、小旗类、悬停摘要）", () => {
    loadBookmarks(freshRoot());
    toggleBookmark("C:\\work\\A.java", 40, "第二处");
    toggleBookmark("C:\\work\\A.java", 10, "第一处");
    toggleBookmark("C:\\work\\B.java", 99, "别的文件");

    const { editor, collections } = fakeEditor();
    const off = attachBookmarkGutter(editor);

    expect(collections).toHaveLength(1);
    const decos = collections[0].set.mock.calls[0][0];
    expect(decos.map((d: { range: { startLineNumber: number } }) => d.range.startLineNumber)).toEqual([10, 40]);
    expect(decos[0].options.glyphMarginClassName).toBe("ncforge-bookmark-glyph");
    expect(decos[0].options.glyphMarginHoverMessage.value).toContain("第一处");
    off();
  });

  it("增删书签后重新铺（先清旧集合，不留残影）", () => {
    loadBookmarks(freshRoot());
    toggleBookmark("C:\\work\\A.java", 10, "");
    const { editor, collections } = fakeEditor();
    const off = attachBookmarkGutter(editor);

    toggleBookmark("C:\\work\\A.java", 20, "");
    expect(collections[0].clear).toHaveBeenCalled();
    expect(collections[1].set.mock.calls[0][0]).toHaveLength(2);

    clearBookmarks();
    expect(collections[1].clear).toHaveBeenCalled();
    // 没有书签了：不再新建集合，行号槽是空的
    expect(collections).toHaveLength(2);
    off();
  });

  it("越界的行号跳过（磁盘文件变短后不抛错）", () => {
    loadBookmarks(freshRoot());
    toggleBookmark("C:\\work\\A.java", 10, "");
    toggleBookmark("C:\\work\\A.java", 80, "");

    const { editor, collections } = fakeEditor(50);
    const off = attachBookmarkGutter(editor);
    expect(collections[0].set.mock.calls[0][0]).toHaveLength(1);
    off();
  });

  it("没有对应文件（如 jar 内类）时不画任何东西", () => {
    loadBookmarks(freshRoot());
    toggleBookmark("C:\\work\\A.java", 10, "");
    mocks.modelPath = "";
    const { editor, collections } = fakeEditor();
    const off = attachBookmarkGutter(editor);
    expect(collections).toHaveLength(0);
    off();
  });

  it("切换文件会重算（旧文件的装饰不跟着走）", () => {
    loadBookmarks(freshRoot());
    toggleBookmark("C:\\work\\A.java", 10, "");
    const { editor, collections, modelListeners } = fakeEditor();
    const off = attachBookmarkGutter(editor);
    expect(collections).toHaveLength(1);

    mocks.modelPath = "C:\\work\\B.java";
    modelListeners.forEach((cb) => cb());
    expect(collections[0].clear).toHaveBeenCalled();
    // B 没有书签：清掉旧集合后不再新建
    expect(collections).toHaveLength(1);
    off();
  });

  it("卸载时退订并清空装饰", () => {
    loadBookmarks(freshRoot());
    toggleBookmark("C:\\work\\A.java", 10, "");
    const { editor, collections } = fakeEditor();
    const off = attachBookmarkGutter(editor);
    off();
    expect(collections[0].clear).toHaveBeenCalled();
  });
});
