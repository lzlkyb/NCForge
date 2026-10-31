/**
 * `db_meta` 的参数形状。
 *
 * 为什么值得单独测：这条命令的 `arg` / `arg2` 一旦传错位，**后端不会报错**——
 * `get_ddl('PACKAGE', 'PKG_X')` 只会查不到东西，界面上表现成「源码/DDL 空白」，
 * 看起来像「这个包没源码」。这类错位只有断言参数才拦得住。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke }));

import { dbApi } from "./dbApi";

describe("db_meta 参数形状", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({});
  });

  it("对象 DDL：名字在 arg，类型在 arg2", async () => {
    await dbApi.objectDdl("c1", "pkg_sale", "PACKAGE");
    expect(mocks.invoke).toHaveBeenCalledWith("db_meta", {
      id: "c1",
      kind: "ddl",
      arg: "pkg_sale",
      arg2: "PACKAGE",
    });
  });

  it("表 DDL 不带 arg2（后端见 arg2 无 arg 会拒，见下一条）", async () => {
    await dbApi.ddl("c1", "bd_material");
    expect(mocks.invoke).toHaveBeenCalledWith("db_meta", {
      id: "c1",
      kind: "ddl",
      arg: "bd_material",
    });
  });

  it("源码只传对象名", async () => {
    await dbApi.source("c1", "pkg_sale");
    expect(mocks.invoke).toHaveBeenCalledWith("db_meta", {
      id: "c1",
      kind: "source",
      arg: "pkg_sale",
    });
  });

  it("对象清单不带参数", async () => {
    await dbApi.objects("c1");
    expect(mocks.invoke).toHaveBeenCalledWith("db_meta", { id: "c1", kind: "objects" });
  });
});
