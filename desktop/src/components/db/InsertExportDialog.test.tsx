// @vitest-environment jsdom
/**
 * 导出 INSERT 脚本的接线。
 *
 * 盯三件「看着能用、其实没接上」的事：
 * ① 请求里 `multilang` 默认 true、`schema` 空串必须变成 null（否则后端会写出 `.表名`）；
 * ② 取消勾选多语后真的传 false（这条开关决定 `X2..X6` 导不导，传错就丢数据）；
 * ③ 导出成功后把「非全量 / 跳过的语种列」显示出来——静默截断等于骗人。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), toast: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke, listen: mocks.listen }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("../../lib/dbStore", () => ({ connOf: () => ({ id: "c1", name: "测试库", user: "NC65" }) }));

import { InsertExportDialog } from "./InsertExportDialog";
import { clearTransferJob } from "../../lib/resultTransferJobs";
import type { BoundCell } from "../../lib/dbApi";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RESULT = {
  fileName: "bd_material.insert.sql",
  sqlText: "-- x\ninsert into bd_material (PK_MATERIAL, NAME) values ('1', '~');\n",
  rows: 2,
  truncated: true,
  blobNulls: 0,
  mlTildes: 2,
  multilang: ["NAME（跳过 NAME2..NAME6）"],
  dropped: ["NAME2", "NAME3", "NAME4", "NAME5", "NAME6"],
  warnings: ["行数到了上限 2，脚本只是前 2 行"],
  ms: 1200,
};

let host: HTMLDivElement;
let root: Root;
const saved = {
  path: "D:/导出/bd_material.sql", fileName: "bd_material.sql", rows: 2, bytes: 120,
  truncated: true, canceled: false, ms: 50, warnings: RESULT.warnings, destinationToken: "saved",
};
const call = (command: string) => mocks.invoke.mock.calls.find(([cmd]) => cmd === command);

beforeEach(() => {
  clearTransferJob("c1:nc:c1");
  mocks.invoke.mockReset();
  mocks.listen.mockReset();
  mocks.toast.mockReset();
  mocks.listen.mockResolvedValue(() => {});
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "db_transfer_pick") return { token: "chosen", path: saved.path };
    if (cmd === "db_export_insert") return RESULT;
    if (cmd === "db_transfer_file") return saved;
    throw new Error(`Unexpected command: ${cmd}`);
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => {});

async function mount(over: Partial<{ schema: string | null; params: BoundCell[] }> = {}) {
  await act(async () => {
    root.render(
      <InsertExportDialog
        connId="c1"
        table="bd_material"
        sql="select * from bd_material"
        schema={over.schema ?? null}
        params={over.params}
        onClose={() => {}}
      />,
    );
  });
  await flush();
}

const byText = (sel: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text));

describe("InsertExportDialog", () => {
  it("默认按 NC 约定导出：多语开、schema 空串传 null、带上限与提交间隔", async () => {
    await mount({ schema: "" });
    await act(async () => byText("button", "导出")?.click());
    await flush();

    expect(mocks.invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["db_transfer_pick", "db_export_insert", "db_transfer_file"]);
    const [, args] = call("db_export_insert")!;
    expect(args.req).toMatchObject({
      id: "c1",
      sql: "select * from bd_material",
      table: "bd_material",
      schema: null,
      multilang: true,
      commitEvery: 0,
      maxRows: 5000,
    });
    expect(call("db_transfer_file")![1].req).toMatchObject({
      destinationToken: "chosen", text: RESULT.sqlText, textRows: 2,
      textTruncated: true, textWarnings: RESULT.warnings,
    });
    expect(mocks.listen).toHaveBeenCalledWith("db:export-progress", expect.any(Function));
  });

  it("取消多语勾选后传 false（决定 X2..X6 导不导）", async () => {
    await mount();
    const box = document.querySelector<HTMLInputElement>("#exp-ml");
    expect(box?.checked).toBe(true);
    await act(async () => box?.click());
    await act(async () => byText("button", "导出")?.click());
    await flush();

    expect(call("db_export_insert")![1].req.multilang).toBe(false);
  });

  it("成功后显示非全量与跳过的语种列，不静默截断", async () => {
    await mount();
    await act(async () => byText("button", "导出")?.click());
    await flush();

    // Modal 走 createPortal 挂到 body，不在 host 里
    const text = document.body.textContent ?? "";
    expect(text).toContain("bd_material.insert.sql");
    expect(text).toContain("2 行");
    expect(text).toContain("非全量");
    expect(text).toContain("NAME2");
    expect(text).toContain("行数到了上限");
    // 按钮切成「重新导出」，避免连点重复下载同一份
    expect(byText("button", "重新导出")).toBeTruthy();
  });

  it("全量 NC 导出保留查询绑定参数及大数精度", async () => {
    const params: BoundCell[] = [{ number: "12345678901234567890" }, "中文", null];
    await mount({ params });
    await act(async () => byText("button", "导出")?.click());
    expect(call("db_export_insert")![1].req.params).toEqual(params);
  });

  it("取消保存位置不会查询或宣称已导出", async () => {
    mocks.invoke.mockResolvedValue(null);
    await mount();
    await act(async () => byText("button", "导出")?.click());
    expect(mocks.invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["db_transfer_pick"]);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("脚本已生成");
    expect(byText("button", "导出")?.hasAttribute("disabled")).toBe(false);
  });

  it("原生保存失败显示错误并保留脚本，不宣称文件已保存", async () => {
    const normal = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd: string, args: unknown) => {
      if (cmd === "db_transfer_file") return Promise.reject(new Error("磁盘空间不足"));
      return normal(cmd, args);
    });
    await mount();
    await act(async () => byText("button", "导出")?.click());
    expect(document.body.textContent).toContain("磁盘空间不足");
    expect(document.body.textContent).toContain("脚本已生成");
    expect(document.body.textContent).not.toContain("文件已保存");
    expect(mocks.toast.mock.calls.some(([, kind]) => kind === "success")).toBe(false);
    expect(byText("button", "重新导出")).toBeTruthy();
  });
});
