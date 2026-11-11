// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFormatSettings } from "./SqlFormatSettings";
import { DEFAULT_SQL_FORMAT, getSqlFormatPrefs, setSqlFormatPrefs } from "../../lib/sqlFormatPrefs";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  setSqlFormatPrefs(DEFAULT_SQL_FORMAT);
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<SqlFormatSettings />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function radio(group: string, label: string): HTMLButtonElement {
  const box = host.querySelector(`[role="radiogroup"][aria-label="${group}"]`)!;
  return [...box.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) => item.textContent === label)!;
}

describe("SQL 格式化设置", () => {
  it("渲染排版与方言控件，单选即时写入本机偏好", () => {
    expect(host.textContent).toContain("关键字大小写");
    expect(host.textContent).toContain("缩进风格");
    expect(host.textContent).toContain("方言");

    act(() => radio("关键字大小写", "大写").click());
    expect(getSqlFormatPrefs().keywordCase).toBe("upper");

    act(() => radio("SQL 排版方式", "结构展开").click());
    act(() => radio("缩进风格", "表格·左对齐").click());
    expect(getSqlFormatPrefs().indentStyle).toBe("tabularLeft");

    act(() => { const select = host.querySelector<HTMLSelectElement>('[aria-label="SQL 方言"]')!; select.value = "mysql"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(getSqlFormatPrefs().dialect).toBe("mysql");
  });

  it("阅读优先默认120列，切换布局保留表格对齐偏好", async () => {
    expect(radio("SQL 排版方式", "阅读优先").getAttribute("aria-checked")).toBe("true");
    const width = host.querySelector<HTMLInputElement>('[aria-label="SQL 目标行宽"]')!;
    expect(width.value).toBe("120");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(width, "100");
      width.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => width.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(getSqlFormatPrefs().lineWidth).toBe(100);
    act(() => radio("SQL 排版方式", "结构展开").click());
    expect(width.disabled).toBe(true);
    act(() => radio("缩进风格", "表格·右对齐").click());
    act(() => radio("SQL 排版方式", "阅读优先").click());
    expect(radio("缩进风格", "标准").disabled).toBe(true);
    expect(getSqlFormatPrefs().indentStyle).toBe("tabularRight");
    act(() => radio("SQL 排版方式", "结构展开").click());
    expect(radio("缩进风格", "表格·右对齐").getAttribute("aria-checked")).toBe("true");
  });

  it("当前值反映在选中态上", () => {
    act(() => radio("关键字大小写", "小写").click());
    expect(radio("关键字大小写", "小写").getAttribute("aria-checked")).toBe("true");
    expect(radio("关键字大小写", "保持原样").getAttribute("aria-checked")).toBe("false");
  });
  it("数值持久化失败不能显示已保存，同值可以重试", async () => {
    const field = host.querySelector<HTMLInputElement>("#sql-format-tab input")!;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("只读"); });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "4");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(host.querySelector("#sql-format-tab")?.textContent).toContain("未保存到本机");
    expect(host.querySelector("#sql-format-tab")?.textContent).not.toContain("已保存");
    expect(field.value).toBe("4");
    write.mockRestore();
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(host.querySelector("#sql-format-tab")?.textContent).toContain("已保存");
    expect(JSON.parse(localStorage.getItem("ncforge-sql-format-prefs")!).tabWidth).toBe(4);
  });
  it("恢复排版默认值先确认，取消不改偏好", () => {
    act(() => radio("关键字大小写", "大写").click());
    const reset = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "恢复 SQL 排版默认值")!;
    const dialogButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === label)!;
    act(() => reset().click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(getSqlFormatPrefs().keywordCase).toBe("upper");
    act(() => dialogButton("取消").click());
    expect(getSqlFormatPrefs().keywordCase).toBe("upper");
    act(() => reset().click());
    act(() => dialogButton("恢复默认").click());
    expect(getSqlFormatPrefs()).toEqual(DEFAULT_SQL_FORMAT);
  });
});
