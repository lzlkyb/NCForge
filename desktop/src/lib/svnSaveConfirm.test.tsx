// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
vi.mock("./dbStore", () => ({ connOf: vi.fn(), connect: vi.fn(), getDb: vi.fn(), rtOf: vi.fn(), txAction: vi.fn() }));
vi.mock("./db", () => ({ friendlyDbError: String }));
vi.mock("./dbApi", () => ({ dbApi: {} }));
vi.mock("../components/ui/toast", () => ({ toast: vi.fn() }));
import { askUnsavedFiles, settle, usePending, type Pending } from "./dbConfirm";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("保存期间 Escape/cancel 不会提前关闭确认或释放上层写锁", async () => {
  let current: Pending | null = null;
  function Harness() { current = usePending(); return null; }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  let finish!: (failed: []) => void;
  const onSave = () => new Promise<[]>(resolve => { finish = resolve; });
  let confirmation!: Promise<unknown>;
  await act(async () => { confirmation = askUnsavedFiles([{ path: "C:/a.java", name: "a.java", preview: false }], onSave, "提交选中文件", true, "svn"); });
  const request = current as unknown as Extract<Pending, { kind: "unsavedFiles" }>;
  const saved = request.onSave(vi.fn());
  const close = vi.fn((p: Pending) => { if (p.kind === "unsavedFiles") p.resolve("cancel"); });
  await act(async () => settle(close));
  expect(close).not.toHaveBeenCalled(); expect(current).toBe(request);
  finish([]); await saved;
  await act(async () => settle(close));
  expect(close).toHaveBeenCalledOnce(); expect(await confirmation).toBe("cancel");
  expect(current).toBeNull(); await act(async () => root.unmount()); host.remove();
});
