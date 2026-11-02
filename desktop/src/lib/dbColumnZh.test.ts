import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./dbApi", () => ({
  dbApi: { columnNamesZh: vi.fn() },
}));

import { dbApi } from "./dbApi";
import { columnZhOf, forgetColumnZh, mergeZh } from "./dbColumnZh";

/**
 * SQL 结果表头的中文名。
 *
 * 这里盯的是两件会「安静出错」的事：
 * ① 同名列不能张冠李戴（join 进来的字典表也有 `code`，必须取主表那个）；
 * ② 查不到就得给 `undefined`，让表头退回显示类型 —— 硬凑一个名字比不显示更糟。
 */

const call = dbApi.columnNamesZh as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  call.mockReset();
  forgetColumnZh("c1");
  forgetColumnZh("c2");
});

describe("mergeZh", () => {
  it("同名列取先出现的表（主表在前）", () => {
    const flat = {
      "bd_material|code": "物料编码",
      "bd_marbasclass|code": "物料基本分类编码",
      "bd_marbasclass|name": "分类名称",
    };
    expect(mergeZh(flat, ["bd_material", "bd_marbasclass"], ["code", "name"])).toEqual({
      code: "物料编码",
      name: "分类名称",
    });
  });

  it("只收命中中文名的列，其余不出现", () => {
    expect(mergeZh({ "t|a": "甲" }, ["t"], ["a", "b", "dual_dummy"])).toEqual({ a: "甲" });
  });

  it("一列都没命中返回 undefined（表头退回显示类型）", () => {
    expect(mergeZh({}, ["t"], ["a"])).toBeUndefined();
    expect(mergeZh({ "t|a": "" }, ["t"], ["a"])).toBeUndefined();
  });

  it("列名按小写对齐（Oracle 结果列名可能大写）", () => {
    expect(mergeZh({ "t|matname": "物料名称" }, ["t"], ["matname"])).toEqual({ matname: "物料名称" });
  });
});

describe("columnZhOf 缓存", () => {
  it("同一条连接 + 同一批表只问一次", async () => {
    call.mockResolvedValue({ names: { "t|a": "甲" } });
    await columnZhOf("c1", ["t"]);
    await columnZhOf("c1", ["t"]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("断开 / 刷新对象后重新问", async () => {
    call.mockResolvedValue({ names: {} });
    await columnZhOf("c1", ["t"]);
    forgetColumnZh("c1");
    await columnZhOf("c1", ["t"]);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("换了连接不会被上一条的缓存串到", async () => {
    call.mockResolvedValue({ names: {} });
    await columnZhOf("c1", ["t"]);
    await columnZhOf("c2", ["t"]);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("失败不缓存：下次还有机会拿到中文名", async () => {
    call.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ names: { "t|a": "甲" } });
    await expect(columnZhOf("c1", ["t"])).rejects.toThrow("boom");
    await expect(columnZhOf("c1", ["t"])).resolves.toEqual({ "t|a": "甲" });
    expect(call).toHaveBeenCalledTimes(2);
  });
});
