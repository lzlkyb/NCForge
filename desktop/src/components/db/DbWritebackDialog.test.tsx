// @vitest-environment jsdom
/**
 * 写回预览弹窗（结果页「执行前先给人看」的那一步）。
 *
 * 钉四件事：① diff 与生成的 SQL 真的渲染出来，不是空框；② 提交 / 逐项撤销 /
 * 全部撤销各调各的回调；③ 空计划与 saving 态都把提交按住；④ 关闭走 onClose。
 * 执行本身（生产库确认、逐条 execBound）归调用方 save()，在这里不碰。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Cell } from "../../lib/dbApi";
import type { RowChange } from "../../lib/dbOptimisticEdit";
import { DbWritebackDialog } from "./DbWritebackDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const columns = [
  { name: "ID", type: "NUMBER", precision: 10, scale: 0 },
  { name: "CODE", type: "VARCHAR2(40)", precision: 40, scale: 0 },
];
const rows: Cell[][] = [[1, "a"], [2, "b"]];

const update: RowChange = {
  kind: "update",
  row: 0,
  sql: "update bd_material set CODE = :1 where ID = :2 and CODE = :3",
  params: ["b", { number: "1" }, "a"],
  cells: [{ column: 1, before: "a", after: "b" }],
};
const del: RowChange = {
  kind: "delete",
  row: 1,
  sql: "delete from bd_material where ID = :1",
  params: [{ number: "2" }],
  cells: [],
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => {});

/** Modal 走 portal 挂到 body，断言都在 document.body 上找。 */
const bodyText = () => document.body.textContent ?? "";
const bodyButton = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes(label));

function render(over: Partial<Parameters<typeof DbWritebackDialog>[0]> = {}) {
  const props = {
    open: true,
    changes: [update, del],
    columns,
    rows,
    pk: ["ID"],
    saving: false,
    onUndo: vi.fn(),
    onUndoAll: vi.fn(),
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  return { props, ...props };
}

it("渲染 diff 与生成的 SQL，提交调 onSubmit", async () => {
  const { props } = render();
  await act(async () => { root.render(<DbWritebackDialog {...props} />); });
  await flush();

  expect(bodyText()).toContain("预览待写回的更改");
  // 结构 diff：字段、原值、新值、删除行的整行摘要
  expect(bodyText()).toContain("CODE");
  expect(bodyText()).toContain("整行删除");
  // 生成的语句与绑定参数都要能看见（DataGrip 的 DML Preview 同款）
  expect(bodyText()).toContain("update bd_material set CODE = :1 where ID = :2 and CODE = :3");
  expect(bodyText()).toContain("delete from bd_material where ID = :1");
  expect(bodyText()).toContain('{"number":"1"}');

  await act(async () => { bodyButton("提交写回 2 条")!.click(); });
  expect(props.onSubmit).toHaveBeenCalledTimes(1);
});

it("逐项撤销与全部撤销各调各的", async () => {
  const { props } = render();
  await act(async () => { root.render(<DbWritebackDialog {...props} />); });
  await flush();

  await act(async () => { bodyButton("撤销此项")!.click(); });
  expect(props.onUndo).toHaveBeenCalledTimes(1);
  // 传入顺序即渲染顺序，第一条撤销对应第一条变更
  expect(vi.mocked(props.onUndo).mock.calls[0][0].sql).toBe(update.sql);

  await act(async () => { bodyButton("撤销全部改动")!.click(); });
  expect(props.onUndoAll).toHaveBeenCalledTimes(1);
});

it("关闭按钮走 onClose", async () => {
  const { props } = render();
  await act(async () => { root.render(<DbWritebackDialog {...props} />); });
  await flush();
  await act(async () => { bodyButton("关闭")!.click(); });
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("saving 时提交被按住，显示写回中", async () => {
  const { props } = render({ saving: true });
  await act(async () => { root.render(<DbWritebackDialog {...props} />); });
  await flush();
  const submit = bodyButton("写回中…")!;
  expect(submit.disabled).toBe(true);
  await act(async () => { submit.click(); });
  expect(props.onSubmit).not.toHaveBeenCalled();
});

it("空计划时没有摘要可看，提交也不给点", async () => {
  const { props } = render({ changes: [] });
  await act(async () => { root.render(<DbWritebackDialog {...props} />); });
  await flush();
  expect(bodyText()).toContain("预览待写回的更改");
  expect(bodyText()).not.toContain("update bd_material");
  expect(bodyButton("提交写回 0 条")!.disabled).toBe(true);
});
