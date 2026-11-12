// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlOutlineBar, statementBrief } from "./SqlOutlineBar";
import type { RunStmt } from "./SqlEditor";

vi.mock("../ui/icon", () => ({ Icon: () => null }));

const stmt = (text: string, startLine: number): RunStmt => ({ text, startLine, endLine: startLine });

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = (statements: RunStmt[], onPick = vi.fn()) => {
  act(() => root.render(<SqlOutlineBar statements={statements} onPick={onPick} />));
  return onPick;
};

describe("语句大纲", () => {
  it("少于三条不占位", () => {
    render([stmt("select 1 from dual", 1), stmt("select 2 from dual", 3)]);
    expect(host.querySelector(".dbx-outline")).toBeNull();
  });

  it("注释标题优先，没有标题就用正文", () => {
    render([stmt("-- 物料主档\nselect * from bd_material", 1), stmt("select count(*) from bd_dept", 5), stmt("commit", 9)]);
    const items = [...host.querySelectorAll(".dbx-outline-item")];
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("物料主档");
    expect(items[1].textContent).toContain("select count(*)");
  });

  it("点击跳到该语句首行", () => {
    const onPick = render([stmt("-- 一\nselect 1 from dual", 1), stmt("-- 二\nselect 2 from dual", 8), stmt("-- 三\nselect 3 from dual", 15)]);
    act(() => (host.querySelectorAll(".dbx-outline-item")[1] as HTMLButtonElement).click());
    expect(onPick).toHaveBeenCalledWith(8);
  });

  it("超过 80 条给出剩余数量，不把几百个按钮全渲染出来", () => {
    const many = Array.from({ length: 90 }, (_, i) => stmt(`select ${i} from dual`, i + 1));
    render(many);
    expect(host.querySelectorAll(".dbx-outline-item")).toHaveLength(80);
    expect(host.querySelector(".dbx-outline-more")?.textContent).toContain("还有 10 条");
  });
});

describe("语句摘要", () => {
  it("压掉前导注释与换行", () => {
    expect(statementBrief("-- 说明\nselect a,\n   b from t")).toBe("select a, b from t");
    expect(statementBrief("/* 块注释 */\nselect 1 from dual")).toBe("select 1 from dual");
  });

  it("超长按字符截断", () => {
    const text = statementBrief("select aaaaaaaabbbbbbbbcccccccc from t", 10);
    expect([...text]).toHaveLength(11);
    expect(text.endsWith("…")).toBe(true);
  });
});
