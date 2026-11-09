// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlFormatSettings } from "./SqlFormatSettings";
import { DEFAULT_SQL_FORMAT, getSqlFormatPrefs, setSqlFormatPrefs } from "../../lib/sqlFormatPrefs";

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

    act(() => radio("缩进风格", "表格·左对齐").click());
    expect(getSqlFormatPrefs().indentStyle).toBe("tabularLeft");

    act(() => radio("SQL 方言", "MySQL").click());
    expect(getSqlFormatPrefs().dialect).toBe("mysql");
  });

  it("当前值反映在选中态上", () => {
    act(() => radio("关键字大小写", "小写").click());
    expect(radio("关键字大小写", "小写").getAttribute("aria-checked")).toBe("true");
    expect(radio("关键字大小写", "保持原样").getAttribute("aria-checked")).toBe("false");
  });
});
