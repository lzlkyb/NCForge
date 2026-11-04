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
import { ViewActivityContext } from "../../lib/viewActivity";
import type {
  LogEntry,
  QueryResult,
  SearchResult,
  SourceInfo,
  TraceResult,
} from "../../lib/ncLog";

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

/** 检索命中的记录：归因可以没有（按原文找的就是规则还没覆盖的那些）。 */
const HIT: SearchResult["entries"][number] = {
  ...ORA,
  msg: "select 1 from dual",
  verdict: null,
  matchLine: "thread=http-bio-80-exec-7",
  matchCount: 1,
};

const SEARCH: SearchResult = {
  entries: [HIT],
  scannedFiles: ["nc-log.log"],
  recordsScanned: 640,
  truncatedFiles: 0,
  stoppedEarly: false,
  elapsedMs: 12,
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

const render = async (active = true) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ViewActivityContext.Provider value={active}><LogTab /></ViewActivityContext.Provider>
      </QueryClientProvider>,
    );
  });
  await flush();
};

const buttonByText = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().includes(text)) as
    | HTMLButtonElement
    | undefined;

const rows = () => [...container.querySelectorAll<HTMLButtonElement>(".lg-row")];
const traceRequest = async () => {
  await act(async () => buttonByText("高级操作")!.click());
  await act(async () => buttonByText("追踪这次请求")!.click());
};

