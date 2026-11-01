import { beforeEach, describe, expect, it, vi } from "vitest";
import { findTestPair, goToTestPair, subjectCandidates, testCandidates } from "./goToTest";
import type { FileEntry } from "./fuzzy";

const mocks = vi.hoisted(() => ({
  getFileIndex: vi.fn(async (): Promise<FileEntry[]> => []),
  navigate: vi.fn(),
  toast: vi.fn(),
  getSession: vi.fn(() => ({ root: "C:\\work\\newar" }) as { root: string }),
}));

vi.mock("./fileIndex", () => ({ getFileIndex: mocks.getFileIndex }));
vi.mock("./lang", () => ({ navigate: mocks.navigate }));
vi.mock("../components/ui/toast", () => ({ toast: mocks.toast }));
vi.mock("./workspaceSession", () => ({ getSession: mocks.getSession }));

/** 相对路径 → 索引条目（path 用反斜杠，与后端返回一致）。 */
const entry = (rel: string): FileEntry => {
  const slash = rel.lastIndexOf("/");
  return {
    path: `C:\\work\\newar\\${rel.replace(/\//g, "\\")}`,
    rel,
    name: slash < 0 ? rel : rel.slice(slash + 1),
    dir: slash < 0 ? "" : rel.slice(0, slash),
  };
};

const ROOT = "C:\\work\\newar";

describe("候选名", () => {
  it("被测类 → 测试类：后缀优先，再试前缀", () => {
    expect(testCandidates("VoucherBO")).toEqual([
      "VoucherBOTest",
      "VoucherBOTests",
      "VoucherBOTestCase",
      "VoucherBOIT",
      "TestVoucherBO",
      "AbstractVoucherBO",
    ]);
  });

  it("测试类 → 被测类：剥后缀；前缀只认 Test（Abstract 不算测试前缀）", () => {
    expect(subjectCandidates("VoucherBOTest")).toEqual(["VoucherBO"]);
    expect(subjectCandidates("VoucherBOIT")).toEqual(["VoucherBO"]);
    expect(subjectCandidates("TestVoucherBO")).toEqual(["VoucherBO"]);
    expect(subjectCandidates("VoucherBO")).toEqual([]);
    // 全是后缀本身（长度相等）也不算
    expect(subjectCandidates("Test")).toEqual([]);
  });
});

describe("findTestPair", () => {
  beforeEach(() => {
    mocks.getFileIndex.mockReset();
    mocks.getFileIndex.mockResolvedValue([]);
  });

  it("优先同目录：main 与 test 两个同名类都在时先认并排的那个", async () => {
    mocks.getFileIndex.mockResolvedValue([
      entry("gl/src/main/java/nc/vo/VoucherBO.java"),
      entry("gl/src/main/java/nc/vo/VoucherBOTest.java"),
      entry("gl/src/test/java/nc/vo/VoucherBOTest.java"),
    ]);
    const link = await findTestPair(ROOT, `${ROOT}\\gl\\src\\main\\java\\nc\\vo\\VoucherBO.java`);
    expect(link).toEqual({
      path: `${ROOT}\\gl\\src\\main\\java\\nc\\vo\\VoucherBOTest.java`,
      direction: "toTest",
    });
  });

  it("不同目录只有一个同名类时用它", async () => {
    mocks.getFileIndex.mockResolvedValue([
      entry("gl/src/main/java/nc/vo/VoucherBO.java"),
      entry("pm/test/nc/vo/VoucherBOTest.java"),
    ]);
    const link = await findTestPair(ROOT, `${ROOT}\\gl\\src\\main\\java\\nc\\vo\\VoucherBO.java`);
    expect(link?.path).toBe(`${ROOT}\\pm\\test\\nc\\vo\\VoucherBOTest.java`);
  });

  it("多个同名且都不在 test 目录时取索引里的第一个（不乱序）", async () => {
    mocks.getFileIndex.mockResolvedValue([
      entry("a/VoucherBOTest.java"),
      entry("b/VoucherBOTest.java"),
    ]);
    const link = await findTestPair(ROOT, `${ROOT}\\a\\VoucherBO.java`);
    expect(link?.path).toBe(`${ROOT}\\a\\VoucherBOTest.java`);
  });

  it("当前就是测试类时反向找被测类", async () => {
    mocks.getFileIndex.mockResolvedValue([
      entry("nc/vo/VoucherBO.java"),
      entry("nc/vo/VoucherBOTest.java"),
    ]);
    const link = await findTestPair(ROOT, `${ROOT}\\nc\\vo\\VoucherBOTest.java`);
    expect(link).toEqual({ path: `${ROOT}\\nc\\vo\\VoucherBO.java`, direction: "toSubject" });
  });

  it("找不到配对返回 null（调用方才好给一句明确的话）", async () => {
    mocks.getFileIndex.mockResolvedValue([entry("nc/vo/VoucherBO.java")]);
    expect(await findTestPair(ROOT, `${ROOT}\\nc\\vo\\VoucherBO.java`)).toBeNull();
  });

  it("非 .java 不参与配对", async () => {
    mocks.getFileIndex.mockResolvedValue([entry("a.xml"), entry("a.xml.bak")]);
    expect(await findTestPair(ROOT, `${ROOT}\\a.xml`)).toBeNull();
    expect(mocks.getFileIndex).not.toHaveBeenCalled();
  });
});

describe("goToTestPair", () => {
  beforeEach(() => {
    mocks.getFileIndex.mockReset();
    mocks.navigate.mockReset();
    mocks.toast.mockReset();
  });

  it("找到就跳过去并提示方向", async () => {
    mocks.getFileIndex.mockResolvedValue([
      entry("nc/vo/VoucherBO.java"),
      entry("nc/vo/VoucherBOTest.java"),
    ]);
    await goToTestPair(`${ROOT}\\nc\\vo\\VoucherBO.java`);
    expect(mocks.navigate).toHaveBeenCalledWith({
      kind: "file",
      path: `${ROOT}\\nc\\vo\\VoucherBOTest.java`,
      line: 1,
      column: 1,
    });
    expect(mocks.toast).toHaveBeenCalledWith("已跳到测试类", "success");
  });

  it("没找到时把找过哪些名字说出来，而不是静默", async () => {
    mocks.getFileIndex.mockResolvedValue([]);
    await goToTestPair(`${ROOT}\\nc\\vo\\VoucherBO.java`);
    expect(mocks.navigate).not.toHaveBeenCalled();
    const [msg, kind] = mocks.toast.mock.calls[0];
    expect(kind).toBe("info");
    expect(msg).toContain("没有找到 VoucherBO 的测试类");
    expect(msg).toContain("VoucherBOTest");
  });

  it("没打开文件 / 不是 Java / 没工作区都各给一句", async () => {
    await goToTestPair(null);
    expect(mocks.toast).toHaveBeenLastCalledWith("先打开一个 Java 文件", "info");

    await goToTestPair(`${ROOT}\\a.xml`);
    expect(mocks.toast).toHaveBeenLastCalledWith("只有 Java 文件有测试配对", "info");

    mocks.getSession.mockReturnValueOnce({ root: "" });
    await goToTestPair(`${ROOT}\\a.java`);
    expect(mocks.toast).toHaveBeenLastCalledWith("先打开一个 Java 文件", "info");
  });
});
