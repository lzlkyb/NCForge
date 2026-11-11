// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFormatPreview } from "./SqlFormatPreview";
import { DEFAULT_SQL_FORMAT } from "../../lib/sqlFormatPrefs";

const mocks = vi.hoisted(() => ({ format: vi.fn(), url: "" }));
vi.mock("../../lib/dbStore", () => ({ useDbSelector: () => mocks.url }));
vi.mock("../../lib/sqlFormat", async () => {
  const actual = await vi.importActual<typeof import("../../lib/sqlFormat")>("../../lib/sqlFormat");
  return { ...actual, formatSql: mocks.format };
});

let root: Root, host: HTMLDivElement;
const render = (layout = "reading") => act(() => root.render(<SqlFormatPreview prefs={{ ...DEFAULT_SQL_FORMAT, layout: layout as "reading" | "expanded" }} />));
const select = (id: string) => act(() => {
  const input = host.querySelector<HTMLSelectElement>("select")!;
  input.value = id;
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
beforeEach(() => {
  vi.useFakeTimers(); mocks.url = ""; mocks.format.mockReset().mockResolvedValue("select a from t");
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("SQL 排版预览", () => {
  it("NC示例使用完整用户SQL和Oracle，偏好透传统一入口，显示文本指标", async () => {
    render(); select("nc");
    await act(async () => vi.runAllTimersAsync());
    const [sql, language, opts] = mocks.format.mock.calls[mocks.format.mock.calls.length - 1];
    expect(sql).toContain("project_reportname");
    expect(sql).toContain("rownum_ > 0");
    expect(language).toBe("plsql");
    expect(opts).toMatchObject({ layout: "reading", lineWidth: 120 });
    expect(host.textContent).toContain("无连接预览 · Oracle");
    expect(host.textContent).toContain("3 行");
    expect(host.textContent).toContain("仅预览，不会执行");
  });

  it("手动方言覆盖样例方言，空输入不调用格式化", async () => {
    act(() => root.render(<SqlFormatPreview prefs={{ ...DEFAULT_SQL_FORMAT, dialect: "mysql" }} />));
    select("nc");
    await act(async () => vi.runAllTimersAsync());
    expect(mocks.format.mock.calls[mocks.format.mock.calls.length - 1][1]).toBe("mysql");
    mocks.format.mockClear(); select("custom");
    await act(async () => vi.runAllTimersAsync());
    expect(mocks.format).not.toHaveBeenCalled();
    expect(host.textContent).toContain("请输入 SQL 查看预览");
  });

  it("粘贴SQL只在本页预览，失败保留原文并给出恢复提示", async () => {
    render(); select("custom");
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "select * from (broken");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    mocks.format.mockRejectedValue(new Error("Parse error"));
    await act(async () => vi.runAllTimersAsync());
    expect(input.value).toBe("select * from (broken");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("原文已保留");
    expect(host.textContent).toContain("调整方言后重试");
  });

  it("切换排版方式后不显示旧请求的迟到结果", async () => {
    let old!: (text: string) => void;
    mocks.format.mockReturnValueOnce(new Promise<string>(resolve => { old = resolve; }));
    render(); await act(async () => vi.runAllTimersAsync());
    mocks.format.mockResolvedValue("expanded preview"); render("expanded");
    await act(async () => vi.runAllTimersAsync());
    await act(async () => old("stale preview"));
    expect(host.textContent).toContain("expanded preview");
    expect(host.textContent).not.toContain("stale preview");
  });
});
