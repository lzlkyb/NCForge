// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ newConsole: vi.fn() }));
vi.mock("../../lib/dbActions", () => ({ newConsole: mocks.newConsole }));
import { TableMoreActions } from "./TableMoreActions";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const render = async (disabled = false) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onExport = vi.fn();
  const onImport = vi.fn();
  const onStructDiff = vi.fn();
  const onMove = vi.fn();
  await act(async () => root.render(
    <TableMoreActions connId="c" table="TEST" disabled={disabled}
      onExport={onExport} onImport={onImport} onStructDiff={onStructDiff} onMove={onMove} />,
  ));
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes(name))!;
  return { host, button, onExport, onImport, onStructDiff, onMove, done: async () => { await act(async () => root.unmount()); host.remove(); } };
};

it("导出 / 导入是常驻按钮，一次点击直达；断连时禁用", async () => {
  const t = await render();
  try {
    expect(t.button("导出").disabled).toBe(false);
    expect(t.button("导入").disabled).toBe(false);
    await act(async () => t.button("导出").click());
    await act(async () => t.button("导入").click());
    expect(t.onExport).toHaveBeenCalledOnce();
    expect(t.onImport).toHaveBeenCalledOnce();
  } finally { await t.done(); }
  const off = await render(true);
  try {
    expect(off.button("导出").disabled).toBe(true);
    expect(off.button("导入").disabled).toBe(true);
  } finally { await off.done(); }
});

it("结构对比 / 搬运 / 控制台查询收进更多，且不受 disabled 限制", async () => {
  const t = await render(true);
  // ContextMenu 挂 portal 到 body，菜单项是 [role="menuitem"]。
  const item = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent?.includes(label))!;
  try {
    await act(async () => t.button("更多").click());
    for (const label of ["与另一张表对比结构", "搬运到另一张表", "在控制台查询"]) {
      expect(item(label)).toBeTruthy();
    }
    await act(async () => item("与另一张表对比结构").click());
    expect(t.onStructDiff).toHaveBeenCalledOnce();
    // 选一项就关（与系统菜单一致），重开再验下一项。
    await act(async () => t.button("更多").click());
    await act(async () => item("在控制台查询").click());
    expect(mocks.newConsole).toHaveBeenCalledWith("c", "select * from TEST where rownum <= 100");
  } finally { await t.done(); }
});
