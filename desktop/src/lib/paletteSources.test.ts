import { beforeEach, describe, expect, it, vi } from "vitest";

const lang = vi.hoisted(() => ({ ready: false, request: vi.fn(), symbols: vi.fn() }));
const files = vi.hoisted(() => ({ list: [] as string[] }));

// lang / symbols 会间接拉起 Monaco，这里只验证「每种模式怎么选数据源」
vi.mock("./lang", () => ({ langReady: () => lang.ready, langRequest: lang.request, flushDoc: vi.fn() }));
vi.mock("./symbols", async (orig) => ({ ...(await orig<typeof import("./symbols")>()), fetchSymbols: lang.symbols }));
vi.mock("./fileIndex", async () => {
  const { toEntry } = await vi.importActual<typeof import("./fileIndex")>("./fileIndex");
  return { getFileIndex: async (root: string) => files.list.map((f) => toEntry(root, f)) };
});
vi.mock("./recentFiles", () => ({ getRecent: () => ["C:\\w\\gl\\B.java"] }));

import { registerCommands } from "./commandRegistry";
import { buildItems, type PaletteCtx } from "./paletteSources";

const run = { file: vi.fn(), jdt: vi.fn() };
const ctx = (over: Partial<PaletteCtx> = {}): PaletteCtx => ({ root: "C:\\w", activePath: "C:\\w\\gl\\A.java", openPaths: ["C:\\w\\gl\\A.java"], run, ...over });

beforeEach(() => {
  lang.ready = false;
  lang.request.mockReset();
  lang.symbols.mockReset();
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
});
