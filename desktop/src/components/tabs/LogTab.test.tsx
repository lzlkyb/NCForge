// @vitest-environment jsdom
/**
 * NC 日志页的接线。
 *
 * 盯的是四件「看着能跑、其实没接上」的事：
 * ① 列表显示的是**结论**（`verdict.title`）而不是异常原文 —— 归因没接上时这一页
 *    就退化成「又一个日志浏览器」，白做；
 * ② 「为什么 / 下一步」真的来自后端结论，不是前端硬编码；
 * ③ 「复制到 SQL 窗口」**只**出现在 warningsql 记录上（别的记录里 msg 是「报错 + 半条 SQL」，
 *    塞进控制台会得到第二个错误）；
 * ④ 「追踪这次请求」把 callId 交给 `nc_log_trace` 并画出时间线。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));

import { LogTab } from "./LogTab";
import type { LogEntry, QueryResult, SourceInfo, TraceResult } from "../../lib/ncLog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCES: SourceInfo = {
  home: "D:\\ncc\\1909home",
  configPath: "D:\\ncc\\1909home\\ierp\\bin\\logger-config.properties",
  fromConfig: true,
  serverDir: "server",
  logsRoot: "D:\\ncc\\1909home\\nclogs",
  loggers: [
    {
      name: "nclog",
      level: "ERROR",
      files: [
        {
          logger: "nclog",
          name: "nc-log.log",
          path: "D:\\ncc\\1909home\\nclogs\\server\\nc-log.log",
          size: 1_879_872,
          mtimeMs: 1_761_750_000_000,
          rotated: false,
        },
      ],
      newestMs: 1_761_750_000_000,
      totalSize: 1_879_872,
    },
  ],
};

const ORA: LogEntry = {
  logger: "nclog",
  file: "nc-log.log",
  lineNo: 7442,
  ts: "2026-10-30 16:57:33",
  callId: "1793173890985-5927",
  thread: "Thread-32",
  userId: null,
  remoteCall: null,
  level: "ERROR",
  msg: "< SELECT * FROM bi_conf_cache>throws ORA-00942: 表或视图不存在",
  stack: ["java.sql.SQLException: ORA-00942: 表或视图不存在"],
  stackTruncated: false,
  costMs: null,
  rowCount: null,
  verdict: {
    rule: "ora-00942",
    severity: "error",
    title: "表或视图不存在：bi_conf_cache",
    cause: "八成不是代码写错，而是元数据已发布但建库脚本没跑。",
    action: "在数据库里核对这张表是否存在。",
    jump: { kind: "table", table: "bi_conf_cache" },
  },
};

const SLOW: LogEntry = {
  ...ORA,
  logger: "warningsql",
  file: "warningsql-log.log",
  lineNo: 4410,
  ts: "2026-10-30 16:57:34",
  msg: "select * from md_component t1 where 1 = 1|costtime=1274||rownum=44618|",
  stack: [],
  costMs: 1274,
  rowCount: 44618,
  verdict: {
    rule: "slow-sql",
    severity: "slow",
    title: "慢 SQL：1274ms，影响 44618 行",
    cause: "NC 自己在 warningsql 里登记了耗时与行数。",
    action: "复制到数据库页 EXPLAIN 一下。",
    jump: null,
  },
};

const QUERY: QueryResult = {
  entries: [SLOW, ORA],
  scannedFiles: ["nc-log.log", "warningsql-log.log"],
  recordsScanned: 3130,
  truncatedFiles: 0,
  stoppedEarly: false,
  elapsedMs: 128,
  slowThresholdMs: 1000,
};

const TRACE: TraceResult = {
  callId: "1793173890985-5927",
  scannedFiles: ["nc-log.log", "warningsql-log.log"],
  elapsedMs: 40,
  entries: [
    { ...ORA, logger: "warningsql", msg: "select 1 from dual", verdict: null },
    ORA,
  ],
};

let root: Root;
let container: HTMLDivElement;

const flush = async () => {
  // react-query 的状态落地在微任务之后，只 act 一次拿到的还是 loading 态
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

const render = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <LogTab />
      </QueryClientProvider>,
    );
  });
  await flush();
};

const buttonByText = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().includes(text)) as
    | HTMLButtonElement
    | undefined;

const rows = () => [...container.querySelectorAll<HTMLButtonElement>(".lg-row")];

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "nc_log_sources") return Promise.resolve(SOURCES);
    if (cmd === "nc_log_query") return Promise.resolve(QUERY);
    if (cmd === "nc_log_trace") return Promise.resolve(TRACE);
    return Promise.resolve(null);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("NC 日志页", () => {
  it("列表显示结论而不是异常原文", async () => {
    await render();
    const titles = rows().map((r) => r.querySelector(".lg-row-title")?.textContent);
    expect(titles).toEqual(["慢 SQL：1274ms，影响 44618 行", "表或视图不存在：bi_conf_cache"]);
    // 原始消息只在详情里，不该占据列表标题
    expect(container.textContent).not.toContain("< SELECT * FROM bi_conf_cache>");
  });

  it("点一行后给出为什么与下一步", async () => {
    await render();
    await act(async () => rows()[1].click());
    expect(container.textContent).toContain("为什么");
    expect(container.textContent).toContain("元数据已发布但建库脚本没跑");
    expect(container.textContent).toContain("下一步");
    // 结论里的跳转按钮要说清去哪，而不是笼统的「跳转」
    expect(buttonByText("在数据库里查 bi_conf_cache")).toBeTruthy();
  });

  it("只有 warningsql 记录才给「复制到 SQL 窗口」", async () => {
    await render();
    await act(async () => rows()[1].click());
    expect(buttonByText("复制到 SQL 窗口")).toBeUndefined();

    await act(async () => rows()[0].click());
    expect(buttonByText("复制到 SQL 窗口")).toBeTruthy();
  });

  it("追踪这次请求会带上 callId 并画出时间线", async () => {
    await render();
    await act(async () => rows()[1].click());
    await act(async () => buttonByText("追踪这次请求")!.click());
    await flush();

    const call = mocks.invoke.mock.calls.find((c) => c[0] === "nc_log_trace");
    expect(call?.[1]).toEqual({ callId: "1793173890985-5927" });
    expect(container.querySelectorAll(".lg-timeline-row").length).toBe(2);
    expect(container.textContent).toContain("同一次请求");
  });

  it("没读到 logger 配置时给出提示", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "nc_log_sources") return Promise.resolve({ ...SOURCES, fromConfig: false });
      if (cmd === "nc_log_query") return Promise.resolve(QUERY);
      return Promise.resolve(null);
    });
    await render();
    expect(container.querySelector(".lg-note")?.textContent).toContain("logger-config.properties");
  });

  it("查询失败时把原因和日志目录一起摆出来", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "nc_log_sources") return Promise.resolve(SOURCES);
      if (cmd === "nc_log_query") return Promise.reject(new Error("还没找到 NC 日志文件"));
      return Promise.resolve(null);
    });
    await render();
    const err = container.querySelector(".lg-error");
    expect(err?.textContent).toContain("还没找到 NC 日志文件");
    // 光说「失败」没用，得告诉人去哪个目录看
    expect(err?.textContent).toContain("nclogs");
  });
});
