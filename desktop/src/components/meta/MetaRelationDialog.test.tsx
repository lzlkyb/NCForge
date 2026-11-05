// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfDetail } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaRelationDialog } from "./MetaRelationDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  mocks.invoke.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const attr = (id: string, name: string) => ({
  id,
  name,
  field: name,
  displayName: "",
  typeName: "String",
  typeDisplayName: "",
  dataType: "",
  style: "SINGLE",
  dbType: "",
  fieldType: "",
  length: 20,
  precision: null,
  isKey: false,
  nullable: true,
  defaultValue: "",
  refModel: "",
  sequence: 0,
  refTarget: "",
  raw: "",
});

const detail: BmfDetail = {
  path: "D:/w/a.bmf",
  encoding: "UTF-8",
  eol: "CRLF",
  bom: true,
  size: 10,
  sha256: "sha",
  mtimeMs: 0,
  component: {
    id: "c",
    name: "c",
    displayName: "",
    namespace: "m",
    ownModule: "m",
    genCodeStyle: "",
    version: 1,
    mainEntity: "e1",
    industry: "",
    metaType: "",
  },
  entities: [
    { id: "e1", name: "H", displayName: "表头", fullClass: "nc.vo.m.c.H", table: "h", accessor: "", isPrimary: true, keyAttrId: "a1", attrs: [attr("a1", "pk")], raw: "" },
    { id: "e2", name: "B", displayName: "表体", fullClass: "nc.vo.m.c.B", table: "b", accessor: "", isPrimary: false, keyAttrId: "a2", attrs: [attr("a2", "pk_b")], raw: "" },
  ],
  enums: [],
  relations: [],
  unknownTags: [],
};

const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!;
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

it("新增关系：默认两端是已有实体，提交 addRelation", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_edit_preview") return Promise.resolve("diff");
    if (cmd === "bmf_edit_save") return Promise.resolve({ path: "x", backup: null, shaBefore: "a", shaAfter: "b", diff: "", changed: true });
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  await act(async () => root.render(<MetaRelationDialog path={detail.path} sha="sha" detail={detail} onClose={() => {}} onSaved={() => {}} />));

  await act(async () => button("预览 diff").click());
  await flush();
  await act(async () => button("保存").click());
  await flush();

  const call = mocks.invoke.mock.calls.find(([cmd]) => cmd === "bmf_edit_save")!;
  const ops = (call[1] as { ops: Record<string, unknown>[] }).ops;
  expect(ops).toEqual([
    expect.objectContaining({ op: "addRelation", kind: "AggregationRelation", source: "e1", target: "e2" }),
  ]);
});

it("两端同一实体时禁止预览", async () => {
  await act(async () => root.render(<MetaRelationDialog path={detail.path} sha="sha" detail={detail} onClose={() => {}} onSaved={() => {}} />));
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="目标实体"]')!;
  act(() => {
    select.value = "e1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.body.textContent).toContain("不能是同一个实体");
  expect(button("预览 diff").disabled).toBe(true);
});
