// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnManualForm } from "./ConnManualForm";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // 用 `await act(async …)` 而不是同步 act：全量跑时 worker 里还有其它文件的更新在排队，
  // 同步 act 不保证这次渲染已经 flush，后面的断言会读到上一帧（表现为偶发 aria-pressed=false）。
  await act(async () => {
    root.render(<ConnManualForm conn={null} />);
  });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
describe("连接表单可访问名称", () => {
  it("十个可见字段标签各关联真实输入，并且端口不会与主机共用名称", () => {
    const labels = [...host.querySelectorAll<HTMLLabelElement>("label[for]")];
    expect(labels).toHaveLength(10);
    for (const label of labels) {
      expect(label.control).toBeInstanceOf(HTMLInputElement);
      act(() => label.control!.focus());
      expect(document.activeElement).toBe(label.control);
    }
    // 「分组」在名称之后：它和颜色一起属于「这条连接归哪儿」而不是「怎么连」。
    expect(labels.map((label) => label.textContent)).toEqual(["名称", "分组", "主机", "端口", "服务名", "JDBC URL", "用户", "口令", "默认 schema", "备注"]);
  });
  it("引擎与事务模式将当前选中状态暴露给辅助技术，并随点击更新", () => {
    const groups = [...host.querySelectorAll<HTMLElement>('[role="group"]')];
    expect(groups.map((group) => document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent)).toEqual(["颜色", "引擎", "事务"]);
    // 颜色是固定枚举：默认 + 7 个色块，选中项才 aria-pressed。
    const colors = groups[0].querySelectorAll<HTMLButtonElement>("button");
    expect(colors).toHaveLength(8);
    expect(colors[0].getAttribute("aria-pressed")).toBe("true");
    act(() => colors[3].click());
    expect(colors[0].getAttribute("aria-pressed")).toBe("false");
    expect(colors[3].getAttribute("aria-pressed")).toBe("true");
    const engines = groups[1].querySelectorAll<HTMLButtonElement>("button");
    expect(engines[0].getAttribute("aria-pressed")).toBe("true");
    act(() => engines[1].click());
    expect(engines[0].getAttribute("aria-pressed")).toBe("false"); expect(engines[1].getAttribute("aria-pressed")).toBe("true");
    const modes = groups[2].querySelectorAll<HTMLButtonElement>("button");
    act(() => modes[1].click());
    expect(modes[0].getAttribute("aria-pressed")).toBe("false"); expect(modes[1].getAttribute("aria-pressed")).toBe("true");
  });
});
