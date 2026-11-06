// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbConn } from "../../lib/dbApi";

// NC home 探测由用例按「有 / 没有 home」两种前提控制
const probe = vi.fn<() => Promise<{ root: string | null }>>();
vi.mock("../../lib/server", () => ({ ncHomeProbe: () => probe() }));

// 测试连接的结果由用例决定（need-nc-home 拒绝 / 成功）
const testConn = vi.fn();
const saveConn = vi.fn();
vi.mock("../../lib/dbApi", () => ({
  dbApi: { test: (...a: unknown[]) => testConn(...a), save: (...a: unknown[]) => saveConn(...a) },
  ENVS: ["dev", "test", "prod", "other"],
  ENV_LABEL: { dev: "开发", test: "测试", prod: "生产", other: "其他" },
  buildOracleUrl: (h: string, p: string, s: string) => `jdbc:oracle:thin:@${h}:${p}/${s}`,
  parseOracleUrl: () => null,
}));

vi.mock("../../lib/operations", () => ({ beginOperation: () => ({ finish: vi.fn() }) }));
vi.mock("../../lib/dbOperations", () => ({ dbTaskSpec: () => ({}) }));
vi.mock("../../lib/dbStore", () => ({
  closeConnDialog: vi.fn(),
  disconnect: vi.fn(),
  loadConns: vi.fn(),
  rtOf: () => ({ status: "idle" }),
}));

import { ConnManualForm } from "./ConnManualForm";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  probe.mockReset();
  // 默认「没有 home」：用例要「有 home」的前提时自己覆盖
  probe.mockResolvedValue({ root: null });
  testConn.mockReset();
  saveConn.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** 每次都换一个新 root：useEffect([]) 只在挂载时跑，同一 root 重渲染不会重新探测。 */
const render = async (conn: DbConn | null = null) => {
  act(() => root.unmount());
  root = createRoot(host);
  await act(async () => {
    root.render(<ConnManualForm conn={conn} />);
  });
  // 挂载时的 home 探测是异步的：再排一轮微任务让它的结果落进 state
  await act(async () => {});
};

const engineButtons = () => [...host.querySelectorAll<HTMLElement>('[role="group"]')][0].querySelectorAll<HTMLButtonElement>("button");

/** React 受控输入：必须走原生 setter 派发 input 事件，直接改 value 不触发 onChange。 */
const setField = (labelText: string, value: string) => {
  const label = [...host.querySelectorAll<HTMLLabelElement>("label[for]")].find((l) => l.textContent === labelText);
  expect(label, `找不到标签「${labelText}」`).toBeTruthy();
  const input = label!.control as HTMLInputElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("数据库连接表单：没有 NC home 也能用", () => {
  it("新连接默认「纯 Rust 驱动」，并且它排在引擎第一位", async () => {
    await render();
    const engines = engineButtons();
    expect(engines[0].textContent).toBe("纯 Rust 驱动");
    expect(engines[0].getAttribute("aria-pressed")).toBe("true");
    expect(engines[1].textContent).toBe("JVM 桥");
    expect(engines[1].getAttribute("aria-pressed")).toBe("false");
  });

  it("编辑已有连接时用连接自己的引擎，不套用新默认值", async () => {
    await render({
      id: "c1", name: "老连接", env: "dev", source: "manual",
      url: "jdbc:oracle:thin:@h:1521/orcl", user: "u", propDs: null,
      autoCommit: false, note: "", hasPassword: true, engine: "java",
    });
    const engines = engineButtons();
    // 老连接是 JVM 桥就该还是 JVM 桥
    expect(engines[1].getAttribute("aria-pressed")).toBe("true");
    expect(engines[0].getAttribute("aria-pressed")).toBe("false");
  });

  it("这台机器没有 NC home 时，JVM 桥按钮带「需要 NC 安装目录」标注；有 home 就没有", async () => {
    probe.mockResolvedValue({ root: null });
    await render();
    expect(engineButtons()[1].title).toContain("需要 NC 安装目录");

    probe.mockResolvedValue({ root: "D:\\ncc\\1909home" });
    await render();
    expect(engineButtons()[1].title).toBe("");
  });

  it("测试连接收到 need-nc-home 时，红条给出「换成纯 Rust 驱动」一键出路", async () => {
    testConn.mockRejectedValue("need-nc-home|JVM 桥需要 NC 安装目录：它用 NC 自带的 Java 1.8 与 Oracle 驱动");
    await render();
    act(() => engineButtons()[1].click());
    setField("JDBC URL", "jdbc:oracle:thin:@10.0.0.1:1521/orcl");
    setField("用户", "nc");

    const testBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("测试连接"))!;
    await act(async () => { testBtn.click(); });

    const bad = host.querySelector<HTMLElement>(".dbx-badline");
    expect(bad?.textContent).toContain("JVM 桥需要 NC 安装目录");
    const quick = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "换成纯 Rust 驱动");
    expect(quick, "红条里要有一键换引擎的按钮").toBeTruthy();

    act(() => quick!.click());
    const engines = engineButtons();
    // 点完一键切换应是纯 Rust 驱动选中
    expect(engines[0].getAttribute("aria-pressed")).toBe("true");
    expect(engines[1].getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector(".dbx-badline")).toBeNull();
  });

  it("保存新连接时默认带上纯 Rust 驱动（不依赖 NC home）", async () => {
    saveConn.mockResolvedValue(undefined);
    await render();
    setField("JDBC URL", "jdbc:oracle:thin:@10.0.0.1:1521/orcl");
    setField("用户", "nc");
    const addBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "添加")!;
    await act(async () => { addBtn.click(); });
    expect(saveConn).toHaveBeenCalledTimes(1);
    expect(saveConn.mock.calls[0][0].engine).toBe("rust");
  });
});
