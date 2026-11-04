// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LogList } from "./LogList";
import { entryKey, type LogEntry } from "../../lib/ncLog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const entries: LogEntry[] = Array.from({ length: 300 }, (_, index) => ({
  file: "nc.log", lineNo: index + 1, logger: "nc", msg: `消息 ${index + 1}`,
  callId: null, ts: null, thread: null, userId: null, remoteCall: null, level: null,
  stack: [], stackTruncated: false, costMs: null, rowCount: null, verdict: null,
}));
let root: Root;
let host: HTMLDivElement;
function List() {
  const [selected, setSelected] = useState<string | null>(null);
  return <LogList entries={entries} selectedKey={selected} onSelect={entry => setSelected(entryKey(entry))} />;
}
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const rows = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="option"]'));
const key = (key: string) => act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

describe("日志长列表键盘选择", () => {
  it("300 条记录只有一个 Tab 入口；方向键与 Home/End 更新选择和焦点", () => {
    act(() => root.render(<List />));
    expect(rows().filter(row => row.tabIndex === 0)).toHaveLength(1);
    act(() => rows()[0].focus());
    key("ArrowDown");
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows()[1].getAttribute("aria-selected")).toBe("true");
    key("End");
    expect(document.activeElement).toBe(rows()[299]);
    key("ArrowDown");
    expect(document.activeElement).toBe(rows()[299]);
    key("ArrowUp");
    expect(document.activeElement).toBe(rows()[298]);
    key("Home");
    expect(document.activeElement).toBe(rows()[0]);
    expect(rows().filter(row => row.tabIndex === 0)).toHaveLength(1);
  });
  it("鼠标选中后 Tab 入口跟随当前记录", () => {
    act(() => root.render(<List />));
    act(() => rows()[125].click());
    expect(rows()[125].tabIndex).toBe(0);
    expect(rows()[125].getAttribute("aria-selected")).toBe("true");
    expect(rows().filter(row => row.tabIndex === 0)).toHaveLength(1);
  });
  it("空态使用当前筛选名称", () => {
    act(() => root.render(<LogList entries={[]} selectedKey={null} onSelect={() => {}} />));
    expect(host.textContent).toContain("仅问题与慢 SQL");
    expect(host.textContent).not.toContain("只看有结论的");
  });
});
