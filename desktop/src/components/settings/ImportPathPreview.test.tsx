// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), probe: vi.fn() }));
vi.mock("../../lib/workspace", () => ({ listDir: mocks.list }));
vi.mock("../../lib/server", () => ({ ncHomeProbe: mocks.probe }));
vi.mock("../../lib/configTransfer", async importOriginal => ({
  ...await importOriginal<typeof import("../../lib/configTransfer")>(),
  exportConfig: async () => JSON.stringify({ config: { workspace_root: "D:/current" } }),
}));
import { ImportPathPreview } from "./ImportPathPreview";
import { buildImportPlan } from "../../lib/configTransfer";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("旧路径检测晚返回时不会覆盖新路径检测结果", async () => {
  let rejectOld!: (error: Error) => void;
  mocks.list.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; })).mockResolvedValue([]);
  const plan = buildImportPlan({ app: "ncforge", schema: 1, from_version: "0.4.0", config: { workspace_root: "E:/A" } });
  function Harness() {
    const [edits, setEdits] = useState({ workspace_root: "E:/A" });
    return <ImportPathPreview plan={plan} edits={edits} idPrefix="import" disabled={false} onEdit={(key, value) => setEdits(prev => ({ ...prev, [key]: value }))} />;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => {
      const field = host.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "E:/B");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.textContent).toContain("目录可读取");
    await act(async () => rejectOld(new Error("旧目录检测失败")));
    expect(host.textContent).toContain("目录可读取");
    expect(host.textContent).not.toContain("旧目录检测失败");
    expect(mocks.list).toHaveBeenLastCalledWith("E:/B");
  } finally { await act(async () => root.unmount());host.remove(); }
});
