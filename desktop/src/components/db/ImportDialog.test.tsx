// @vitest-environment jsdom
/**
 * CSV 批量导入的取消语义。
 *
 * 盯三件「点了却不知道发生了什么」的事：
 * ① 点「取消导入」必须**立刻**有反馈（按钮变「取消中…」并禁用）——大表上一批能跑
 *    几十秒，按钮不变用户会以为没点上、重复点；
 * ② 取消只在**批间**生效：正在飞的那批必须写完（请求已经发出去了，不知道结果就
 *    停就是丢数据），所以第一批 resolve 之后循环就该停，不再发第二批；
 * ③ 中途抛错也要把「已经写进去多少」报出来——已写的批不会因为异常消失，界面
 *    只剩一条错误的话，用户不知道到底落库了多少行。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { ImportDialog } from "./ImportDialog";
import type { ColumnInfo } from "../../lib/dbApi";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COLS: ColumnInfo[] = [
  { name: "ID", type: "VARCHAR2", size: 20, full: "VARCHAR2(20)", nullable: true, pk: true, default: null, comment: null, zh: null },
  { name: "NAME", type: "VARCHAR2", size: 50, full: "VARCHAR2(50)", nullable: true, pk: false, default: null, comment: null, zh: null },
];

/** 表头 + 450 行：每批 200 行，一共 3 批（200/200/50）。 */
const CSV = ["ID,NAME", ...Array.from({ length: 450 }, (_, i) => `${i},n${i}`)].join("\n");

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.invoke.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => {});

const btn = (text: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes(text));

async function mountWith(name: string, content: string) {
  await act(async () => {
    root.render(
      <ImportDialog connId="c1" table="bd_material" cols={COLS} onClose={() => {}} onDone={() => {}} />,
    );
  });
  await flush();
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => {
    // jsdom 的 input.files 只读，定义 setter 让 React 的 onChange 能读到文件
    Object.defineProperty(input, "files", { value: [new File([content], name)], configurable: true });
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

const mountWithCsv = () => mountWith("a.csv", CSV);

/** 手动控制 resolve 时机的 deferred：模拟「一批还在飞」。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ok = (inserted: number) => ({
  inserted,
  failed: [],
  truncated: false,
  committed: true,
  ms: 10,
});

describe("ImportDialog 取消语义", () => {
  it("点取消后按钮立刻变取消中，当前批写完即停、不再发下一批", async () => {
    const first = deferred<ReturnType<typeof ok>>();
    mocks.invoke.mockImplementationOnce(() => first.promise);

    await mountWithCsv();
    await act(async () => {
      btn("开始导入")?.click();
    });
    await flush();
    expect(document.body.textContent ?? "").toContain("正在写");
    const importCalls = mocks.invoke.mock.calls.filter((c) => c[0] === "db_import_rows").length;
    expect(importCalls).toBe(1); // 第一批在飞

    await act(async () => {
      btn("取消导入")?.click();
    });
    await flush();
    // ① 立刻有反馈：按钮变「取消中…」且禁用，提示换成「已请求取消」
    expect(btn("取消中…")).toBeTruthy();
    expect((btn("取消中…") as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent ?? "").toContain("已请求取消");

    // ② 第一批 resolve 后循环就该停：cancelRef 在批间被检查
    await act(async () => {
      first.resolve(ok(200));
    });
    await flush();
    expect(document.body.textContent ?? "").toContain("已取消");
    expect(document.body.textContent ?? "").toContain("200");
    expect(mocks.invoke.mock.calls.filter((c) => c[0] === "db_import_rows").length).toBe(1);
  });

  it("中途抛错也报出已写入的行数", async () => {
    const first = deferred<ReturnType<typeof ok>>();
    const second = deferred<ReturnType<typeof ok>>();
    mocks.invoke.mockImplementationOnce(() => first.promise);
    mocks.invoke.mockImplementationOnce(() => second.promise);

    await mountWithCsv();
    await act(async () => {
      btn("开始导入")?.click();
    });
    await flush();

    await act(async () => {
      first.resolve(ok(5)); // 第一批写进 5 行
    });
    await flush();
    await act(async () => {
      second.reject(new Error("ORA-00001: 唯一约束冲突"));
    });
    await flush();

    // ③ 已写的批不会因异常消失：摘要 + 错误都要在
    expect(document.body.textContent ?? "").toContain("5");
    expect(document.body.textContent ?? "").toContain("ORA-00001");
  });
});

describe("ImportDialog 选 XLSX", () => {
  it("字节作为裸载荷送给后端解压，读回的表头与行照常走映射与导入", async () => {
    mocks.invoke.mockImplementationOnce((cmd: string) => {
      expect(cmd).toBe("db_xlsx_read");
      return Promise.resolve({ sheet: "基础数据", rows: [["ID", "NAME"], ["1", "甲"], ["2", "乙"]] });
    });
    await mountWith("b.xlsx", "PK\u0003\u0004fake");
    await flush();

    // 裸载荷：第二个参数是字节本身，不是 { bytes: [...] }（后者会退化成 JSON 数字数组）
    const payload = mocks.invoke.mock.calls[0][1];
    expect(payload).toBeInstanceOf(Uint8Array);

    // 读的是哪张表必须看得见：多 sheet 的文件读错表不会报错，只会导错数据
    expect(document.body.textContent ?? "").toContain("基础数据");
    expect(document.body.textContent ?? "").toContain("2 列 · 2 行");

    await act(async () => {
      btn("开始导入")?.click();
    });
    await flush();
    const call = mocks.invoke.mock.calls.find((c) => c[0] === "db_import_rows");
    expect(call).toBeTruthy();
    const req = (call?.[1] as { req: { rows: (string | null)[][]; columns: { name: string }[] } }).req;
    expect(req.columns.map((c) => c.name)).toEqual(["ID", "NAME"]);
    expect(req.rows).toEqual([["1", "甲"], ["2", "乙"]]);
  });

  it("旧版 .xls 给「另存为」的明路，不是一句读不了", async () => {
    await mountWith("c.xls", "not a zip");
    await flush();
    expect(document.body.textContent ?? "").toContain("不支持旧版 .xls");
  });
});
