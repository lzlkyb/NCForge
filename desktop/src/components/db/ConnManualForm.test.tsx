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
  it("十二个可见字段标签各关联真实控件，并且端口不会与主机共用名称", () => {
    const labels = [...host.querySelectorAll<HTMLLabelElement>("label[for]")];
    expect(labels).toHaveLength(12);
    for (const label of labels) {
      // 保活是 `select`、启动脚本是 `textarea`，其余是 `input`：只要求「点标签能聚焦到真控件」
      expect(label.control).toBeTruthy();
      act(() => label.control!.focus());
      expect(document.activeElement).toBe(label.control);
    }
    // 「分组」在名称之后：它和颜色一起属于「这条连接归哪儿」而不是「怎么连」。
    expect(labels.map((label) => label.textContent)).toEqual(["名称", "分组", "主机", "端口", "服务名", "JDBC URL", "用户", "口令", "默认 schema", "空闲保活", "启动脚本", "备注"]);
  });
  it("保活默认 4 分钟且可关，启动脚本是多行输入", () => {
    // 用 `getElementById` 而不是拼 `#id`：`useId()` 生成的 id 带冒号，选择器会报非法
    const keepLabel = [...host.querySelectorAll<HTMLLabelElement>("label[for]")]
      .find((l) => l.textContent === "空闲保活")!;
    const keep = document.getElementById(keepLabel.htmlFor) as HTMLSelectElement;
    // 默认值必须与后端 `KEEP_ALIVE_DEFAULT` 一致：两边不一致时用户看到「推荐 4 分钟」却存了别的值
    expect(keep.value).toBe("240");
    expect([...keep.options].map((o) => o.value)).toContain("0");
    expect([...keep.options].find((o) => o.value === "0")!.textContent).toBe("关闭");
    const init = host.querySelector<HTMLElement>(".dbx-initsql")!;
    expect(init.tagName).toBe("TEXTAREA");
    expect(init.getAttribute("placeholder")).toContain("nls_date_format");
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
