// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ history: vi.fn(), diff: vi.fn() }));
vi.mock("../../lib/svnHistory", async importOriginal => ({ ...await importOriginal<typeof import("../../lib/svnHistory")>(), svnHistory: mocks.history, svnRevisionDiff: mocks.diff }));
vi.mock("./SvnDiffEditor", () => ({ SvnDiffEditor: ({ originalLabel, modifiedLabel }: { originalLabel: string; modifiedLabel: string }) => <div>{originalLabel} ↔ {modifiedLabel}</div> }));
import { HistoryView } from "./HistoryView";
import { setSession } from "../../lib/workspaceSession";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); mocks.history.mockReset(); mocks.diff.mockReset(); setSession({ root: null }); });
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
it("历史选择请求真实revision路径，可切换工作副本范围", async () => {
  setSession({ root: "D:/root" });
  mocks.history.mockResolvedValue({ repositoryPath: "/", entries: [{ revision: 9, author: "alice", date: 1, message: "change", paths: [{ path: "/module/A.java", action: "M", copyFromPath: null, copyFromRevision: -1 }] }] });
  mocks.diff.mockResolvedValue({ path: "/module/A.java", beforePath: "/module/A.java", beforeRevision: 8, revision: 9, beforeEmpty: false, afterEmpty: false, beforeText: "old", afterText: "new" });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  dispose = () => { act(() => root.unmount()); host.remove(); };
  await act(async () => root.render(<QueryClientProvider client={qc}><HistoryView path="D:/root/module/A.java" title="A.java" modulePath="D:/root/module" onBack={vi.fn()} /></QueryClientProvider>)); await flush();
  await act(async () => host.querySelector<HTMLButtonElement>(".vc-history-record")!.click()); await flush();
  expect(mocks.diff).toHaveBeenCalledWith("/module/A.java", 9); expect(host.textContent).toContain("/module/A.java @ r8 ↔ /module/A.java @ r9");
  const scope = host.querySelector<HTMLSelectElement>('[aria-label="历史范围"]')!;
  await act(async () => { scope.value = "root"; scope.dispatchEvent(new Event("change", { bubbles: true })); }); await flush(); expect(mocks.history).toHaveBeenLastCalledWith("D:/root", 30, 0);
});
