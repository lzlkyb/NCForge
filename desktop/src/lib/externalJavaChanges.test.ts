import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queue: vi.fn(),
  toast: vi.fn(),
  auto: true,
  external: true,
  root: "C:\\w" as string | null,
}));

vi.mock("./autoCompileQueue", () => ({ queueAutoCompile: mocks.queue }));
vi.mock("../components/ui/toast", () => ({ toast: mocks.toast }));
vi.mock("./appConfig", () => ({
  autoCompileCached: () => mocks.auto,
  autoExternalCached: () => mocks.external,
}));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ root: mocks.root }) }));

import { handleExternalJavaChanges, onExternalJavaChanged, EXTERNAL_BATCH_LIMIT } from "./externalJavaChanges";
import { resetLocalSaves, markLocalSave } from "./localSaves";

beforeEach(() => {
  mocks.queue.mockReset();
  mocks.toast.mockReset();
  mocks.auto = true;
  mocks.external = true;
  mocks.root = "C:\\w";
  resetLocalSaves();
});

describe("外部 .java 改动", () => {
  it("工作区内的 .java 进队列；非 java、工作区外、关联工程都挡掉", () => {
    handleExternalJavaChanges(
      ["C:\\w\\gl\\src\\A.java", "C:\\w\\gl\\p.xml", "D:\\other\\B.java", "C:\\w-备份\\C.java"],
      false,
    );
    expect(mocks.queue.mock.calls.map((c) => c[0])).toEqual(["C:\\w\\gl\\src\\A.java"]);
  });

  it("本应用刚保存的文件不再重复编", () => {
    markLocalSave("C:\\w\\gl\\src\\A.java");
    handleExternalJavaChanges(["C:\\w\\gl\\src\\A.java", "C:\\w\\gl\\src\\B.java"], false);
    expect(mocks.queue.mock.calls.map((c) => c[0])).toEqual(["C:\\w\\gl\\src\\B.java"]);
  });

  it("任一自动编译开关关掉就完全不处理", () => {
    mocks.external = false;
    handleExternalJavaChanges(["C:\\w\\gl\\src\\A.java"], false);
    mocks.external = true;
    mocks.auto = false;
    handleExternalJavaChanges(["C:\\w\\gl\\src\\A.java"], false);
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it("一次事件文件太多时只提示、不排队（切分支不该触发自动全编）", () => {
    const many = Array.from({ length: EXTERNAL_BATCH_LIMIT + 1 }, (_, i) => `C:\\w\\gl\\src\\C${i}.java`);
    handleExternalJavaChanges(many, false);
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(1);

    // 监听器标记溢出的情况同样不排队
    handleExternalJavaChanges([], true);
    expect(mocks.queue).not.toHaveBeenCalled();
  });
});

describe("审查通道（所有可审查文本文件）", () => {
  it(".java 之外的文本改动进审查监听，但不进编译队列", () => {
    const seen: string[][] = [];
    const off = onExternalJavaChanged((paths) => seen.push([...paths]));
    handleExternalJavaChanges(
      ["C:\\w\\gl\\src\\A.java"],
      false,
      ["C:\\w\\gl\\src\\A.java", "C:\\w\\gl\\mapper\\B.xml", "C:\\w\\gl\\db\\init.sql", "C:\\w\\gl\\web\\a.js"],
      false,
    );
    off();
    expect(seen).toEqual([["C:\\w\\gl\\src\\A.java", "C:\\w\\gl\\mapper\\B.xml", "C:\\w\\gl\\db\\init.sql", "C:\\w\\gl\\web\\a.js"]]);
    // 编译只认 .java：审查通道变宽不影响编译队列
    expect(mocks.queue.mock.calls.map((c) => c[0])).toEqual(["C:\\w\\gl\\src\\A.java"]);
  });

  it("二进制 / 构建产物目录不进审查监听", () => {
    const seen: string[][] = [];
    const off = onExternalJavaChanged((paths) => seen.push([...paths]));
    handleExternalJavaChanges([], false, ["C:\\w\\gl\\target\\A.class", "C:\\w\\gl\\x.png", "C:\\w\\gl\\node_modules\\a.js"], false);
    off();
    expect(seen).toEqual([]);
  });

  it("审查通道溢出只提示一次，且不排队编译", () => {
    vi.useFakeTimers();
    try {
      // 节流是模块级的：先越过别的用例留下的 60s 窗口，否则第一次就被吞掉
      vi.advanceTimersByTime(61_000);
      handleExternalJavaChanges([], false, [], true);
      handleExternalJavaChanges([], false, [], true);
      expect(mocks.toast.mock.calls.filter((c) => String(c[0]).includes("审查"))).toHaveLength(1);
      expect(mocks.queue).not.toHaveBeenCalled();
      // 窗口过后会再提示（不能一次卡死再也不说）
      vi.advanceTimersByTime(61_000);
      handleExternalJavaChanges([], false, [], true);
      expect(mocks.toast.mock.calls.filter((c) => String(c[0]).includes("审查"))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("老调用方只传两个参数时审查通道退化为编译通道", () => {
    const seen: string[][] = [];
    const off = onExternalJavaChanged((paths) => seen.push([...paths]));
    handleExternalJavaChanges(["C:\\w\\gl\\src\\A.java"], false);
    off();
    expect(seen).toEqual([["C:\\w\\gl\\src\\A.java"]]);
  });
});
