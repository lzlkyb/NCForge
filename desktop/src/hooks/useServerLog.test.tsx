// @vitest-environment jsdom
/**
 * useServerLog 的两条「差点丢数据」路径（2026-10-28）。
 *
 * 这个 hook 里没有 UI，但它是日志面板唯一的数据入口，两个坑都只在特定时序出现，
 * 人工点不出来——而踩中的代价正是「排查问题时看不到关键那几行」：
 *
 * 1. **换一代日志时在途的旧响应**。点启动 → 后端把旧日志轮转成 .1 → 前端 reset 从头读。
 *    如果上一代的拉取请求正好还在路上（慢盘上读 256KB 完全可能超过 500ms 的轮询间隔），
 *    它回来时若直接落笔：旧内容插进新一代，offset 还被旧文件的长度带偏，
 *    新一代的头几行永远对不上。正确行为是整份丢弃，并补上新一代的第一拉。
 * 2. **停止后不补拉**。服务崩溃时，最后的堆栈往往写在「最后一次轮询」到「进程消失」
 *    之间——active 一关就停轮询，那段就永远看不见，而排查崩溃恰恰只看那段。
 *    第二拍必须在第一拍**读完之后**再等：固定 800ms 定时的话，第一拍还没回来时
 *    它会被 inFlight 挡掉，慢盘上等于没有第二拍。
 *
 * 打桩方式：`serverLog` 返回一个不自动兑现的 promise，每笔调用记下 offset，
 * 测试里手动兑现——于是「在途」这个状态第一次变成可确定构造的。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  type Call = { offset: number; resolve: (v: { text: string; offset: number }) => void };
  const calls: Call[] = [];
  return { calls };
});

// 只打桩 IPC：拼行、解析都用真的（serverLog.ts 有自己的单测）
vi.mock("../lib/server", () => ({
  serverLog: (offset: number) =>
    new Promise<{ text: string; offset: number }>((resolve) => {
      h.calls.push({ offset, resolve });
    }),
}));

import { useServerLog } from "./useServerLog";

/** 探针组件：把 hook 的最新返回值暴露给测试。 */
let latest: { lines: { text: string }[] } = { lines: [] };
function Probe({ active, generation }: { active: boolean; generation: number }) {
  latest = useServerLog(active, generation);
  return null;
}

const texts = () => latest.lines.map((l) => l.text);

let root: Root | null = null;
const mount = (active: boolean, generation: number) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<Probe active={active} generation={generation} />);
};
const update = (active: boolean, generation: number) => {
  root?.render(<Probe active={active} generation={generation} />);
};

beforeEach(() => {
  // 全局假定时器：轮询间隔与补拉的 800ms 都变成可推进的，断言才不会碰运气
  vi.useFakeTimers();
  h.calls.length = 0;
  latest = { lines: [] };
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("useServerLog", () => {
  it("挂载即拉第一屏，之后按返回的 offset 续拉", async () => {
    mount(true, 0);
    await act(async () => {});
    expect(h.calls.map((c) => c.offset)).toEqual([0]);

    await act(async () => {
      h.calls[0].resolve({ text: "模块加载中\n", offset: 13 });
    });
    expect(texts()).toEqual(["模块加载中"]);

    // 间隔没到就没有新请求；到点后带的是上次的 offset，不是 0
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(h.calls.map((c) => c.offset)).toEqual([0, 13]);
  });

  it("换一代时在途的旧响应被整份丢弃，并补拉新一代", async () => {
    mount(true, 0);
    await act(async () => {});
    expect(h.calls.length).toBe(1);

    // 换一代：reset + tick，但 tick 被在途请求挡住（不会多发一个请求）
    update(true, 1);
    await act(async () => {});
    expect(h.calls.length).toBe(1);

    // 旧响应回来：内容不能出现，且必须补上新一代的第一拉（offset 归零）
    await act(async () => {
      h.calls[0].resolve({ text: "旧一代的残留\n", offset: 100 });
    });
    expect(texts()).toEqual([]);
    expect(h.calls.map((c) => c.offset)).toEqual([0, 0]);

    // 新一代的内容正常落笔
    await act(async () => {
      h.calls[1].resolve({ text: "新的一屏\n", offset: 9 });
    });
    expect(texts()).toEqual(["新的一屏"]);
  });

  it("停止后补拉尾部，第二拍跟在第一拍读完之后", async () => {
    mount(true, 0);
    await act(async () => {});
    await act(async () => {
      h.calls[0].resolve({ text: "ERROR 崩了\n", offset: 12 });
    });
    h.calls.length = 0; // 清账：只看停止之后发生了什么

    // 停止：interval 撤掉，但立刻补一拍（进程可能还在 flush）
    update(false, 0);
    await act(async () => {});
    expect(h.calls.map((c) => c.offset)).toEqual([12]);

    // 第一拍读完之前，第二拍必须还没有发（它排在读取之后，不是固定定时）
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(h.calls.length).toBe(1);

    // 第一拍读完 → 等 800ms → 第二拍：落盘慢的机器靠这个抓到真正的尾行
    await act(async () => {
      h.calls[0].resolve({ text: "", offset: 12 });
    });
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(h.calls.map((c) => c.offset)).toEqual([12, 12]);

    // 补拉照样能追加：这段就是崩溃现场。
    // （解析器会把级别词 ERROR 摘到 level 字段、栈行原样保留缩进，这是既有行为）
    await act(async () => {
      h.calls[1].resolve({ text: "    at nc.xxx(Start.java:42)\n", offset: 42 });
    });
    expect(texts()).toEqual(["崩了", "    at nc.xxx(Start.java:42)"]);
  });
});
