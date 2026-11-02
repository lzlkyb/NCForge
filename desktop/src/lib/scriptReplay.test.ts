import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tauri", () => ({ invoke: vi.fn() }));
// 只测纯函数：把执行链上的模块挡掉，否则 dbActions → dbStore 会拖进 monaco（node 环境没有 window）
vi.mock("./dbActions", () => ({ runStatements: vi.fn() }));
vi.mock("./dbApi", () => ({ dbApi: { cancel: vi.fn() } }));

import { decodeScript, failuresToSql } from "./scriptReplay";
import type { ScriptFailure } from "./dbActions";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("decodeScript", () => {
  it("UTF-8 文件按 UTF-8 解，BOM 去掉", () => {
    const bytes = new TextEncoder().encode("\uFEFFselect 1 from dual;");
    const { text, encoding } = decodeScript(bytes);
    expect(encoding).toBe("UTF-8");
    expect(text).toBe("select 1 from dual;");
  });

  it("UTF-8 里也是合法 GBK 的中文仍按 UTF-8 解——顺序反了就是一屏乱码", () => {
    // 「中文」的 UTF-8 字节同时是合法的 GBK 字节序列（只是解出来变成别的字）
    const bytes = new TextEncoder().encode("select '中文' from dual;");
    const { text, encoding } = decodeScript(bytes);
    expect(encoding).toBe("UTF-8");
    expect(text).toContain("中文");
  });

  it("不是合法 UTF-8 的字节退回 GBK", () => {
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    const { text, encoding } = decodeScript(bytes);
    expect(encoding).toBe("GBK");
    expect(text).toBe("中文");
  });

  it("GBK 文件里的中文注释能读出来（现场脚本常见）", () => {
    const bytes = new Uint8Array([0x2d, 0x2d, 0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0x2f]);
    const { text, encoding } = decodeScript(bytes);
    expect(encoding).toBe("GBK");
    expect(text).toBe("--中文\n/");
  });
});

describe("failuresToSql", () => {
  const failures: ScriptFailure[] = [
    { index: 2, line: 3, text: "insert into bd_material (id) values (1)", error: "ORA-00942: table or view does not exist\n  第 1 行" },
    { index: 5, line: 12, text: "update bd_material set name = 'x' where id = 1", error: "ORA-00001: unique constraint violated" },
  ];

  it("错误原因折成一行注释，语句补回分号可再执行", () => {
    const sql = failuresToSql(failures, "mig.sql");
    expect(sql.split("\n")[0]).toBe("-- mig.sql：执行失败的语句（2 条）");
    expect(sql).toContain("-- 第 2 条（第 3 行）：ORA-00942: table or view does not exist 第 1 行");
    expect(sql).toContain("insert into bd_material (id) values (1);");
    expect(sql).toContain("-- 第 5 条（第 12 行）：ORA-00001: unique constraint violated");
    expect(sql).toContain("update bd_material set name = 'x' where id = 1;");
  });

  it("每条失败之间空一行，结尾有换行", () => {
    const sql = failuresToSql(failures, "mig.sql");
    expect(sql).toContain("\n\n-- 第 5 条");
    expect(sql.endsWith("\n")).toBe(true);
  });
});
