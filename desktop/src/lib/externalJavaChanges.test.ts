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

import { handleExternalJavaChanges, EXTERNAL_BATCH_LIMIT } from "./externalJavaChanges";
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
