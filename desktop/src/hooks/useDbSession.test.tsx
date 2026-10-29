// @vitest-environment jsdom
/**
 * useDbSession.run 的并发守卫（P2-18-A）。
 *
 * 执行按钮 disabled={running} 挡得住鼠标连点，但 Ctrl+Enter 走的是 textarea 的
 * onKeyDown，不过按钮——连按两次就是两个 dbQuery 并发：finally 会把先结束的那个
 * 的 running 置 false（另一个还在飞），结果页还会被先发后回的响应覆盖成旧数据。
 *
 * 守卫必须用 ref 而不是 state：同一次渲染闭包里的两次调用看到的 running 都是
 * false，只有 ref 是同步置位的。打桩方式：db_query 返回不自动兑现的 promise，
 * 「在途」这个状态于是可以被确定性地构造出来。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => {
  type Call = { sql: string; resolve: (v: unknown) => void };
  const calls: Call[] = [];
  return { calls };
});

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: mocks.invoke }));

import { useDbSession } from "./useDbSession";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latest: ReturnType<typeof useDbSession>;
function Probe() {
  latest = useDbSession();
  return null;
}

let root: Root | null = null;
const mount = () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  root.render(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
};

const DEFAULTS = {
  url: null,
  user: null,
  databaseType: null,
  source: "",
  hasPassword: false,
  passwordNeedsInput: false,
  driverFound: true,
  driverPath: null,
};

const RESULT = {
  columns: [],
  rows: [],
  rowCount: 0,
  truncated: false,
  ms: 1,
  sql: "select 1 from dual",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  mocks.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "db_defaults") return Promise.resolve(DEFAULTS);
    if (cmd === "db_query") {
      return new Promise((resolve) => {
        h.calls.push({ sql: String(args?.sql ?? ""), resolve });
      });
    }
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("useDbSession.run", () => {
  it("在途期间后续调用被守卫挡住：连按 Ctrl+Enter 只发一个 db_query", async () => {
    mount();
    await act(async () => {}); // 等 db_defaults 落回状态

    await act(async () => {
      void latest.run("select 1 from dual", 500, 30);
      void latest.run("select 2 from dual", 500, 30);
    });
    expect(h.calls.length).toBe(1);
    expect(h.calls[0].sql).toBe("select 1 from dual");
    expect(latest.running).toBe(true);
  });

  it("上一次落账之后放行下一次", async () => {
    mount();
    await act(async () => {});

    await act(async () => {
      void latest.run("select 1 from dual", 500, 30);
    });
    expect(h.calls.length).toBe(1);

    await act(async () => {
      h.calls[0].resolve(RESULT);
    });
    expect(latest.running).toBe(false);
    expect(latest.result).toEqual(RESULT);

    await act(async () => {
      void latest.run("select 2 from dual", 500, 30);
    });
    expect(h.calls.length).toBe(2);
    expect(h.calls[1].sql).toBe("select 2 from dual");
  });

  it("precheck 拒掉的语句不占用守卫（写完错语句还能立刻执行对的）", async () => {
    mount();
    await act(async () => {});

    await act(async () => {
      await latest.run("delete from sm_user", 500, 30);
    });
    expect(h.calls.length).toBe(0);
    expect(latest.queryError).toContain("写操作");
    expect(latest.running).toBe(false);

    await act(async () => {
      void latest.run("select 1 from dual", 500, 30);
    });
    expect(h.calls.length).toBe(1);
  });
});
