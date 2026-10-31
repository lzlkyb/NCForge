// @vitest-environment jsdom
/**
 * 会话与锁面板的接线。
 *
 * 盯三件事，都是这类面板最容易做错的：
 * ① 阻塞关系看得见（哪条被谁堵）；
 * ② `granted: false` 时必须显式说「锁信息不可见」——把看不见锁显示成没有锁是事故；
 * ③ 「复制 KILL」复制的是 `sid,serial` 两条一起，少一个就杀不掉。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));

vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));

import type { SessionsResult } from "../../lib/dbApi";
import { SessionDrawer } from "./SessionDrawer";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const copySpy = vi.fn(async () => {});
Object.assign(navigator, { clipboard: { writeText: copySpy } });

const result = (over: Partial<SessionsResult> = {}): SessionsResult => ({
  granted: true,
  rows: [
    {
      sid: 42,
      serial: 7788,
      user: "AIER633",
      machine: "PC-01",
      program: "JDBC Thin Client",
      status: "ACTIVE",
      blocker: 9,
      event: "enq: TM - contention",
      waitClass: "Application",
      waitSec: 37,
      elapsedSec: 41,
      sqlId: "8k1x2y3z",
      locked: ["AIER633.BD_MATERIAL(TABLE,L6)"],
      sql: "update bd_material set name = 'x' where pk = '1'",
    },
    {
      sid: 9,
      serial: 1234,
      user: "AIER633",
      machine: "PC-02",
      program: "JDBC Thin Client",
      status: "ACTIVE",
      blocker: null,
      event: "SQL*Net message from client",
      waitClass: "Idle",
      waitSec: 0,
      elapsedSec: 5,
      sqlId: "aaa111",
      locked: [],
      sql: "",
    },
  ],
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mocks.invoke.mockReset();
  copySpy.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

const flush = () => act(async () => {});

async function mount(data: SessionsResult) {
  mocks.invoke.mockResolvedValue(data);
  await act(async () => {
    root?.render(<SessionDrawer connId="c1" onClose={() => {}} />);
  });
  await flush();
}

const byText = (sel: string, text: string) =>
  [...host.querySelectorAll(sel)].find((e) => (e.textContent ?? "").includes(text));

describe("SessionDrawer", () => {
  it("列出会话、标出阻塞源与锁对象", async () => {
    await mount(result());

    // 调的是元数据的 sessions 这一种，不是另开一个命令
    const [cmd, args] = mocks.invoke.mock.calls[0];
    expect(cmd).toBe("db_meta");
    expect(args).toMatchObject({ id: "c1", kind: "sessions" });

    const rows = [...host.querySelectorAll("tbody tr")];
    expect(rows.length).toBe(2);

    // 被阻塞的那行要能一眼看出来：整行标了 data-blocked，SID 后面跟阻塞源
    const blocked = rows.find((r) => r.hasAttribute("data-blocked"));
    expect(blocked).toBeTruthy();
    expect(blocked?.textContent).toContain("←9");
    expect(blocked?.textContent).toContain("enq: TM - contention");
    expect(blocked?.textContent).toContain("AIER633.BD_MATERIAL(TABLE,L6)");

    // 没被阻塞的行不该被染红
    expect(rows.filter((r) => r.hasAttribute("data-blocked")).length).toBe(1);
  });

  it("granted:false 时明确说「锁信息不可见」，不冒充没有锁", async () => {
    await mount(result({ granted: false }));

    expect(host.textContent).toContain("锁信息不可见");
    expect(host.textContent).toContain("grant select on v$locked_object");
    // 会话列表照常显示（降级只丢锁信息，不丢整个面板）
    expect(host.querySelectorAll("tbody tr").length).toBe(2);
  });

  it("复制 KILL 用的是 sid 与 serial 两条", async () => {
    await mount(result());

    const btn = byText("button", "复制 KILL");
    expect(btn).toBeTruthy();
    await act(async () => {
      (btn as HTMLButtonElement).click();
    });
    expect(copySpy).toHaveBeenCalledWith("alter system kill session '42,7788';");
  });
});
