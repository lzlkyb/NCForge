// @vitest-environment jsdom
/**
 * 重置操作员密码的接线：列账号 → 选人 → 输入新密码 → 生成 SQL（不执行）。
 *
 * 盯住的都是「看着能用、其实接错」的点：
 * ① 方案默认值要按**库里现有密文**推断（NC65 / NCC 混用时选错就是一屏登录失败）；
 * ② 生成请求必须带上选中用户的 cuserid 与用户手选的方案；
 * ③ 结果只给复制 / 保存，界面上没有任何执行入口。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  downloadText: vi.fn(),
  copyText: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/resultExport", () => ({ downloadText: mocks.downloadText }));
vi.mock("../../lib/utils", () => ({
  copyText: mocks.copyText,
  isImeComposing: () => false,
}));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../../lib/dbStore", () => ({
  connOf: () => ({ id: "c1", name: "测试库", user: "NC65", env: "test" }),
}));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));

import { PasswordResetDialog } from "./PasswordResetDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SQL =
  "-- NC65 操作员密码重置（1 个用户）\nupdate sm_user set user_password = 'U_U++--Vab' where cuserid = '1001A';\n\ncommit;\n";

const USERS_NC65 = {
  users: [
    { cuserid: "1001A", userCode: "admin", userName: "管理员", enableState: "2", scheme: "nc65" },
    { cuserid: "1001B", userCode: "ls", userName: "李四", enableState: "3", scheme: "nc65" },
  ],
  truncated: false,
  sharedSession: false,
};

const USERS_NCC = {
  users: [{ cuserid: "1001N31", userCode: "cloud", userName: "云用户", enableState: "2", scheme: "ncc" }],
  truncated: false,
  sharedSession: false,
};

let host: HTMLDivElement;
let root: Root;
let users = USERS_NC65;

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  users = USERS_NC65;
  mocks.invoke.mockImplementation(async (cmd: string, args: { req?: { users: unknown[] } }) => {
    if (cmd === "db_user_list") return users;
    if (cmd === "db_password_reset_sql") return { sql: SQL, count: args.req?.users.length ?? 0 };
    throw new Error(`unexpected command ${cmd}`);
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const flush = () => act(async () => {});

const byText = (sel: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text));

async function mount() {
  await act(async () => {
    root.render(<PasswordResetDialog connId="c1" onClose={() => {}} />);
  });
  await flush();
}

/** React 受控 input：走原型上的原生 setter，再派发 input 事件。 */
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const boxes = () => [...document.querySelectorAll<HTMLInputElement>(".dbx-pr-table input[type=checkbox]")];
const pwd = () => document.querySelector<HTMLInputElement>("#pr-pwd")!;
const genBtn = () => byText("button", "生成 SQL") as HTMLButtonElement;

describe("PasswordResetDialog", () => {
  it("列出账号（只读命令），选人 + 输密码后把 cuserid 与方案交给后端", async () => {
    await mount();
    expect(mocks.invoke).toHaveBeenCalledWith("db_user_list", { id: "c1", filter: null });
    const text = document.body.textContent ?? "";
    expect(text).toContain("admin");
    expect(text).toContain("管理员");
    expect(text).toContain("已停用");

    expect(genBtn().disabled).toBe(true);
    await act(async () => boxes()[0].click());
    await act(async () => type(pwd(), "Temp#2026"));
    expect(genBtn().disabled).toBe(false);

    await act(async () => genBtn().click());
    await flush();

    const call = mocks.invoke.mock.calls.find(([cmd]) => cmd === "db_password_reset_sql");
    expect(call).toBeTruthy();
    expect(call![1].req).toMatchObject({
      scheme: "nc65",
      password: "Temp#2026",
      users: [{ cuserid: "1001A", userCode: "admin" }],
    });
    expect(document.body.textContent).toContain("1 条 update");
    expect(document.body.textContent).toContain("update sm_user");
    // 只给复制 / 保存，没有执行入口
    expect(byText("button", "复制 SQL")).toBeTruthy();
    expect(byText("button", "保存 .sql")).toBeTruthy();
    expect(byText("button", "执行")).toBeUndefined();
  });

  it("NCC 账套按现有密文默认选 NCC，手选 NC65 时按 NC65 发", async () => {
    users = USERS_NCC;
    await mount();
    const sel = document.querySelector<HTMLSelectElement>('select[aria-label="密码方案"]')!;
    expect(sel.value).toBe("ncc");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, "nc65");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => boxes()[0].click());
    await act(async () => type(pwd(), "abc12345"));
    await act(async () => genBtn().click());
    await flush();

    const call = mocks.invoke.mock.calls.find(([cmd]) => cmd === "db_password_reset_sql");
    expect(call![1].req.scheme).toBe("nc65");
  });

  it("复制与保存拿到的是同一份脚本", async () => {
    await mount();
    await act(async () => boxes()[0].click());
    await act(async () => type(pwd(), "Temp#2026"));
    await act(async () => genBtn().click());
    await flush();

    await act(async () => byText("button", "复制 SQL")?.click());
    expect(mocks.copyText).toHaveBeenCalledWith(SQL, expect.any(Function), expect.any(Function));

    await act(async () => byText("button", "保存 .sql")?.click());
    expect(mocks.downloadText).toHaveBeenCalledWith("测试库-密码重置.sql", SQL, "text/plain", false);
  });

  it("生成后改密码或切方案，旧脚本立刻撤掉（不让人复制到一份哈希不对的）", async () => {
    await mount();
    await act(async () => boxes()[0].click());
    await act(async () => type(pwd(), "Temp#2026"));
    await act(async () => genBtn().click());
    await flush();
    expect(byText("button", "复制 SQL")).toBeTruthy();

    await act(async () => type(pwd(), "Temp#2027"));
    expect(byText("button", "复制 SQL")).toBeUndefined();

    // 重新生成后再切方案，同样要撤
    await act(async () => genBtn().click());
    await flush();
    expect(byText("button", "复制 SQL")).toBeTruthy();
    const sel = document.querySelector<HTMLSelectElement>('select[aria-label="密码方案"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, "ncc");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(byText("button", "复制 SQL")).toBeUndefined();
  });

  it("筛选回车重新查账号（带 filter），卸载后迟到的结果不写回", async () => {
    await mount();
    const filter = document.querySelector<HTMLInputElement>('input[aria-label="筛选账号"]')!;
    await act(async () => type(filter, "admin"));
    await act(async () => {
      filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("db_user_list", { id: "c1", filter: "admin" });
  });
});
