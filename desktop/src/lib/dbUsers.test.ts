import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke }));

import { detectScheme, enableStateText, resetSql, type NcUserRow } from "./dbUsers";

beforeEach(() => {
  mocks.invoke.mockReset();
});

const user = (scheme: NcUserRow["scheme"]): NcUserRow => ({
  cuserid: `id-${scheme}`,
  userCode: "u",
  userName: "n",
  enableState: "2",
  scheme,
});

describe("detectScheme", () => {
  it("按现有密文推断，两种都有时按多的走", () => {
    expect(detectScheme([user("ncc"), user("ncc"), user("nc65")])).toBe("ncc");
    expect(detectScheme([user("nc65"), user("nc65"), user("ncc")])).toBe("nc65");
    expect(detectScheme([user("nc65"), user("ncc")])).toBe("nc65");
    expect(detectScheme([user(null), user(null)])).toBeNull();
    expect(detectScheme([])).toBeNull();
  });
});

describe("enableStateText", () => {
  it("三种编码翻成中文，未知编码原样显示", () => {
    expect(enableStateText("2")).toBe("已启用");
    expect(enableStateText("1")).toBe("未启用");
    expect(enableStateText(" 3 ")).toBe("已停用");
    expect(enableStateText("9")).toBe("9");
    expect(enableStateText("")).toBe("—");
  });
});

describe("resetSql", () => {
  it("把方案、明文与选中的 cuserid 一起交给后端", async () => {
    mocks.invoke.mockResolvedValue({ sql: "x", count: 1 });
    await resetSql("nc65", "Temp#2026", [user("nc65")]);
    const [cmd, args] = mocks.invoke.mock.calls[0];
    expect(cmd).toBe("db_password_reset_sql");
    expect(args).toMatchObject({
      req: {
        scheme: "nc65",
        password: "Temp#2026",
        users: [{ cuserid: "id-nc65", userCode: "u" }],
      },
    });
    expect(typeof args.req.generatedAt).toBe("string");
    expect(args.req.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
