// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfDetail } from "../lib/bmf";
import { metaDetail, metaEntry } from "../test/metaFixtures";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: mocks.invoke }));
import { useMetaDocuments } from "./useMetaDocuments";
import { newMetaDraft } from "../lib/metaDraft";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, api: ReturnType<typeof useMetaDocuments>;
function Harness() { api = useMetaDocuments(); return <div>{api.active?.entry.name}</div>; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
beforeEach(async () => {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((command: string, args: { path: string }) => {
    if (command === "bmf_doc_detail") return Promise.resolve(metaDetail(args.path.split("/").pop()!.replace(".bmf", "")));
    if (command === "bmf_validate") return Promise.resolve([]);
    throw new Error(`unexpected ${command}`);
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("切文档恢复字段选择、筛选与滚动；规范化路径避免重复标签", async () => {
  await act(async () => api.open(metaEntry("a"))); await flush();
  act(() => api.updateUi(api.active!.key, { selection: { kind: "attr", entityId: "head", attrId: "amount" }, filter: "amount", mode: "fields" }));
  act(() => api.updateUi(api.active!.key, { fieldScroll: { top: 640, left: 120 } }, false));
  await act(async () => api.open(metaEntry("b"))); await flush();
  await act(async () => api.open(metaEntry("a", { path: "d:\\workspace\\METADATA\\a.bmf" }))); await flush();
  expect(api.documents).toHaveLength(2);
  expect(api.active!.ui.selection).toEqual({ kind: "attr", entityId: "head", attrId: "amount" });
  expect(api.active!.ui.fieldScroll).toEqual({ top: 640, left: 120 });
  expect(api.active!.ui.filter).toBe("amount");
});
it("先关闭再重开同一路径，旧请求不能覆盖新文档", async () => {
  const old = deferred<BmfDetail>(), fresh = deferred<BmfDetail>();
  mocks.invoke.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
  act(() => api.open(metaEntry("a")));
  const key = api.active!.key;
  act(() => api.close(key));
  act(() => api.open(metaEntry("a")));
  await act(async () => fresh.resolve(metaDetail("a", { sha256: "new" }))); await flush();
  await act(async () => old.resolve(metaDetail("a", { sha256: "old" }))); await flush();
  expect(api.active!.detail!.sha256).toBe("new");
});
it("后台刷新只更新原文档，不抢走活动文档", async () => {
  await act(async () => api.open(metaEntry("a"))); await flush();
  await act(async () => api.open(metaEntry("b"))); await flush();
  const pending = deferred<BmfDetail>();
  mocks.invoke.mockImplementationOnce(() => pending.promise);
  act(() => { void api.refresh(metaEntry("a")); });
  await act(async () => pending.resolve(metaDetail("a", { sha256: "saved" }))); await flush();
  expect(api.active!.entry.name).toBe("b");
  expect(api.documents.find((d) => d.entry.name === "a")!.detail!.sha256).toBe("saved");
});
it("同 SHA 复用校验，但每次打开仍读盘；外部变更恢复到新属性对象", async () => {
  await act(async () => api.open(metaEntry())); await flush();
  await act(async () => api.open(metaEntry())); await flush();
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "bmf_validate")).toHaveLength(1);
  const fresh = metaDetail(); fresh.sha256 = "external"; fresh.entities[0].attrs[0].displayName = "外部改名";
  mocks.invoke.mockImplementationOnce(() => Promise.resolve(fresh));
  await act(async () => api.open(metaEntry())); await flush();
  expect(api.active!.detail!.entities[0].attrs[0].displayName).toBe("外部改名");
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "bmf_doc_detail")).toHaveLength(3);
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "bmf_validate")).toHaveLength(2);
});
it("详情缓存有数目上限，淘汰后保留标签和轻量视图状态", async () => {
  for (let i = 0; i < 9; i++) { await act(async () => api.open(metaEntry(`doc${i}`))); await flush(); }
  expect(api.documents).toHaveLength(9);
  expect(api.documents.filter((d) => d.detail)).toHaveLength(6);
  expect(api.active!.detail).not.toBeNull();
});

