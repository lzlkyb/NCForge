// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUiDensity, getStoredUiDensity, getUiDensity, initializeUiDensity, subscribeUiDensity } from "./uiDensity";

beforeEach(() => { localStorage.clear(); delete document.documentElement.dataset.uiDensity; });
afterEach(() => { vi.restoreAllMocks(); delete document.documentElement.dataset.uiDensity; });

describe("界面密度", () => {
  it("默认标准密度，启动恢复已保存的舒适模式", () => {
    expect(getStoredUiDensity()).toBe("standard");
    localStorage.setItem("ncforge.ui-density", "comfortable");
    initializeUiDensity();
    expect(getUiDensity()).toBe("comfortable");
  });
  it("切换只改密度，保留主题、材质及既有输入节点", () => {
    const root = document.documentElement;
    root.classList.add("dark"); root.dataset.uiStyle = "glass";
    const input = document.createElement("textarea"); input.value = "未保存的编辑内容"; document.body.append(input);
    try {
      expect(applyUiDensity("comfortable")).toBe(true);
      expect(root.classList.contains("dark")).toBe(true);
      expect(root.dataset.uiStyle).toBe("glass");
      expect(input.isConnected).toBe(true); expect(input.value).toBe("未保存的编辑内容");
      expect(localStorage.getItem("ncforge.ui-density")).toBe("comfortable");
    } finally { input.remove(); root.classList.remove("dark"); delete root.dataset.uiStyle; }
  });
  it("重复选择不广播，取消订阅后不再通知", () => {
    const on = vi.fn(); const off = subscribeUiDensity(on);
    applyUiDensity("comfortable"); applyUiDensity("comfortable");
    expect(on).toHaveBeenCalledTimes(1);
    off(); applyUiDensity("standard"); expect(on).toHaveBeenCalledTimes(1);
  });
  it("存储不可用仍可切换，返回未保存状态", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    expect(applyUiDensity("comfortable")).toBe(false);
    expect(getUiDensity()).toBe("comfortable");
  });
});
