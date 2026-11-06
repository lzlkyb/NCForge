// @vitest-environment jsdom
/**
 * 客户端状态卡的三条回归网：
 *
 * 1. 客户端没有监听端口，**不能**照抄中间件的「监听中/空闲」文案——这里要显示
 *    「连接哪台中间件、当前通不通」，不通时必须明确说「未就绪」。
 * 2. 调试开关只在停止时可点（JDWP 参数 JVM 启动后不重读）。
 * 3. 客户端 classpath 是 Eclipse 客户端规则（约 4700 项），条目数要能显示出来。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientCard } from "./ClientCard";
import { ServiceDetails } from "./ServiceDetails";
import type { ClientStatus } from "../../lib/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const status = (patch: Partial<ClientStatus> = {}): ClientStatus => ({
  state: "stopped",
  pid: null,
  startedAtMs: null,
  uptimeMs: null,
  host: "127.0.0.1",
  port: 80,
  serverReachable: false,
  logPath: "D:/config/logs/client.log",
  logSize: 0,
  java: null,
  classpathEntries: 0,
  mainClass: "nc.starter.test.JStarter",
  commandLine: "",
  exitCode: null,
  reason: null,
  projectRoot: null,
  ncHome: null,
  heapMb: 768,
  defaultHeapMb: 768,
  debugPort: null,
  ...patch,
});

const mount = async (s: ClientStatus, debugAttached = false) => {
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ClientCard
        status={s}
        busy={null}
        debugMode={false}
        debugAttached={debugAttached}
        debugBusy={false}
        onAttachDebug={vi.fn()}
        onDetachDebug={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRestart={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
  });
};

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;

afterEach(async () => {
  await act(async () => root.unmount());
});

describe("ClientCard", () => {
  it("停止状态只给启动，不显示停止/重启", async () => {
    await mount(status());
    expect(button("启动")).toBeTruthy();
    expect(container.querySelector('[aria-label="客户端启动方式"]')).toBeTruthy();
    expect(button("停止")).toBeUndefined();
    expect(button("重启")).toBeUndefined();
  });

  it("运行中且中间件未就绪时明确标出", async () => {
    await mount(status({ state: "running", pid: 4321, serverReachable: false, classpathEntries: 4701 }));
    expect(container.textContent).toContain("进程运行中");
    expect(container.textContent).toContain("127.0.0.1:80");
    expect(container.querySelector('[aria-label="客户端启动方式"]')).toBeNull();
    expect(button("停止")).toBeTruthy();
    expect(button("重启")).toBeTruthy();
    await act(async () => root.render(<ServiceDetails source="client" status={status({ state: "running", pid: 4321, serverReachable: false, classpathEntries: 4701 })} failed={false} onCommandLine={vi.fn()} onEditPort={vi.fn()} />));
    expect(container.textContent).toContain("未就绪");
    expect(container.textContent).toContain("4701 项");
    expect(container.textContent).toContain("NC 业务健康未验证");
  });

  it("JDWP 端口只显示回环地址", async () => {
    await mount(status({ state: "running", pid: 1, debugPort: 61539 }));
    expect(button("附加调试")?.title).toContain("127.0.0.1:61539");
    // 能在工作台内附加，不再是「只许 IDE/jdb」
    expect(button("附加调试")).toBeTruthy();
  });

  it("已附加时给断开入口", async () => {
    await mount(status({ state: "running", pid: 1, debugPort: 61539 }), true);
    expect(button("断开调试")).toBeTruthy();
    expect(button("附加调试")).toBeUndefined();
  });

  it("本次没开调试时附加按钮禁用并说明原因", async () => {
    await mount(status({ state: "running", pid: 1 }));
    expect(button("附加调试")?.disabled).toBe(true);
  });
});
