// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), keep: vi.fn() }));
vi.mock("../../lib/svnHistory", () => ({ svnConflictSnapshot: mocks.snapshot, svnResolveWorking: mocks.keep }));
vi.mock("./SvnDiffEditor", () => ({ SvnDiffEditor: ({ original, modified }: { original: string; modified: string }) => <div data-testid="compare">{original} → {modified}</div> }));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));
import { ConflictPane } from "./ConflictPane";
import { setSession } from "../../lib/workspaceSession";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
const file = { path: "D:/conflict/A.java", rel: "A.java", module: "根目录", letter: "C" as const, status: "conflicted", revision: 2, isDir: false, ignored: false };
const version = (role: string, revision: number, text: string) => ({ role, revision, text, name: `A.java.${role}`, encoding: "UTF-8", binary: false });
const fixture = { treeConflict: false, propertyConflict: false, textConflict: true, mine: version("mine", -1, "my content"), base: version("base", 2, "old content"), theirs: version("theirs", 9, "server content"), workingReadable: true, workingHasMarkers: false };
beforeEach(() => { setSession({ root: "D:/conflict" }); mocks.snapshot.mockReset(); mocks.keep.mockReset(); });
afterEach(() => { dispose(); setSession({ root: null }); });
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
async function render(data = fixture) {
  mocks.snapshot.mockResolvedValue(data); const resolve = vi.fn(), later = vi.fn();
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); const invalidate = vi.spyOn(qc, "invalidateQueries");
  dispose = () => { act(() => root.unmount()); host.remove(); };
  await act(async () => root.render(<QueryClientProvider client={qc}><ConflictPane file={file} busy={false} onResolve={resolve} onOpenFile={vi.fn()} onLater={later} /></QueryClientProvider>)); await flush();
  return { host, resolve, later, invalidate };
}
it("真实服务器版本与基线内容可预览，选择版本本身不写入", async () => {
  const { host, resolve } = await render(); expect(host.textContent).toContain("服务器内容 · r9");
  const select = host.querySelectorAll<HTMLButtonElement>("[aria-pressed]")[0];
  await act(async () => select.click()); expect(resolve).not.toHaveBeenCalled();
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "确认使用所选版本")!.click()); expect(resolve).toHaveBeenCalledWith("mine");
});
it("保留手工结果完成后刷新SVN与补丁，再离开当前项", async () => {
  mocks.keep.mockResolvedValue({ backupDir: "D:/backup" }); const { host, later, invalidate } = await render();
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "保留手工合并结果")!.click());
  expect(mocks.keep).toHaveBeenCalledWith(file.path); expect(invalidate).toHaveBeenCalledWith({ queryKey: ["svn-status"] }); expect(invalidate).toHaveBeenCalledWith({ queryKey: ["patch-scan"] }); expect(later).toHaveBeenCalledTimes(1);
});
it("尚有冲突标记和树冲突时不允许保留手工结果", async () => {
  const { host } = await render({ ...fixture, treeConflict: true, workingHasMarkers: true });
  expect(host.textContent).toContain("这是树冲突"); expect([...host.querySelectorAll("button")].find(button => button.textContent === "保留手工合并结果")!.disabled).toBe(true); expect(mocks.keep).not.toHaveBeenCalled();
});
