// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaDdlRun, splitStatements } from "./MetaDdlRun";

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

const conn = (id: string, name: string, env: string) => ({
  id,
  name,
  env,
  source: "manual",
  url: "",
  user: "",
  propDs: null,
  autoCommit: true,
  note: "",
  hasPassword: false,
  engine: "java",
});

const okUpdate = { kind: "update", updateCount: -1, ms: 3, output: [], tx: {} };

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text))!;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const DDL = `-- demo\nCREATE TABLE t1 (id char(20));\nCREATE TABLE t2 (id char(20));`;

it("按分号切语句，注释与字符串里的分号不切", () => {
  expect(splitStatements(DDL)).toEqual([
    "CREATE TABLE t1 (id char(20))",
    "CREATE TABLE t2 (id char(20))",
  ]);
  expect(splitStatements("select ';' from dual; -- x;y\nselect 2 from dual")).toEqual([
    "select ';' from dual",
    "select 2 from dual",
  ]);
});
it("含 PL/SQL 块的脚本在确认测试连接后仍禁止逐语句执行", async () => {
  mocks.invoke.mockImplementation((cmd: string) => cmd === "db_conn_list" ? Promise.resolve([conn("c1", "测试库", "test")]) : Promise.resolve(okUpdate));
  await act(async () => root.render(<MetaDdlRun ddl="begin null; end;" component="demo" />));
  await act(async () => setValue(host.querySelector<HTMLSelectElement>("select")!, "c1"));
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => setValue(host.querySelector<HTMLInputElement>('[aria-label="输入组件名确认 DDL 执行"]')!, "demo"));
  expect(button("执行 DDL").disabled).toBe(true);
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "db_exec")).toHaveLength(0);
});
it("执行组件真正卸载后，不再继续提交后续 DDL", async () => {
  let finish!: (value: typeof okUpdate) => void;
  const pending = new Promise<typeof okUpdate>((resolve) => { finish = resolve; });
  mocks.invoke.mockImplementation((cmd: string) => cmd === "db_conn_list" ? Promise.resolve([conn("c1", "测试库", "test")]) : pending);
  await act(async () => root.render(<MetaDdlRun ddl={DDL} component="demo" />));
  await act(async () => setValue(host.querySelector<HTMLSelectElement>("select")!, "c1"));
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => setValue(host.querySelector<HTMLInputElement>('[aria-label="输入组件名确认 DDL 执行"]')!, "demo"));
  await act(async () => button("执行 DDL").click());
  act(() => root.render(null));
  await act(async () => finish(okUpdate));
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "db_exec")).toHaveLength(1);
});

it("生产连接拒绝执行；测试连接需勾选并手打组件名，逐条执行且失败即停", async () => {
  let failSecond = false;
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "db_conn_list") {
      return Promise.resolve([conn("c1", "测试库", "test"), conn("p1", "生产库", "prod")]);
    }
    if (cmd === "db_exec") {
      const calls = mocks.invoke.mock.calls;
      const sql = (calls[calls.length - 1][1] as { sql: string }).sql;
      if (failSecond && sql.includes("t2")) return Promise.reject(new Error("ORA-00955 名称已被使用"));
      return Promise.resolve(okUpdate);
    }
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });

  await act(async () => root.render(<MetaDdlRun ddl={DDL} component="demo" />));
  await flush();
  expect(host.textContent).toContain("共 2 条语句");

  const select = host.querySelector<HTMLSelectElement>(".meta-ddl-conn")!;
  await act(async () => setValue(select, "p1"));
  expect(host.textContent).toContain("生产连接不允许执行 DDL");
  expect(button("执行 DDL").disabled).toBe(true);

  await act(async () => setValue(select, "c1"));
  const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const nameInput = host.querySelector<HTMLInputElement>('[aria-label="输入组件名确认 DDL 执行"]')!;
  expect(button("执行 DDL").disabled).toBe(true);

  await act(async () => {
    box.click();
  });
  await act(async () => setValue(nameInput, "demo"));
  expect(button("执行 DDL").disabled).toBe(false);

  await act(async () => button("执行 DDL").click());
  await flush();
  const calls = mocks.invoke.mock.calls.filter((c) => c[0] === "db_exec");
  expect(calls).toHaveLength(2);
  expect(calls[0][1]).toMatchObject({ id: "c1", sql: "CREATE TABLE t1 (id char(20))" });
  expect(host.textContent).toContain("全部语句执行成功");

  failSecond = true;
  await act(async () => button("执行 DDL").click());
  await flush();
  expect(host.textContent).toContain("ORA-00955 名称已被使用");
  expect(host.textContent).not.toContain("全部语句执行成功");
});
