import { beforeEach, describe, expect, it, vi } from "vitest";

const lang = vi.hoisted(() => ({ ready: false, request: vi.fn(), symbols: vi.fn() }));
const files = vi.hoisted(() => ({ list: [] as string[] }));
const search = vi.hoisted(() => ({ run: vi.fn() }));

// lang / symbols 会间接拉起 Monaco，这里只验证「每种模式怎么选数据源」
vi.mock("./lang", () => ({ langReady: () => lang.ready, langRequest: lang.request, flushDoc: vi.fn() }));
vi.mock("./symbols", async (orig) => ({ ...(await orig<typeof import("./symbols")>()), fetchSymbols: lang.symbols }));
vi.mock("./fileIndex", async () => {
  const { toEntry } = await vi.importActual<typeof import("./fileIndex")>("./fileIndex");
  return { getFileIndex: async (root: string) => files.list.map((f) => toEntry(root, f)) };
});
vi.mock("./recentFiles", () => ({ getRecent: () => ["C:\\w\\gl\\B.java"] }));
vi.mock("./search", () => ({ searchWorkspace: search.run }));

import { registerCommands } from "./commandRegistry";
import { buildItems, type PaletteCtx } from "./paletteSources";

const run = { file: vi.fn(), jdt: vi.fn() };
const ctx = (over: Partial<PaletteCtx> = {}): PaletteCtx => ({ root: "C:\\w", activePath: "C:\\w\\gl\\A.java", openPaths: ["C:\\w\\gl\\A.java"], run, ...over });

beforeEach(() => {
  lang.ready = false;
  lang.request.mockReset();
  lang.symbols.mockReset();
  search.run.mockReset();
  run.file.mockReset();
  run.jdt.mockReset();
  files.list = ["gl/A.java", "gl/B.java", "gl/VoucherBO.java", "gl/voucher.xml"];
});

describe("文件模式", () => {
  it("空查询：显示最近打开的，且不含当前标签", async () => {
    const r = await buildItems("file", "", ctx());
    expect(r.items.map((i) => i.title)).toEqual(["B.java"]);
    expect(r.note).toBe("最近打开");
  });

  it("有查询：模糊匹配，已打开的文件标「已打开」，回车打开对应路径", async () => {
    const r = await buildItems("file", "a.j", ctx());
    const a = r.items.find((i) => i.title === "A.java")!;
    expect(a.badge).toBe("已打开");
    a.run();
    expect(run.file).toHaveBeenCalledWith("C:\\w\\gl\\A.java");
  });

  it("没有工程：给提示不抛错", async () => {
    expect((await buildItems("file", "x", ctx({ root: null }))).note).toBe("尚未打开工程");
  });
});

describe("类型模式", () => {
  it("代码智能未就绪：退回工作区 .java 文件名，标题去掉扩展名", async () => {
    const r = await buildItems("type", "vbo", ctx());
    expect(r.items.map((i) => i.title)).toEqual(["VoucherBO"]);
    expect(r.note).toContain("未就绪");
    expect(lang.request).not.toHaveBeenCalled();
  });

  it("代码智能就绪：用 workspace/symbol，只留类 / 接口 / 枚举，jdt:// 标 jar 并走 jdt 打开", async () => {
    lang.ready = true;
    lang.request.mockResolvedValue([
      { name: "IVoucher", kind: 11, containerName: "nc.itf", location: { uri: "file:///C:/w/gl/IVoucher.java", range: { start: { line: 4, character: 7 } } } },
      { name: "IVoucherConst", kind: 11, containerName: "nc.vo", location: { uri: "jdt://contents/a.jar/nc.vo/IVoucherConst.class", range: { start: { line: 0, character: 0 } } } },
      { name: "save", kind: 6, location: { uri: "file:///C:/w/gl/IVoucher.java", range: { start: { line: 9, character: 2 } } } },
    ]);
    const r = await buildItems("type", "IVouch", ctx());
    expect(r.items.map((i) => i.title)).toEqual(["IVoucher", "IVoucherConst"]);
    expect(r.items[1].badge).toBe("jar");
    r.items[0].run();
    expect(run.file).toHaveBeenCalledWith("C:\\w\\gl\\IVoucher.java", 5, 8);
    r.items[1].run();
    expect(run.jdt).toHaveBeenCalledWith("jdt://contents/a.jar/nc.vo/IVoucherConst.class", 1, 1);
  });

  it("空查询只给提示，不发请求", async () => {
    lang.ready = true;
    expect((await buildItems("type", "", ctx())).items).toEqual([]);
    expect(lang.request).not.toHaveBeenCalled();
  });
});

describe("符号模式", () => {
  it("非 Java 文件 / 未就绪都给原因", async () => {
    expect((await buildItems("symbol", "", ctx({ activePath: "C:\\w\\a.xml" }))).note).toContain("Java");
    expect((await buildItems("symbol", "", ctx())).note).toContain("未就绪");
  });

  it("列出当前文件的符号并按查询过滤，回车跳到该行", async () => {
    lang.ready = true;
    lang.symbols.mockResolvedValue([
      { name: "save", kind: 6, container: "A", line: 5, column: 10, startLine: 5, endLine: 9, depth: 1 },
      { name: "load", kind: 6, container: "A", line: 12, column: 10, startLine: 12, endLine: 15, depth: 1 },
    ]);
    const r = await buildItems("symbol", "sav", ctx());
    expect(r.items.map((i) => i.title)).toEqual(["save"]);
    r.items[0].run();
    expect(run.file).toHaveBeenCalledWith("C:\\w\\gl\\A.java", 5, 10);
  });
});

