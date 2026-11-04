// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnManualForm } from "./ConnManualForm";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root.render(<ConnManualForm conn={null} />)); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
describe("连接表单可访问名称", () => {
  it("八个可见字段标签各关联真实输入，并且端口不会与主机共用名称", () => {
    const labels = [...host.querySelectorAll<HTMLLabelElement>("label[for]")];
    expect(labels).toHaveLength(8);
    for (const label of labels) {
      expect(label.control).toBeInstanceOf(HTMLInputElement);
      act(() => label.control!.focus());
      expect(document.activeElement).toBe(label.control);
    }
    expect(labels.map((label) => label.textContent)).toEqual(["名称", "主机", "端口", "服务名", "JDBC URL", "用户", "口令", "备注"]);
  });
  it("引擎与事务模式将当前选中状态暴露给辅助技术，并随点击更新", () => {
    const groups = [...host.querySelectorAll<HTMLElement>('[role="group"]')];
    expect(groups.map((group) => document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent)).toEqual(["引擎", "事务"]);
    const engines = groups[0].querySelectorAll<HTMLButtonElement>("button");
    expect(engines[0].getAttribute("aria-pressed")).toBe("true");
    act(() => engines[1].click());
    expect(engines[0].getAttribute("aria-pressed")).toBe("false"); expect(engines[1].getAttribute("aria-pressed")).toBe("true");
    const modes = groups[1].querySelectorAll<HTMLButtonElement>("button");
    act(() => modes[1].click());
    expect(modes[0].getAttribute("aria-pressed")).toBe("false"); expect(modes[1].getAttribute("aria-pressed")).toBe("true");
  });
});
