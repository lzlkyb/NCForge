import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  langConfigSet: vi.fn(),
  applyLangPrefs: vi.fn(),
  startLangNow: vi.fn(),
}));

vi.mock("./appConfig", () => ({ langConfigSet: mocks.langConfigSet }));
vi.mock("./lang", () => ({ applyLangPrefs: mocks.applyLangPrefs, startLangNow: mocks.startLangNow }));

import { setLightMode } from "./lightMode";

const cfg = (enabled: boolean) => ({ lang_enabled: enabled, lang_auto_start: true });

beforeEach(() => vi.clearAllMocks());

describe("setLightMode", () => {
  it("进入轻量模式：把代码智能总开关关掉并同步状态栏，不拉起 jdt.ls", async () => {
    mocks.langConfigSet.mockResolvedValue(cfg(false));

    const r = await setLightMode(true, "C:\\w\\gl\\A.java");

    expect(r.ok).toBe(true);
    expect(mocks.langConfigSet).toHaveBeenCalledWith({ lang_enabled: false });
    expect(mocks.applyLangPrefs).toHaveBeenCalledWith(cfg(false));
    expect(mocks.startLangNow).not.toHaveBeenCalled();
  });

  it("退出轻量模式：当前是 .java 就立即拉回，不用等用户再切文件", async () => {
    mocks.langConfigSet.mockResolvedValue(cfg(true));

    const r = await setLightMode(false, "C:\\w\\gl\\A.java");

    expect(r.ok).toBe(true);
    expect(mocks.langConfigSet).toHaveBeenCalledWith({ lang_enabled: true });
    expect(mocks.startLangNow).toHaveBeenCalledWith("C:\\w\\gl\\A.java");
  });

  it("退出时当前不是 .java 就不白拉服务", async () => {
    mocks.langConfigSet.mockResolvedValue(cfg(true));
    await setLightMode(false, "C:\\w\\readme.md");
    expect(mocks.startLangNow).not.toHaveBeenCalled();
  });

  it("保存失败时把原因交回调用方，不假装切换成功", async () => {
    mocks.langConfigSet.mockRejectedValue(new Error("磁盘只读"));
    const r = await setLightMode(true, "C:\\w\\gl\\A.java");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("切换轻量模式失败");
    expect(mocks.applyLangPrefs).not.toHaveBeenCalled();
  });
});
