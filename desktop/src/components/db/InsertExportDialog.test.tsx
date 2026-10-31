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

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("../../lib/dbStore", () => ({ connOf: () => ({ id: "c1", name: "测试库", user: "NC65" }) }));

import { InsertExportDialog } from "./InsertExportDialog";

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

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.toast.mockReset();
  mocks.invoke.mockResolvedValue(RESULT);
  // 落盘走浏览器下载：jsdom 没有 createObjectURL / appendChild 点击
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => {});

async function mount(over: Partial<{ schema: string | null }> = {}) {
  await act(async () => {
    root.render(
      <InsertExportDialog
        connId="c1"
        table="bd_material"
        sql="select * from bd_material"
        schema={over.schema ?? null}
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
    await mount();
    await act(async () => byText("button", "导出")?.click());
    await flush();

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = mocks.invoke.mock.calls[0];
    expect(cmd).toBe("db_export_insert");
    expect(args.req).toMatchObject({
      id: "c1",
      sql: "select * from bd_material",
      table: "bd_material",
      schema: null,
      multilang: true,
      commitEvery: 0,
      maxRows: 5000,
    });
  });

  it("取消多语勾选后传 false（决定 X2..X6 导不导）", async () => {
    await mount();
    const box = document.querySelector<HTMLInputElement>("#exp-ml");
    expect(box?.checked).toBe(true);
    await act(async () => box?.click());
    await act(async () => byText("button", "导出")?.click());
    await flush();

    expect(mocks.invoke.mock.calls[0][1].req.multilang).toBe(false);
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
});
