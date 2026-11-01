import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkReferences } from "./safeDelete";
import type { SearchHit, SearchOutcome } from "./search";

const mocks = vi.hoisted(() => ({ searchWorkspace: vi.fn() }));
vi.mock("./search", () => ({ searchWorkspace: mocks.searchWorkspace }));

const hit = (path: string, line = 1): SearchHit => ({ path, line, text: "", ranges: [] });

const outcome = (hits: SearchHit[], truncated = false): SearchOutcome => ({
  hits,
  filesScanned: 100,
  filesMatched: hits.length,
  truncated,
  elapsedMs: 3,
});

describe("checkReferences", () => {
  beforeEach(() => {
    mocks.searchWorkspace.mockReset();
    mocks.searchWorkspace.mockResolvedValue(outcome([]));
  });

  it("按类名做全工程文本搜索（不是 textDocument/references：被删的文件多半没打开）", async () => {
    await checkReferences("C:\\work\\newar\\nc\\vo\\VoucherBO.java");
    expect(mocks.searchWorkspace).toHaveBeenCalledWith({
      text: "\\bVoucherBO\\b",
      regex: true,
      caseSensitive: true,
      include: "*.java,*.xml",
      maxResults: 200,
    });
  });

  it("排除文件自己，只数别处的命中", async () => {
    mocks.searchWorkspace.mockResolvedValue(
      outcome([
        hit("nc/vo/VoucherBO.java"),
        hit("nc/bs/VoucherBS.java"),
        hit("nc/bs/VoucherBS.java", 40),
        hit("conf/updatenew.xml"),
      ]),
    );
    const r = await checkReferences("C:\\work\\newar\\nc\\vo\\VoucherBO.java");
    expect(r.count).toBe(3);
    // 样本去重（同一个文件的多个命中只列一次）
    expect(r.samples).toEqual(["nc/bs/VoucherBS.java", "conf/updatenew.xml"]);
    expect(r.truncated).toBe(false);
  });

  it("自我命中按「路径以 /文件名 结尾」比对，斜杠方向与大小写都不影响", async () => {
    mocks.searchWorkspace.mockResolvedValue(outcome([hit("NC/VO/voucherbo.java")]));
    const r = await checkReferences("c:/work/newar/nc/vo/VoucherBO.java");
    expect(r.count).toBe(0);
  });

  it("样本最多 5 个（再多也没人看）", async () => {
    mocks.searchWorkspace.mockResolvedValue(
      outcome([hit("a/A.java"), hit("b/B.java"), hit("c/C.java"), hit("d/D.java"), hit("e/E.java"), hit("f/F.java")]),
    );
    const r = await checkReferences("C:\\work\\x\\Z.java");
    expect(r.count).toBe(6);
    expect(r.samples).toHaveLength(5);
  });

  it("搜索被截断时把 truncated 传出来", async () => {
    mocks.searchWorkspace.mockResolvedValue(outcome([hit("a/A.java")], true));
    expect((await checkReferences("C:\\work\\x\\Z.java")).truncated).toBe(true);
  });

  it("非 .java 不搜（没有「类名引用」这回事）", async () => {
    expect(await checkReferences("C:\\work\\a.xml")).toEqual({ count: 0, samples: [], truncated: false });
    expect(mocks.searchWorkspace).not.toHaveBeenCalled();
  });

  it("文件名不是合法类名（带空格 / 连字符）就不搜", async () => {
    expect(await checkReferences("C:\\work\\My-Class.java")).toEqual({
      count: 0,
      samples: [],
      truncated: false,
    });
    expect(mocks.searchWorkspace).not.toHaveBeenCalled();
  });
});