it("详情缓存受字节预算限制，超大活动文档单独保留", async () => {
  mocks.invoke.mockImplementation((command: string, args: { path: string }) => {
    if (command === "bmf_validate") return Promise.resolve([]);
    const name = args.path.split("/").pop()!.replace(".bmf", "");
    // 用元数据大小模拟预算边界，不分配大字符串或临时文件。
    return Promise.resolve(metaDetail(name, { size: (name === "huge" ? 17 : 6) * 1024 * 1024 }));
  });
  await act(async () => api.open(metaEntry("a"))); await flush();
  act(() => api.updateUi(api.active!.key, { filter: "amount" }));
  for (const name of ["b", "c"]) { await act(async () => api.open(metaEntry(name))); await flush(); }
  expect(api.documents.filter((d) => d.detail).map((d) => d.entry.name)).toEqual(["b", "c"]);
  expect(api.documents.find((d) => d.entry.name === "a")!.ui.filter).toBe("amount");
  await act(async () => api.open(metaEntry("huge"))); await flush();
  expect(api.documents.filter((d) => d.detail)).toHaveLength(1);
  expect(api.active!.entry.name).toBe("huge");
  await act(async () => api.open(metaEntry("b"))); await flush();
  expect(api.documents.filter((d) => d.detail)).toHaveLength(1);
  expect(api.active!.entry.name).toBe("b");
});

it("滚动不主动重绘资源树，但下一次父级渲染仍读取最新视图状态", async () => {
  await act(async () => api.open(metaEntry())); await flush();
  act(() => api.updateUi(api.active!.key, { canvas: { moved: { head: { x: 400, y: 200 } }, zoom: 1.2, top: 80, left: 120 } }, false));
  act(() => root.render(<Harness />));
  expect(api.active!.ui.canvas.moved.head).toEqual({ x: 400, y: 200 });
  expect(api.active!.ui.canvas.zoom).toBe(1.2);
});

it("保存作废旧刷新，迟到结果不能覆盖已保存的对象与选择", async () => {
  await act(async () => api.open(metaEntry("a"))); await flush();
  const source = api.active!;
  const pending = deferred<BmfDetail>(); mocks.invoke.mockImplementationOnce(() => pending.promise);
  act(() => { void api.refresh(source.entry); });
  act(() => api.applyDraftSaved(source.key, metaDetail("a", { sha256: "saved", issues: [] }), source.instance));
  await act(async () => pending.resolve(metaDetail("a", { sha256: "old" }))); await flush();
  expect(api.active!.detail!.sha256).toBe("saved"); expect(api.active!.busy).toBe(false);
});
it("关闭再打开同路径，旧草稿回写不能进入新文档实例", async () => {
  await act(async () => api.open(metaEntry("a"))); await flush();
  const old = api.active!;
  act(() => api.close(old.key)); await act(async () => api.open(metaEntry("a"))); await flush();
  act(() => { expect(api.updateDraft(old.key, { ...newMetaDraft(), error: "旧请求" }, old.instance)).toBe(false); });
  expect(api.active!.draft.error).toBeNull();
});
it("详情被淘汰时仍能清理草稿；存在草稿的文档不能直接关闭", async () => {
  await act(async () => api.open(metaEntry("a"))); await flush();
  const key = api.active!.key;
  act(() => api.updateUi(key, { selection: { kind: "attr", entityId: "head", attrId: "amount" } }));
  for (let i = 0; i < 7; i++) { await act(async () => api.open(metaEntry(`new${i}`))); await flush(); }
  expect(api.documents.find((d) => d.key === key)!.detail).toBeNull();
  act(() => { expect(api.updateDraft(key, newMetaDraft())).toBe(true); });
  await act(async () => api.open(metaEntry("a"))); await flush();
  act(() => api.updateDraft(key, { ...newMetaDraft(), baseSha: "sha-original", steps: [{ id: "step", label: "修改", ops: [{ op: "setAttr", id: "amount", name: "displayName", value: "新名称" }] }] }));
  act(() => { expect(api.close(key)).toBe(false); });
  expect(api.documents.some((d) => d.key === key)).toBe(true);
  act(() => { expect(api.close(key, true)).toBe(true); });
});
it("预览的迟到结果不能清除已发现的外部冲突", async () => {
  await act(async () => api.open(metaEntry("a"))); await flush(); const source = api.active!;
  mocks.invoke.mockResolvedValueOnce(metaDetail("a", { sha256: "external", issues: [] }));
  await act(async () => api.refresh(source.entry));
  act(() => api.updateDraft(source.key, { ...newMetaDraft(), baseSha: "sha-original", reviewedSha: "old-preview",
    steps: [{ id: "s", label: "修改", ops: [] }] }, source.instance));
  expect(api.active!.draft.reviewedSha).toBeNull(); expect(api.active!.draft.error).toContain("外部修改");
});
