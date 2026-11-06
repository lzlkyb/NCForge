// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { metaGenerationPlan } from "../test/metaGenerationFixture";
import { generationFixture, generationResult } from "../test/generationWorkbenchFixture";
import { metaIssue } from "../test/metaFixtures";
import type { GenerationCheck, GenerationPreferences, GenerationPreview, GenerationResult } from "../lib/bmfGeneration";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../components/ui/toast", () => ({ toast: mocks.toast }));
import { useMetaGeneration } from "./useMetaGeneration";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, api: ReturnType<typeof useMetaGeneration>;
const path = "D:/workspace/METADATA/demo.bmf";
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>((r) => { resolve = r; }), resolve }; }
function Harness({ prefs, sha, onPrefs }: { prefs?: GenerationPreferences; sha?: string; onPrefs?: (prefs: GenerationPreferences) => void }) {
  api = useMetaGeneration(path, prefs, sha, onPrefs); return <div>{api.root}</div>;
}
beforeEach(() => {
  vi.useFakeTimers(); mocks.invoke.mockReset(); mocks.toast.mockReset();
  mocks.invoke.mockImplementation((command: string, args) => {
    if (command === "bmf_gen_preview") return Promise.resolve(generationFixture(args.root, { ...metaGenerationPlan, profile: args.profile ?? metaGenerationPlan.profile }));
    if (command === "bmf_gen_check") return Promise.resolve(generationFixture(args.root).check);
    if (command === "bmf_gen_apply") return Promise.resolve(generationResult(args.root));
    throw new Error(`unexpected ${command}`);
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
const calls = (name: string) => mocks.invoke.mock.calls.filter(([cmd]) => cmd === name);
const render = async (props = {}) => act(async () => root.render(<Harness {...props} />));

it("首次预览只调用一次合并接口，切选择不重复解析和生成", async () => {
  await render();
  expect(calls("bmf_gen_preview")).toHaveLength(1);
  expect(mocks.invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["bmf_gen_preview"]);
  act(() => api.setPreferences({ activeId: "vo", selected: [] }));
  expect(calls("bmf_gen_preview")).toHaveLength(1);
  expect(api.counts.selected).toBe(0);
});
it("配置连续输入保持可编辑，直到统一更新才生成，并保留空选择", async () => {
  await render();
  act(() => api.setPreferences({ selected: [], activeId: "vo" }));
  act(() => api.setPreferences({ profile: { ...api.profile!, basePackage: "nc" } }));
  act(() => api.setPreferences({ profile: { ...api.profile!, basePackage: "nc.vo" } }));
  expect(calls("bmf_gen_preview")).toHaveLength(1); expect(api.dirty).toBe(true);
  await act(async () => api.generate());
  expect(calls("bmf_gen_preview")).toHaveLength(2); expect(api.dirty).toBe(false);
  expect(api.prefs.selected).toEqual([]); expect(api.prefs.activeId).toBe("vo");
});
it("生成中的新输入不会被旧响应覆盖", async () => {
  await render(); const pending = deferred<GenerationPreview>();
  mocks.invoke.mockImplementationOnce(() => pending.promise);
  act(() => { void api.generate(); });
  act(() => api.setPreferences({ profile: { ...api.profile!, basePackage: "new.input" } }));
  await act(async () => pending.resolve(generationFixture(api.root)));
  expect(api.profile?.basePackage).toBe("new.input"); expect(api.dirty).toBe(true);
  expect(api.blockedReason).toContain("配置已修改");
});
it("连续输入目录防抖后检查一次，检查前禁止写入", async () => {
  await render();
  act(() => api.setRoot("D:/workspace/a")); act(() => api.setRoot("D:/workspace/b"));
  expect(api.blockedReason).toContain("检查"); expect(calls("bmf_gen_check")).toHaveLength(0);
  await act(async () => vi.advanceTimersByTime(300));
  expect(calls("bmf_gen_check")).toHaveLength(1);
  expect(calls("bmf_gen_check")[0][1].root).toBe("D:/workspace/b"); expect(api.blockedReason).toBeNull();
});
it("迟到的旧目录结果不能覆盖当前目录", async () => {
  await render(); const old = deferred<GenerationCheck>(), fresh = deferred<GenerationCheck>();
  mocks.invoke.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
  act(() => api.setRoot("D:/workspace/a")); await act(async () => vi.advanceTimersByTime(300));
  act(() => api.setRoot("D:/workspace/b")); await act(async () => vi.advanceTimersByTime(300));
  await act(async () => fresh.resolve(generationFixture("D:/workspace/b").check));
  await act(async () => old.resolve(generationFixture("D:/workspace/a").check));
  expect(api.snapshot?.root).toBe("D:/workspace/b"); expect(api.root).toBe("D:/workspace/b");
});
it("空选择和检查失败不能调用写入", async () => {
  await render(); act(() => api.setPreferences({ selected: [] }));
  await act(async () => api.apply()); expect(api.err).toContain("请选择");
  act(() => api.setPreferences({ selected: ["vo"] }));
  mocks.invoke.mockImplementationOnce(() => Promise.resolve({ ...generationFixture(api.root).check, error: "目录无效", snapshot: null }));
  await act(async () => api.check()); await act(async () => api.apply());
  expect(api.err).toContain("目录无效"); expect(calls("bmf_gen_apply")).toHaveLength(0);
});
it("规则错误可查看产物，但前后操作均不能发写入请求", async () => {
  mocks.invoke.mockImplementationOnce((_cmd, args) => Promise.resolve({ ...generationFixture(args.root), issues: [metaIssue({ severity: "error" })] }));
  await render(); expect(api.plan?.artifacts).toHaveLength(1);
  await act(async () => api.apply()); expect(api.err).toContain("校验错误"); expect(calls("bmf_gen_apply")).toHaveLength(0);
});
it("确认后选择变化时阻止沿用旧确认", async () => {
  await render(); const expected = api.snapshot;
  act(() => api.setPreferences({ selected: [] }));
  await act(async () => api.apply(expected, ["vo"], []));
  expect(calls("bmf_gen_apply")).toHaveLength(0);
});
it("写入携带精确预览与选择，双击不会重复写，完成后刷新状态", async () => {
  await render(); const expected = api.snapshot; const pending = deferred<GenerationResult>();
  mocks.invoke.mockImplementationOnce(() => pending.promise);
  act(() => { void api.apply(); void api.apply(); });
  expect(calls("bmf_gen_apply")).toHaveLength(1);
  expect(calls("bmf_gen_apply")[0][1]).toMatchObject({ expected, selected: ["vo"], force: false, overrides: [] });
  await act(async () => pending.resolve(generationResult(api.root)));
  expect(api.result?.written).toBe(1); expect(api.applying).toBe(false); expect(calls("bmf_gen_check")).toHaveLength(1);
});
it("部分失败仍保存成功结果和清单错误信息", async () => {
  await render();
  mocks.invoke.mockImplementationOnce(() => Promise.resolve({ ...generationResult(api.root), failed: 1, manifestError: "清单占用" }));
  await act(async () => api.apply());
  expect(api.result).toMatchObject({ written: 1, failed: 1, manifestError: "清单占用" });
  expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("失败项"), "error");
});
it("写入发现版本变化后清空就绪状态，重新预览前不能重试旧版本", async () => {
  await render(); mocks.invoke.mockImplementationOnce(() => Promise.reject(new Error("源文件已变化")));
  await act(async () => api.apply());
  expect(api.snapshot).toBeNull(); expect(api.err).toContain("已变化");
  await act(async () => api.apply()); expect(calls("bmf_gen_apply")).toHaveLength(1);
});
it("源 SHA 变化重新预览，失败时清掉旧内容", async () => {
  await render({ sha: "first" }); mocks.invoke.mockImplementationOnce(() => Promise.reject(new Error("文件不存在")));
  await render({ sha: "changed" });
  expect(api.plan).toBeNull(); expect(api.err).toContain("文件不存在");
});
it("写入期间多次源刷新只排队一次新预览，保留真实结果并解除写入状态", async () => {
  await render({ sha: "first" }); const pending = deferred<GenerationResult>();
  mocks.invoke.mockImplementationOnce(() => pending.promise);
  act(() => { void api.apply(); });
  await render({ sha: "changed" }); await render({ sha: "latest" });
  expect(calls("bmf_gen_preview")).toHaveLength(1);
  await act(async () => pending.resolve(generationResult(api.root)));
  expect(api.applying).toBe(false); expect(api.result?.written).toBe(1);
  expect(calls("bmf_gen_preview")).toHaveLength(2); expect(api.snapshot).not.toBeNull();
});
it("目标文件或真实路径变化后，重新检查撤销对应文件的旧覆盖授权", async () => {
  mocks.invoke.mockImplementationOnce((_cmd, args) => Promise.resolve(generationFixture(args.root, metaGenerationPlan, { vo: "modified" })));
  await render(); act(() => api.setPreferences({ overrides: ["vo"] }));
  const next = generationFixture(api.root, metaGenerationPlan, { vo: "modified" }).check;
  next.snapshot!.targets[0].targetSha256 = "new-handwritten-sha";
  mocks.invoke.mockImplementationOnce(() => Promise.resolve(next));
  await act(async () => api.check());
  expect(api.prefs.overrides).toEqual([]); expect(api.counts.keep).toBe(1);
  act(() => api.setPreferences({ overrides: ["vo"] }));
  const moved = { ...next, snapshot: { ...next.snapshot!, targets: next.snapshot!.targets.map((t) => ({ ...t, resolvedPath: "D:/workspace/other/DemoVO.java" })) } };
  mocks.invoke.mockImplementationOnce(() => Promise.resolve(moved));
  await act(async () => api.check()); expect(api.prefs.overrides).toEqual([]);
});
it("重新检查未变化的目标版本保留已核对的逐文件覆盖决策", async () => {
  mocks.invoke.mockImplementationOnce((_cmd, args) => Promise.resolve(generationFixture(args.root, metaGenerationPlan, { vo: "modified" })));
  await render(); act(() => api.setPreferences({ overrides: ["vo"] }));
  mocks.invoke.mockImplementationOnce(() => Promise.resolve(generationFixture(api.root, metaGenerationPlan, { vo: "modified" }).check));
  await act(async () => api.check()); expect(api.prefs.overrides).toEqual(["vo"]);
});
it("卸载后迟到的写入结果不通知用户也不继续检查", async () => {
  await render(); const pending = deferred<GenerationResult>(); mocks.invoke.mockImplementationOnce(() => pending.promise);
  act(() => { void api.apply(); }); act(() => root.render(null));
  await act(async () => pending.resolve(generationResult(api.root)));
  expect(mocks.toast).not.toHaveBeenCalled(); expect(calls("bmf_gen_check")).toHaveLength(0);
});
it("文档会话仅保留轻量偏好，重新进入恢复配置和选择", async () => {
  let saved: GenerationPreferences | undefined;
  await render({ onPrefs: (p: GenerationPreferences) => { saved = p; } });
  act(() => api.setPreferences({ search: "Demo", pane: "sources", selected: [] }));
  act(() => root.render(null)); await render({ prefs: saved });
  expect(api.prefs).toMatchObject({ search: "Demo", pane: "sources", selected: [] });
  expect(JSON.stringify(saved)).not.toContain("class DemoVO");
});
