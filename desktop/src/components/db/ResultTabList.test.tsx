// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { ResultTabList, resultTabId } from "./ResultTabList";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);
afterEach(() => act(() => root.render(null)));

function Example() {
  const [value, select] = useState("rows");
  return <><ResultTabList prefix="result" label="结果" items={[{id:"rows",label:"数据"},{id:"plan",label:"计划"},{id:"output",label:"输出"}]} value={value} onSelect={select}/>
    <div id="result-panel" role="tabpanel" tabIndex={0} aria-labelledby={resultTabId("result",value)}>{value}</div></>;
}
it("方向键与 Home/End 在一个 Tab 入口内切换，向下进入关联结果", () => {
  act(() => root.render(<Example/>));
  const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const press = (key:string) => act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true})));
  tabs[0].focus();press("ArrowRight");
  expect(document.activeElement).toBe(tabs[1]);
  expect(tabs[1].getAttribute("aria-selected")).toBe("true");
  expect(tabs.filter(t=>t.tabIndex===0)).toHaveLength(1);
  press("End");expect(document.activeElement).toBe(tabs[2]);
  press("ArrowRight");expect(document.activeElement).toBe(tabs[0]);
  press("ArrowLeft");expect(document.activeElement).toBe(tabs[2]);
  press("Home");expect(document.activeElement).toBe(tabs[0]);
  press("ArrowDown");
  expect(document.activeElement?.id).toBe("result-panel");
  expect(document.activeElement?.getAttribute("aria-labelledby")).toBe(tabs[0].id);
});
