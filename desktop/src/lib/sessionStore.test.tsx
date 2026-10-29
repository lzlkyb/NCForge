// @vitest-environment jsdom
/**
 * sessionStore 工厂单测（P2-9）。
 *
 * 这个工厂是「切页不丢状态」的唯一机制载体，三个页面（数据库/日志/版本控制）
 *
 * 的会话态全压在它身上，所以两件事必须钉死：
 * 1. **不可变快照 + 全等不广播**——值没变就绝不能再渲染（日志过滤框每敲一个
 *    字符都会 set 一次，空广播会让面板跟着轮询数据一起抖）；
 * 2. **卸载期间写入、重挂载首帧即最新**——useState + effect 补订阅的模式会先
 *    渲染一帧旧值，而「回来继续写 SQL」要的正是零闪烁。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { createSessionStore, useSessionStore, type SessionStore } from "./sessionStore";

interface Form {
  a: number;
  b: string;
}

function newStore(): SessionStore<Form> {
  return createSessionStore<Form>({ a: 1, b: "x" });
}

describe("createSessionStore", () => {
  it("patch 只改命中字段，其余原样", () => {
    const s = newStore();
    s.set({ b: "y" });
    expect(s.get()).toEqual({ a: 1, b: "y" });
  });

  it("全等 patch 不广播（避免空渲染）", () => {
    const s = newStore();
    let calls = 0;
    s.subscribe(() => {
      calls += 1;
    });
    s.set({ a: 1 }); // 同值
    expect(calls).toBe(0);
    s.set({ b: "x" }); // 同值
    expect(calls).toBe(0);
    s.set({ a: 2 }); // 不同值
    expect(calls).toBe(1);
  });

  it("多字段 patch 有一个不同就广播，且是全量合并", () => {
    const s = newStore();
    let calls = 0;
    s.subscribe(() => {
      calls += 1;
    });
    s.set({ a: 1, b: "z" });
    expect(calls).toBe(1);
    expect(s.get()).toEqual({ a: 1, b: "z" });
  });

  it("写入产生新快照，旧快照保持不可变", () => {
    const s = newStore();
    const before = s.get();
    s.set({ a: 2 });
    expect(before).toEqual({ a: 1, b: "x" });
    expect(s.get()).not.toBe(before);
  });

  it("退订后不再收到通知", () => {
    const s = newStore();
    let calls = 0;
    const off = s.subscribe(() => {
      calls += 1;
    });
    s.set({ a: 2 });
    expect(calls).toBe(1);
    off();
    s.set({ a: 3 });
    expect(calls).toBe(1);
  });
});

describe("useSessionStore", () => {
  it("卸载期间的写入不丢：重挂载首帧就是最新快照", () => {
    const store = newStore();
    const host = document.createElement("div");
    document.body.appendChild(host);

    function Probe() {
      const s = useSessionStore(store);
      return <span>{`${s.a}:${s.b}`}</span>;
    }

    const r1: Root = createRoot(host);
    act(() => r1.render(<Probe />));
    expect(host.textContent).toBe("1:x");

    // 卸载期间写入（模拟切页后异步回调/事件写仓库）
    act(() => r1.unmount());
    act(() => store.set({ a: 7, b: "after" }));

    // 重新挂载：不允许先渲染一帧旧值
    const r2: Root = createRoot(host);
    act(() => r2.render(<Probe />));
    expect(host.textContent).toBe("7:after");

    act(() => r2.unmount());
    host.remove();
  });

  it("挂载中收到广播会重渲染", () => {
    const store = newStore();
    const host = document.createElement("div");
    document.body.appendChild(host);

    function Probe() {
      const s = useSessionStore(store);
      return <span>{s.a}</span>;
    }

    const r: Root = createRoot(host);
    act(() => r.render(<Probe />));
    expect(host.textContent).toBe("1");
    act(() => store.set({ a: 42 }));
    expect(host.textContent).toBe("42");

    act(() => r.unmount());
    host.remove();
  });
});
