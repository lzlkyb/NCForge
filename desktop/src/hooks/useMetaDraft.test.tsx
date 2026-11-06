// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { BmfDetail, BmfDraftPreview, BmfEditOp } from "../lib/bmf";
import { newMetaDraft, type MetaDraft } from "../lib/metaDraft";
import { metaDetail } from "../test/metaFixtures";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: mocks.invoke }));
import { useMetaDraft } from "./useMetaDraft";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, draft: MetaDraft, active: string, api: ReturnType<typeof useMetaDraft>;
let stored: Record<string, MetaDraft>;
let saved = vi.fn<(detail: BmfDetail) => void>();
const preview = (ops: BmfEditOp[]): BmfDraftPreview => ({ detail: metaDetail("a", { sha256: `sha-${JSON.stringify(ops)}`, issues: [] }), baseSha: "sha-original", diff: "diff", ops, blockingIssues: [] });
function Harness() {
  const name = active;
  api = useMetaDraft({ base: metaDetail(name), draft, onChange: (next) => {
    stored[name] = next;
    if (active === name) { draft = next; root.render(<Harness />); }
    return true;
  }, onSaved: saved, onDiscard: () => {} });
  return null;
}
beforeEach(async () => {
  mocks.invoke.mockReset(); active = "a"; draft = newMetaDraft(); stored = {}; saved = vi.fn<(detail: BmfDetail) => void>();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  mocks.invoke.mockImplementation((command: string, args: { ops: BmfEditOp[] }) => command === "bmf_draft_preview" ? Promise.resolve(preview(args.ops)) : Promise.resolve({ changed: true }));
  await act(async () => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });
const stage = async (ops: BmfEditOp[]) => { await act(async () => { await api.stage("修改", ops); }); };
it("撤销重做和保存沿用新对象的相同 ID，保存必须先审阅", async () => {
  await stage([{ op: "addAttribute", entity: "head", name: "newfield", displayName: "新字段" }]);
  const id = (draft.steps[0].ops[0] as { id: string }).id;
  expect(id).toBeTruthy();
  await act(async () => { expect(await api.save()).toBe(false); });
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "bmf_edit_save")).toBe(false);
  await act(async () => { await api.undo(); }); expect(draft.steps).toHaveLength(0);
  await act(async () => { await api.redo(); }); expect((draft.steps[0].ops[0] as { id: string }).id).toBe(id);
  await act(async () => { await api.review(); });
  await act(async () => { expect(await api.save()).toBe(true); });
  expect(saved).toHaveBeenCalledOnce();
  expect(mocks.invoke.mock.calls.find(([cmd]) => cmd === "bmf_edit_save")![1]).toMatchObject({ expectedSha: "sha-original", expectedDefinitions: {}, strict: true });
});
it("失败保留前面的完整草稿并使旧审阅失效", async () => {
  await stage([{ op: "setAttr", id: "billcode", name: "displayName", value: "新名称" }]);
  await act(async () => { await api.review(); });
  mocks.invoke.mockRejectedValueOnce(new Error("校验失败"));
  await act(async () => { await expect(api.stage("错误", [{ op: "setAttr", id: "amount", name: "length", value: "-1" }])).rejects.toThrow("校验失败"); });
  expect(draft.steps).toHaveLength(1); expect(draft.busy).toBe(false); expect(draft.reviewedSha).toBeNull();
});
it("等待期间切文档，结果回到发起文档并释放 busy", async () => {
  let resolve!: (result: BmfDraftPreview) => void;
  mocks.invoke.mockImplementationOnce(() => new Promise<BmfDraftPreview>((r) => { resolve = r; }));
  let task!: Promise<boolean>;
  const ops: BmfEditOp[] = [{ op: "setAttr", id: "billcode", name: "displayName", value: "A 的修改" }];
  await act(async () => { task = api.stage("A", ops); });
  expect(stored.a.busy).toBe(true);
  await act(async () => { active = "b"; draft = newMetaDraft(); root.render(<Harness />); });
  await act(async () => { resolve(preview(ops)); await task; });
  expect(stored.a.busy).toBe(false); expect(stored.a.steps).toHaveLength(1); expect(draft.steps).toEqual([]);
});
it("预览变化后禁止落盘，草稿保留", async () => {
  await stage([{ op: "setAttr", id: "billcode", name: "displayName", value: "新名称" }]);
  await act(async () => { await api.review(); });
  mocks.invoke.mockImplementationOnce((_cmd: string, args: { ops: BmfEditOp[] }) => Promise.resolve({ ...preview(args.ops), detail: { ...preview(args.ops).detail, sha256: "changed-preview" } }));
  await act(async () => { expect(await api.save()).toBe(false); });
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "bmf_edit_save")).toBe(false);
  expect(draft.error).toContain("已变化");
});
it("外部接口定义变化后，即使投影 SHA 不变也要重新预览", async () => {
  await stage([{ op: "setAttr", id: "billcode", name: "displayName", value: "新名称" }]);
  await act(async () => { await api.review(); });
  mocks.invoke.mockImplementationOnce((_cmd: string, args: { ops: BmfEditOp[] }) => Promise.resolve({ ...preview(args.ops), detail: { ...preview(args.ops).detail,
    interfaces: [{ id: "itf", name: "IInfo", displayName: "接口", fullClass: "nc.vo.IInfo", attrs: [], external: true, sourcePath: "external.bmf", definitionSha: "new-definition" }] } }));
  await act(async () => { expect(await api.save()).toBe(false); });
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "bmf_edit_save")).toBe(false);
});