describe("工作区符号模式（方法 / 字段级）", () => {
  const sym = (name: string, kind: number, container?: string, uri = "file:///C%3A/w/gl/A.java") => ({
    name,
    kind,
    containerName: container,
    location: { uri, range: { start: { line: 4, character: 8 } } },
  });

  it("空查询与未就绪都给提示，不打语言服务", async () => {
    expect((await buildItems("sym", "", ctx())).note).toContain("方法名");
    expect((await buildItems("sym", "save", ctx())).note).toContain("未就绪");
    expect(lang.request).not.toHaveBeenCalled();
  });

  it("只留方法与字段（类 / 接口那些交给「类型」模式）", async () => {
    lang.ready = true;
    lang.request.mockResolvedValue([
      sym("save", 6, "A"),
      sym("count", 8, "A"),
      sym("VoucherBO", 5, ""),
      sym("A", 23, ""),
    ]);
    const r = await buildItems("sym", "s", ctx());
    expect(r.items.map((i) => i.title)).toEqual(["save", "count"]);
    expect(r.items[0].kind).toBe("M");
    expect(r.items[0].detail).toBe("A");
  });

  it("请求的是 workspace/symbol，回车跳到命中位置（行号 1 基）", async () => {
    lang.ready = true;
    lang.request.mockResolvedValue([sym("save", 6)]);
    const r = await buildItems("sym", "save", ctx());
    expect(lang.request.mock.calls[0][0]).toBe("workspace/symbol");
    r.items[0].run();
    expect(run.file).toHaveBeenCalledWith("C:\\w\\gl\\A.java", 5, 9);
  });

  it("jar 里的符号标记为 jar 并走 jdt 打开", async () => {
    lang.ready = true;
    lang.request.mockResolvedValue([sym("getStatus", 6, "BillVO", "jdt://contents/x.class")]);
    const r = await buildItems("sym", "status", ctx());
    expect(r.items[0].badge).toBe("jar");
    r.items[0].run();
    expect(run.jdt).toHaveBeenCalled();
    expect(run.file).not.toHaveBeenCalled();
  });
});

describe("命令模式", () => {
  it("只列出已登记且 enabled 的命令，模糊过滤", async () => {
    const hit = vi.fn();
    const off = registerCommands([
      { id: "a", title: "编译当前模块", hint: "F9", run: hit },
      { id: "b", title: "取消编译", run: () => {}, enabled: () => false },
    ]);
    const r = await buildItems("cmd", "编译", ctx());
    expect(r.items.map((i) => i.title)).toEqual(["编译当前模块"]);
    expect(r.items[0].hint).toBe("F9");
    r.items[0].run();
    expect(hit).toHaveBeenCalled();
    off();
    expect((await buildItems("cmd", "编译", ctx())).items).toEqual([]);
  });

  it("拼音首字母能命中中文命令，高亮区间映射回标题", async () => {
    const off = registerCommands([{ id: "py", title: "编译当前模块", run: () => {} }]);
    const r = await buildItems("cmd", "bydq", ctx());
    expect(r.items.map((i) => i.title)).toEqual(["编译当前模块"]);
    expect(r.items[0].ranges).toEqual([[0, 4]]);
    off();
  });
});

describe("转到任意位置：内容与行号", () => {
  it("#内容：把相对命中拼回绝对路径，最近打开的文件排前面", async () => {
    search.run.mockResolvedValue({
      hits: [
        { path: "gl/A.java", line: 10, text: "  saveBo();", ranges: [{ start: 2, end: 6 }] },
        { path: "gl/B.java", line: 3, text: "  saveBo();", ranges: [{ start: 2, end: 6 }] },
      ],
      filesScanned: 2,
      filesMatched: 2,
      truncated: false,
      elapsedMs: 5,
    });
    const r = await buildItems("file", "#saveBo", ctx());
    expect(search.run).toHaveBeenCalledWith({ text: "saveBo", maxResults: 50 });
    // 最近打开的是 B.java（见 recentFiles mock），它的命中排第一
    expect(r.items.map((i) => i.detail)).toEqual(["gl/B.java:3", "gl/A.java:10"]);
    r.items[0].run();
    expect(run.file).toHaveBeenCalledWith("C:\\w\\gl\\B.java", 3, 3);
  });

  it("#内容：空关键词与后端失败都给出说明，不假装没有结果", async () => {
    expect((await buildItems("file", "#  ", ctx())).note).toContain("输入");
    search.run.mockRejectedValue(new Error("扫描超时"));
    expect((await buildItems("file", "#abc", ctx())).note).toContain("扫描超时");
  });

  it(":行号 跳到当前文件的指定位置；带列号时按列落点", async () => {
    const r = await buildItems("file", ":42:7", ctx());
    expect(r.items).toHaveLength(1);
    expect(r.items[0].title).toContain("42");
    r.items[0].run();
    expect(run.file).toHaveBeenCalledWith("C:\\w\\gl\\A.java", 42, 7);
  });

  it(":行号 对 jar 内的类走 jdt", async () => {
    const uri = "jdt://contents/a.jar/nc.vo/A.class";
    const r = await buildItems("file", ":9", ctx({ activePath: uri }));
    r.items[0].run();
    expect(run.jdt).toHaveBeenCalledWith(uri, 9, 1);
  });

  it(":行号 解析不了 / 没有打开文件时只给提示", async () => {
    expect((await buildItems("file", ":abc", ctx())).items).toEqual([]);
    expect((await buildItems("file", ":12", ctx({ activePath: null }))).note).toContain("先打开");
  });
});