/** 往检索框里打字（React 只认原生 setter + input 事件）。 */
const typeQuery = async (text: string) => {
  const el = container.querySelector<HTMLInputElement>(".lg-search-inp")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "nc_log_sources") return Promise.resolve(SOURCES);
    if (cmd === "nc_log_query") return Promise.resolve(QUERY);
    if (cmd === "nc_log_trace") return Promise.resolve(TRACE);
    if (cmd === "nc_log_search") return Promise.resolve(SEARCH);
    return Promise.resolve(null);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("NC 日志页", () => {
  it("检索结果显示自己的更新时间；重新检索使用已提交条件且保留草稿和旧结果", async () => {
    const initial = new Date("2026-11-04T09:00:00").getTime();
    const now = vi.spyOn(Date, "now").mockReturnValue(initial);
    await render();
    now.mockReturnValue(initial + 180_000);
    await typeQuery("ORA-00942");
    await act(async () => buttonByText("检索")!.click());
    await flush();
    const badge = () => container.querySelector<HTMLElement>('[data-freshness]')!;
    expect(badge().getAttribute("title")).toBe(`更新于 ${new Date(initial + 180_000).toLocaleString("zh-CN")}`);
    expect(badge().dataset.freshness).toBe("live");
    await typeQuery("未提交的新草稿");
    let finish!: (result: SearchResult) => void;
    mocks.invoke.mockImplementation((cmd: string) => cmd === "nc_log_search"
      ? new Promise<SearchResult>(resolve => { finish = resolve; }) : Promise.resolve(null));
    now.mockReturnValue(initial + 240_000);
    await act(async () => buttonByText("重新检索")!.click());
    expect(buttonByText("重新检索")?.disabled).toBe(true);
    expect(badge().dataset.freshness).toBe("loading");
    expect(rows()).toHaveLength(1);
    const searches = mocks.invoke.mock.calls.filter(call => call[0] === "nc_log_search");
    expect((searches[1][1] as { args: { query: string } }).args.query).toBe("ORA-00942");
    await act(async () => finish({ ...SEARCH, entries: [{ ...SEARCH.entries[0], lineNo: 9999 }] }));
    expect(badge().getAttribute("title")).toBe(`更新于 ${new Date(initial + 240_000).toLocaleString("zh-CN")}`);
    expect(container.querySelector<HTMLInputElement>(".lg-search-inp")?.value).toBe("未提交的新草稿");
    expect(buttonByText("重新检索")?.disabled).toBe(false);
  });
  it("普通查询失败不污染成功检索状态；检索重试失败后仍保留命中结果", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "nc_log_sources") return Promise.resolve(SOURCES);
      if (cmd === "nc_log_query") return Promise.reject(new Error("普通查询失败"));
      if (cmd === "nc_log_search") return Promise.resolve(SEARCH);
      return Promise.resolve(null);
    });
    await render();
    await typeQuery("ORA-00942");
    await act(async () => buttonByText("检索")!.click());
    await flush();
    expect(container.querySelector('[data-freshness]')?.getAttribute("data-freshness")).toBe("live");
    mocks.invoke.mockRejectedValue(new Error("检索暂时失败"));
    await act(async () => buttonByText("重新检索")!.click());
    await flush();
    expect(rows()).toHaveLength(1);
    expect(container.querySelector('[data-freshness]')?.getAttribute("data-freshness")).toBe("error");
    mocks.invoke.mockResolvedValue(SEARCH);
    await act(async () => buttonByText("重试")!.click());
    await flush();
    expect(container.querySelector('[data-freshness]')?.getAttribute("data-freshness")).toBe("live");
    expect(mocks.invoke.mock.calls.filter(call => call[0] === "nc_log_search")).toHaveLength(3);
  });
  it("非活动工具不读取日志，首次打开后才加载；高级筛选默认收起", async () => {
    await render(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await render();
    expect(mocks.invoke.mock.calls.some(call => call[0] === "nc_log_query")).toBe(true);
    const toggle = buttonByText("高级筛选")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const advanced = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(advanced.hidden).toBe(true);
    await act(async () => toggle.click());
    expect(advanced.hidden).toBe(false);
    expect(container.querySelector<HTMLElement>('.lg-search-row .lg-check')?.hidden).toBe(false);
  });
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
    await traceRequest();
    await flush();

    const call = mocks.invoke.mock.calls.find((c) => c[0] === "nc_log_trace");
    expect(call?.[1]).toEqual({ callId: "1793173890985-5927" });
    expect(container.querySelectorAll(".lg-timeline-row").length).toBe(2);
    expect(container.textContent).toContain("同一次请求");
  });

  it("时间线中被列表筛掉的完整记录仍可打开，并保留同请求追踪", async () => {
    const hidden = { ...ORA, lineNo: 9000, msg: "筛选以外的原始消息", verdict: null, stack: ["完整续行"] };
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "nc_log_sources") return Promise.resolve(SOURCES);
      if (cmd === "nc_log_query") return Promise.resolve(QUERY);
      if (cmd === "nc_log_trace") return Promise.resolve({ ...TRACE, entries: [hidden, ORA] });
      return Promise.resolve(null);
    });
    await render();
    await act(async () => rows()[1].click());
    await traceRequest();
    await act(async () => container.querySelector<HTMLButtonElement>(".lg-timeline-row")!.click());
    expect(container.querySelector(".lg-msg")?.textContent).toBe(hidden.msg);
    expect(container.querySelector(".lg-stack")?.textContent).toBe("完整续行");
    expect(container.querySelector('.lg-detail [role="status"]')?.textContent).toContain("详情已保留");
    expect(container.querySelectorAll(".lg-timeline-row")).toHaveLength(2);
    expect(rows().every(row => row.getAttribute("aria-selected") === "false")).toBe(true);
  });

  it("从请求 A 切到 B 后清理时间线；切到无 callid 记录也清理", async () => {
    const other = { ...SLOW, callId: "request-B" };
    mocks.invoke.mockImplementation((cmd: string, args?: { callId?: string }) => {
      if (cmd === "nc_log_sources") return Promise.resolve(SOURCES);
      if (cmd === "nc_log_query") return Promise.resolve({ ...QUERY, entries: [other, ORA] });
      if (cmd === "nc_log_trace") return Promise.resolve(args?.callId === "request-B"
        ? { ...TRACE, callId: "request-B", entries: [{ ...other, callId: null, lineNo: 9999 }] }
        : TRACE);
      return Promise.resolve(null);
    });
    await render();
    await act(async () => rows()[1].click());
    await traceRequest();
    expect(container.querySelector(".lg-trace")).not.toBeNull();
    await act(async () => rows()[0].click());
    expect(container.querySelector(".lg-trace")).toBeNull();
    await traceRequest();
    await act(async () => container.querySelector<HTMLButtonElement>(".lg-timeline-row")!.click());
    expect(container.querySelector(".lg-trace")).toBeNull();
    expect(buttonByText("高级操作")).toBeUndefined();
  });

  it("A 的旧追踪晚到时不覆盖 B，也不提前结束 B 的追踪状态", async () => {
    let resolveA!: (result: TraceResult) => void;
    let resolveB!: (result: TraceResult) => void;
    const pendingA = new Promise<TraceResult>(resolve => { resolveA = resolve; });
    const pendingB = new Promise<TraceResult>(resolve => { resolveB = resolve; });
    const other = { ...SLOW, callId: "request-B" };
    mocks.invoke.mockImplementation((cmd: string, args?: { callId?: string }) => {
      if (cmd === "nc_log_sources") return Promise.resolve(SOURCES);
      if (cmd === "nc_log_query") return Promise.resolve({ ...QUERY, entries: [other, ORA] });
      if (cmd === "nc_log_trace") return args?.callId === "request-B" ? pendingB : pendingA;
      return Promise.resolve(null);
    });
    await render();
    await act(async () => rows()[1].click());
    await traceRequest();
    await act(async () => rows()[0].click());
    await traceRequest();
    await act(async () => resolveA(TRACE));
    expect(container.querySelector(".lg-trace")).toBeNull();
    expect(buttonByText("正在追踪")?.disabled).toBe(true);
    await act(async () => resolveB({ ...TRACE, callId: "request-B", entries: [other] }));
    expect(container.querySelector(".lg-trace-head")?.textContent).toContain("request-B");
    expect(buttonByText("高级操作")?.disabled).toBe(false);
  });

  it("检索模式切换后保留当前完整详情，并说明不参与检索的归因筛选", async () => {
    await render();
    await act(async () => rows()[0].click());
    await typeQuery("dual");
    await act(async () => buttonByText("检索")!.click());
    await flush();
    expect(container.querySelector(".lg-msg")?.textContent).toBe(SLOW.msg);
    expect(container.querySelector('.lg-detail [role="status"]')?.textContent).toContain("当前列表");
    await act(async () => buttonByText("高级筛选")!.click());
    expect(container.querySelector(".lg-search-hint")?.textContent).toContain("「仅问题与慢 SQL」和「慢 SQL ≥」");
  });

  it("修改来源沿用查询范围和归因条件，并保留检索草稿", async () => {
    await render();
    await act(async () => buttonByText("高级筛选")!.click());
    await typeQuery("尚未提交的检索词");
    const source = container.querySelector<HTMLButtonElement>('.lg-chip:not([aria-pressed="true"])')!;
    await act(async () => source.click());
    await flush();
    const calls = mocks.invoke.mock.calls.filter(call => call[0] === "nc_log_query");
    const initial = (calls[0][1] as { args: Record<string, unknown> }).args;
    const latest = (calls[calls.length - 1][1] as { args: Record<string, unknown> }).args;
    expect(latest.loggers).toEqual(["nclog"]);
    expect(latest.sinceTs).toBe(initial.sinceTs);
    expect(latest.onlyProblems).toBe(true);
    expect(latest.minCostMs).toBe(1000);
    expect(container.querySelector<HTMLInputElement>(".lg-search-inp")?.value).toBe("尚未提交的检索词");
  });

  it("中文组词 Enter 与 229 兼容事件不检索，普通 Enter 才提交", async () => {
    await render();
    await typeQuery("错误");
    const input = container.querySelector<HTMLInputElement>(".lg-search-inp")!;
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true })));
    expect(mocks.invoke.mock.calls.some(call => call[0] === "nc_log_search")).toBe(false);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(mocks.invoke.mock.calls.filter(call => call[0] === "nc_log_search")).toHaveLength(1);
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

  it("检索把当前范围带给后端，列表显示命中行", async () => {
    await render();
    await typeQuery("ORA-00942");
    await act(async () => buttonByText("检索")!.click());
    await flush();

    const call = mocks.invoke.mock.calls.find((c) => c[0] === "nc_log_search");
    const args = (call?.[1] as { args: Record<string, unknown> })?.args;
    expect(args.query).toBe("ORA-00942");
    expect(args.regex).toBe(false);
    expect(args.caseSensitive).toBe(false);
    expect(args.limit).toBe(500);
    // 时间范围与 logger 跟着上方的过滤条走，而不是另起一套
    expect(typeof args.sinceTs).toBe("string");
    expect(args.loggers).toBeNull();

    expect(rows().length).toBe(1);
    expect(container.querySelector(".lg-row-match")?.textContent).toBe(
      "thread=http-bio-80-exec-7",
    );
    expect(container.textContent).toContain("命中 1 条");
  });

  it("清除检索后回到归因列表", async () => {
    await render();
    await typeQuery("ORA-00942");
    await act(async () => buttonByText("检索")!.click());
    await flush();
    expect(rows().length).toBe(1);

    await act(async () => buttonByText("清除")!.click());
    await flush();
    expect(rows().length).toBe(2);
    expect(container.querySelector(".lg-row-match")).toBeNull();
  });

  it("正则不合法时把后端的原话摆出来", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "nc_log_sources") return Promise.resolve(SOURCES);
      if (cmd === "nc_log_query") return Promise.resolve(QUERY);
      if (cmd === "nc_log_search") {
        return Promise.reject(new Error("正则表达式不合法：unclosed group"));
      }
      return Promise.resolve(null);
    });
    await render();
    await typeQuery("(unclosed");
    await act(async () => buttonByText("检索")!.click());
    await flush();

    const bad = container.querySelector('.lg-search-info[data-tone="bad"]');
    expect(bad?.textContent).toContain("正则表达式不合法");
    // 检索失败不能把已有列表清空 —— 用户还得能接着看
    expect(rows().length).toBe(2);
  });
});
