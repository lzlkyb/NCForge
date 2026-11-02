import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContent } from "./workspace";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  getText: vi.fn(),
  replaceContent: vi.fn(),
  captureLocalHistory: vi.fn(),
}));

vi.mock("./workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace")>();
  return { ...actual, readFile: mocks.readFile, writeFile: mocks.writeFile };
});
vi.mock("./editorStore", () => ({ getText: mocks.getText, replaceContent: mocks.replaceContent }));
vi.mock("./localHistory", () => ({ captureLocalHistory: mocks.captureLocalHistory }));

import { saveLineEdits } from "./searchEdit";

const ROOT = "C:\\w";

const file = (text: string, over: Partial<FileContent> = {}): FileContent => ({
  text,
  encoding: "UTF-8",
  hasBom: false,
  eol: "CRLF",
  lossless: true,
  size: text.length,
  mtimeMs: 100,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeFile.mockResolvedValue(200);
  mocks.captureLocalHistory.mockResolvedValue(undefined);
  mocks.getText.mockReturnValue(undefined);
});

describe("saveLineEdits", () => {
  it("逐文件只读一次、写一次，按原编码 / 换行写回并回写新 mtime", async () => {
    mocks.readFile
      .mockResolvedValueOnce(file("a\nb\nc"))
      .mockResolvedValueOnce(file("x\ny", { eol: "LF" }));

    const r = await saveLineEdits(ROOT, [
      { path: "p/A.java", line: 2, original: "b", value: "B" },
      { path: "p/B.java", line: 1, original: "x", value: "X" },
    ]);

    expect(r).toEqual({
      filesChanged: 2,
      linesChanged: 2,
      saved: [
        { path: "p/A.java", line: 2, value: "B" },
        { path: "p/B.java", line: 1, value: "X" },
      ],
      skipped: [],
    });
    expect(mocks.writeFile).toHaveBeenNthCalledWith(1, {
      path: "C:\\w\\p\\A.java",
      text: "a\nB\nc",
      encoding: "UTF-8",
      hasBom: false,
      eol: "CRLF",
      expectedMtimeMs: 100,
    });
    expect(mocks.writeFile).toHaveBeenNthCalledWith(2, expect.objectContaining({ path: "C:\\w\\p\\B.java", text: "X\ny", eol: "LF" }));
  });

  it("预览后行内容变了就不写：按整行原文比对，防止覆盖别人的修改", async () => {
    mocks.readFile.mockResolvedValue(file("a\nchanged"));

    const r = await saveLineEdits(ROOT, [
      { path: "p/A.java", line: 2, original: "b", value: "B" },
    ]);

    expect(r.filesChanged).toBe(0);
    expect(r.skipped[0]).toContain("已被改动");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("编辑器里有未保存改动时跳过，免得写盘后被 Ctrl+S 覆盖", async () => {
    mocks.readFile.mockResolvedValue(file("a\nb"));
    mocks.getText.mockReturnValue("a\nunsaved");

    const r = await saveLineEdits(ROOT, [
      { path: "p/A.java", line: 2, original: "b", value: "B" },
    ]);

    expect(r.skipped[0]).toContain("未保存改动");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("编码无法无损往返、混合换行都不硬写", async () => {
    mocks.readFile
      .mockResolvedValueOnce(file("a", { lossless: false }))
      .mockResolvedValueOnce(file("a", { eol: "MIXED" }));

    const r = await saveLineEdits(ROOT, [
      { path: "p/A.java", line: 1, original: "a", value: "A" },
      { path: "p/B.java", line: 1, original: "a", value: "A" },
    ]);

    expect(r.filesChanged).toBe(0);
    expect(r.skipped.join("")).toContain("无损");
    expect(r.skipped.join("")).toContain("混合换行");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("同一文件多行一次写完；重复命中行只算一次；带换行的值跳过", async () => {
    mocks.readFile.mockResolvedValue(file("a\nb\nc"));

    const r = await saveLineEdits(ROOT, [
      { path: "p/A.java", line: 1, original: "a", value: "A" },
      { path: "p/A.java", line: 1, original: "a", value: "A" },
      { path: "p/A.java", line: 3, original: "c", value: "c2" },
      { path: "p/A.java", line: 2, original: "b", value: "B\nC" },
    ]);

    expect(r.filesChanged).toBe(1);
    expect(r.linesChanged).toBe(2);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledWith(expect.objectContaining({ text: "A\nb\nc2" }));
    expect(r.skipped.join("")).toContain("不支持换行");
  });

  it("没有改动时连文件都不读", async () => {
    const r = await saveLineEdits(ROOT, [
      { path: "p/A.java", line: 1, original: "a", value: "a" },
    ]);
    expect(r).toEqual({ filesChanged: 0, linesChanged: 0, saved: [], skipped: [] });
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("写盘失败逐文件汇报，不中断其它文件", async () => {
    mocks.readFile
      .mockResolvedValueOnce(file("a"))
      .mockResolvedValueOnce(file("x"));
    mocks.writeFile.mockRejectedValueOnce(new Error("CONFLICT:磁盘已变")).mockResolvedValueOnce(200);

    const r = await saveLineEdits(ROOT, [
      { path: "p/A.java", line: 1, original: "a", value: "A" },
      { path: "p/B.java", line: 1, original: "x", value: "X" },
    ]);

    expect(r.filesChanged).toBe(1);
    expect(r.skipped[0]).toContain("磁盘已变");
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
  });

  it("打开且干净的文件写完同步编辑器内容", async () => {
    mocks.readFile.mockResolvedValue(file("a\nb"));
    mocks.getText.mockReturnValue("a\nb");

    await saveLineEdits(ROOT, [{ path: "p/A.java", line: 2, original: "b", value: "B" }]);

    expect(mocks.replaceContent).toHaveBeenCalledWith(
      "C:\\w\\p\\A.java",
      expect.objectContaining({ text: "a\nB", mtimeMs: 200 }),
    );
  });
});
