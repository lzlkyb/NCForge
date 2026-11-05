// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfDetail } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaCopyEntityDialog } from "./MetaCopyEntityDialog";

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

const attr = {
  id: "a1",
  name: "pk",
  field: "pk",
  displayName: "主键",
  typeName: "UFID",
  typeDisplayName: "",
  dataType: "",
  style: "SINGLE",
  dbType: "char",
  fieldType: "char",
  length: 20,
  precision: null,
  isKey: true,
  nullable: false,
  defaultValue: "",
  refModel: "",
  sequence: 0,
  refTarget: "",
  raw: "",
};

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
    { id: "e1", name: "H", displayName: "表头", fullClass: "nc.vo.m.c.H", table: "h", accessor: "nc.vo.m.c.H", isPrimary: true, keyAttrId: "a1", attrs: [attr], raw: "" },
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

it("复制实体：字段随实体一次提交，id 不复制", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_edit_preview") return Promise.resolve("diff");
    if (cmd === "bmf_edit_save") return Promise.resolve({ path: "x", backup: null, shaBefore: "a", shaAfter: "b", diff: "", changed: true });
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  await act(async () =>
    root.render(<MetaCopyEntityDialog path={detail.path} sha="sha" detail={detail} onClose={() => {}} onSaved={() => {}} />),
  );

  expect(document.body.textContent).toContain("将复制 1 个字段");
  await act(async () => button("预览 diff").click());
  await flush();
  await act(async () => button("保存").click());
  await flush();

  const call = mocks.invoke.mock.calls.find(([cmd]) => cmd === "bmf_edit_save")!;
  const ops = (call[1] as { ops: Record<string, unknown>[] }).ops;
  expect(ops).toHaveLength(1);
  const op = ops[0] as {
    op: string;
    name: string;
    table: string;
    fullClass: string;
    attrs: Record<string, unknown>[];
  };
  expect(op.op).toBe("addEntity");
  expect(op.name).toBe("H2");
  expect(op.table).toBe("h2");
  expect(op.fullClass).toBe("nc.vo.m.c.H2");
  expect(op.attrs).toHaveLength(1);
  expect(op.attrs[0]).toMatchObject({ name: "pk", typeName: "UFID", isKey: true, length: 20 });
  expect(op.attrs[0].id).toBeUndefined();
});
