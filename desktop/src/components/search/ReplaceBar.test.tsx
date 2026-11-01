// @vitest-environment jsdom
/**
 * 「全部替换」的接线。
 *
 * 盯四件「看着能用、其实没接上」的事：
 * ① 没有命中时整条替换栏不渲染（不能给人一个改了但没东西可改的按钮）；
 * ② 确认框必须说清「直接改磁盘、只能 SVN 还原」——这是替换唯一的风险点；
 * ③ 确认后调的是 `search_replace`，参数与搜索**同一份** options（含整词/大小写/掩码）；
 * ④ 成功后必须提示「搜索结果过期」并给「重新搜索」——磁盘变了屏幕没变。
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { ReplaceBar } from "./ReplaceBar";
import { getSearchForm, setSearchForm, type SearchForm } from "../../lib/searchStore";
import type { SearchOptions } from "../../lib/search";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUTCOME = {
  hits: [
    { path: "aier/newar/src/A.java", line: 12, text: "  void save() {}", ranges: [{ start: 7, end: 11 }] },
    { path: "aier/newar/src/A.java", line: 30, text: "    save();", ranges: [{ start: 4, end: 8 }] },
    { path: "aier/pm/src/B.java", line: 3, text: "int save = 1;", ranges: [{ start: 4, end: 8 }] },
  ],
  filesScanned: 7000,
  filesMatched: 2,
  truncated: false,
  elapsedMs: 640,
};

const REPLACED = {
  filesChanged: 2,
  replacements: 3,
  filesScanned: 7000,
  skippedUnsafe: 0,
  errors: [],
  truncated: false,
  elapsedMs: 900,
};

const OPTIONS: SearchOptions = {
  text: "save",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: "*.java",
};

function form(over: Partial<SearchForm> = {}): SearchForm {
  return {
    ...getSearchForm(),
    outcome: OUTCOME,
    outcomeRoot: "C:/work/aier",
    outcomeOptions: OPTIONS,
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root;
let reSearched = 0;
// 让用例能在对话框开着之后再把「结果已过期」翻上去（二道网的验证）
let staleControl: ((v: boolean) => void) | null = null;

beforeEach(() => {
  mocks.invoke.mockReset();
  setSearchForm({ ...form(), replacement: "persist", replacing: false, replaceOutcome: null });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  reSearched = 0;
  staleControl = null;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setSearchForm({ replacement: "", replacing: false, replaceOutcome: null });
});

const flush = () => act(async () => {});

function mount(f: SearchForm = form(), stale = false) {
  // 与 SearchTab 同构的 harness：form 走 state，update 同时写仓库和 state。
  // 直接传静态对象 + setSearchForm 的话，替换完成后组件拿到的还是旧 props
  // （replaceOutcome 永远是 null）——那是测试夹具假，不是组件假。
  function Harness() {
    const [cur, setCur] = useState(f);
    const [st, setSt] = useState(stale);
    staleControl = setSt;
    const update = (patch: Partial<SearchForm>) => {
      setSearchForm(patch);
      setCur({ ...getSearchForm() });
    };
    return (
      <ReplaceBar form={cur} update={update} options={OPTIONS} onReSearch={() => reSearched++} stale={st} />
    );
  }
  act(() => {
    root.render(<Harness />);
  });
}

const btn = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;

describe("ReplaceBar", () => {
  it("没有命中且没有替换记录时整条不渲染", () => {
    mount(form({ outcome: null }));
    expect(document.body.textContent).not.toContain("替换为");
  });

  it("确认框写明直接改磁盘、只能 SVN 还原，并列出预计改动面", () => {
    mount();
    act(() => btn("全部替换")?.click());
    const text = document.body.textContent ?? "";
    expect(text).toContain("直接改写磁盘上的文件");
    expect(text).toContain("SVN 还原");
    expect(text).toContain("2"); // 2 个文件
    expect(text).toContain("3"); // 3 处
    expect(text).toContain("aier/newar/src/A.java");
    // 纯文本模式给改后预览：第一行 save → persist
    expect(text).toContain("void persist() {}");
  });

  it("替换为空 = 删除，按钮与文案都说明这一点", () => {
    setSearchForm({ replacement: "" });
    mount();
    act(() => btn("全部替换")?.click());
    const text = document.body.textContent ?? "";
    expect(text).toContain("全部删除");
    expect(btn("确认删除")).toBeTruthy();
  });

  it("确认后按同一份 options 调 search_replace", async () => {
    mocks.invoke.mockResolvedValue(REPLACED);
    mount();
    act(() => btn("全部替换")?.click());
    await act(async () => btn("确认替换")?.click());
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = mocks.invoke.mock.calls[0];
    expect(cmd).toBe("search_replace");
    expect(args.options).toEqual(OPTIONS);
    expect(args.replacement).toBe("persist");
  });

  it("替换期间不给关闭：Esc 与遮罩都不该关掉对话框", async () => {
    let resolve!: (v: typeof REPLACED) => void;
    mocks.invoke.mockReturnValue(new Promise((r) => (resolve = r)));
    mount();
    act(() => btn("全部替换")?.click());
    await act(async () => btn("确认替换")?.click());
    // running 中：进度文案在、确认按钮已经不在
    expect(document.body.textContent).toContain("正在替换");
    expect(btn("确认替换")).toBeFalsy();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.textContent).toContain("正在替换");
    resolve(REPLACED);
    await flush();
  });

  it("成功后提示搜索结果过期，点「重新搜索」触发重搜", async () => {
    mocks.invoke.mockResolvedValue(REPLACED);
    mount();
    act(() => btn("全部替换")?.click());
    await act(async () => btn("确认替换")?.click());
    await flush();
    const text = document.body.textContent ?? "";
    expect(text).toContain("改写");
    expect(text).toContain("重新搜索");
    act(() => btn("重新搜索")?.click());
    expect(reSearched).toBe(1);
  });

  it("失败时原因留在框里，不弹 toast 也不假装成功", async () => {
    mocks.invoke.mockRejectedValue("CONFLICT: 文件已被修改");
    mount();
    act(() => btn("全部替换")?.click());
    await act(async () => btn("确认替换")?.click());
    await flush();
    const text = document.body.textContent ?? "";
    expect(text).toContain("CONFLICT");
    // 还在确认阶段：还能再试
    expect(btn("确认替换")).toBeTruthy();
  });

  it("搜索结果属于别的工作区：替换按钮禁用，点不开确认框", () => {
    mount(form(), true);
    const b = btn("全部替换")!;
    expect(b.disabled).toBe(true);
    act(() => b.click());
    // 禁用按钮点了也不该弹出确认框（jsdom 下 disabled 不再派发 click，双保险）
    expect(document.body.textContent).not.toContain("直接改写磁盘");
  });

  it("表单条件与结果快照不一致：禁用替换，绝不按新条件改写另一批文件", () => {
    mount(form({ outcomeOptions: { ...OPTIONS, text: "other" } }));
    const b = btn("全部替换")!;
    expect(b.disabled).toBe(true);
    act(() => b.click());
    expect(document.body.textContent).not.toContain("直接改写磁盘");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("确认框开着时工作区变了：警示上墙、确认按钮也禁用（二道网）", async () => {
    mount(form(), false);
    act(() => btn("全部替换")?.click());
    expect(document.body.textContent).toContain("直接改写磁盘");
    await act(async () => staleControl?.(true));
    const text = document.body.textContent ?? "";
    expect(text).toContain("工作区已变更");
    expect(btn("确认替换")!.disabled).toBe(true);
  });
});
