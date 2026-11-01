import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bookmarkAt,
  bookmarkLinesIn,
  bookmarkPathKey,
  clearBookmarks,
  countBookmarks,
  getBookmarks,
  loadBookmarks,
  removeBookmark,
  subscribeBookmarks,
  toggleBookmark,
} from "./bookmarks";
import { pathKey } from "./treeSvn";

/**
 * 书签按工作区隔离存在 localStorage。node 环境没有它，用内存替身。
 *
 * 这里重点验两件事：切换工作区不会串（指向别的工程的行号最坑）、
 * 加/去书签是可逆的且判定忽略路径大小写与斜杠方向。
 */
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

let n = 0;
/** 每个用例一个干净的工作区：`loadBookmarks` 对同一个 root 是幂等的。 */
const freshRoot = () => `C:\\work\\ws${(n += 1)}`;

describe("bookmarks", () => {
  beforeEach(() => store.clear());

  it("加书签返回 added，重复加同一行则是 removed", () => {
    loadBookmarks(freshRoot());
    expect(toggleBookmark("C:\\work\\A.java", 10, "  foo() ")).toBe("added");
    expect(getBookmarks()).toHaveLength(1);
    // note 去空白并截断，只是面板里的识别用
    expect(getBookmarks()[0].note).toBe("foo()");
    expect(toggleBookmark("C:\\work\\A.java", 10, "")).toBe("removed");
    expect(getBookmarks()).toHaveLength(0);
  });

  it("同一行判定忽略大小写与斜杠方向", () => {
    loadBookmarks(freshRoot());
    toggleBookmark("C:\\work\\A.java", 10, "");
    expect(bookmarkAt("c:/work/a.java", 10)).toBeDefined();
    expect(bookmarkAt("C:\\work\\A.java", 11)).toBeUndefined();
  });

  it("按工作区隔离：换工程不会读到上一个工程的书签", () => {
    const a = freshRoot();
    loadBookmarks(a);
    toggleBookmark("C:\\work\\A.java", 10, "");

    const b = freshRoot();
    loadBookmarks(b);
    expect(getBookmarks()).toHaveLength(0);

    loadBookmarks(a);
    expect(getBookmarks()).toHaveLength(1);
  });

  it("删除与清空都会落盘", () => {
    const root = freshRoot();
    loadBookmarks(root);
    toggleBookmark("C:\\work\\A.java", 10, "");
    toggleBookmark("C:\\work\\B.java", 20, "");
    removeBookmark("C:\\work\\A.java", 10);
    expect(getBookmarks().map((x) => x.path)).toEqual(["C:\\work\\B.java"]);

    clearBookmarks();
    expect(getBookmarks()).toHaveLength(0);

    const saved = JSON.parse(store.get(`ncforge-bookmarks:${root.toLowerCase()}`) ?? "[]");
    expect(saved).toEqual([]);
  });

  it("落盘里的坏数据不会把页面顶崩", () => {
    const root = freshRoot();
    store.set(`ncforge-bookmarks:${root.toLowerCase()}`, "{ not json");
    loadBookmarks(root);
    expect(getBookmarks()).toEqual([]);

    const root2 = freshRoot();
    store.set(`ncforge-bookmarks:${root2.toLowerCase()}`, '[{"path":"C:\\\\a.java","line":1},{"nope":1}]');
    loadBookmarks(root2);
    expect(getBookmarks().map((x) => x.path)).toEqual(["C:\\a.java"]);
  });

  it("按文件取行号：斜杠方向 / 大小写不影响，行号升序、带摘要", () => {
    loadBookmarks(freshRoot());
    toggleBookmark("C:\\work\\A.java", 30, "第三处");
    toggleBookmark("C:\\work\\A.java", 10, "第一处");
    toggleBookmark("C:\\work\\B.java", 20, "别的文件");

    expect(bookmarkLinesIn("c:/work/a.java")).toEqual([
      { line: 10, note: "第一处" },
      { line: 30, note: "第三处" },
    ]);
    expect(bookmarkLinesIn("C:\\work\\none.java")).toEqual([]);
  });

  it("行号槽的路径键与树上的 pathKey 同口径", () => {
    // 树的 pathKey 在 lib/treeSvn；两边口径要是分叉，树上的小旗就会和行号槽对不上
    const samples = ["C:\\work\\A.java", "c:/work/a.java/", "D:\\x\\y\\Z.java", "/tmp/a.java"];
    for (const s of samples) expect(bookmarkPathKey(s)).toBe(pathKey(s));
  });

  it("按文件计数：同一文件的多行累加，键可直接给树用", () => {
    loadBookmarks(freshRoot());
    toggleBookmark("C:\\work\\A.java", 10, "");
    toggleBookmark("C:\\work\\A.java", 20, "");
    toggleBookmark("C:\\work\\B.java", 30, "");

    const counts = countBookmarks(getBookmarks());
    expect(counts.get("c:/work/a.java")).toBe(2);
    expect(counts.get("c:/work/b.java")).toBe(1);
    expect(counts.size).toBe(2);
  });

  it("非 React 订阅（Monaco 行号槽）在增删与清空时都会收到通知", () => {
    loadBookmarks(freshRoot());
    let hits = 0;
    const off = subscribeBookmarks(() => {
      hits += 1;
    });
    toggleBookmark("C:\\work\\A.java", 10, "");
    removeBookmark("C:\\work\\A.java", 10);
    clearBookmarks();
    off();
    clearBookmarks();
    expect(hits).toBe(3);
  });
});
