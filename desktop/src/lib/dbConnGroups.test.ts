import { expect, it } from "vitest";
import { connColor, CONN_COLORS, groupConns, groupNames, normalizeGroupName } from "./dbConnGroups";
import type { DbConn } from "./dbApi";

const conn = (id: string, group = "", color = ""): DbConn => ({
  id,
  name: id,
  env: "test",
  source: "manual",
  url: `jdbc:oracle:thin:@h:1521/${id}`,
  user: "u",
  propDs: null,
  autoCommit: false,
  note: "",
  hasPassword: false,
  engine: "rust",
  group,
  color,
});

it("颜色只认白名单，脏值当不标记", () => {
  expect(connColor({ color: "red" })).toBe("red");
  expect(connColor({ color: " RED " })).toBe("red");
  // 手改配置把色值直接写成 hex 时不认——那个值会进 data-color，不能让它进渲染路径
  expect(connColor({ color: "#ff0000" })).toBeNull();
  expect(connColor({ color: "" })).toBeNull();
  expect(connColor({})).toBeNull();
  expect(CONN_COLORS).toHaveLength(7);
});

it("分组名去首尾与内部多余空白", () => {
  expect(normalizeGroupName("  客户 A   生产 ")).toBe("客户 A 生产");
  expect(normalizeGroupName(null)).toBe("");
});

it("分组按首次出现排序，未分组垫底", () => {
  const groups = groupConns([
    conn("a", "生产"),
    conn("b", ""),
    conn("c", "测试"),
    conn("d", "生产"),
  ]);
  expect(groups.map((g) => g.name)).toEqual(["生产", "测试", ""]);
  expect(groups[0].conns.map((c) => c.id)).toEqual(["a", "d"]);
  expect(groups[2].conns.map((c) => c.id)).toEqual(["b"]);
});

it("全部未分组时只有一组，且不带头", () => {
  const groups = groupConns([conn("a"), conn("b")]);
  expect(groups).toHaveLength(1);
  expect(groups[0].name).toBe("");
  expect(groups[0].conns).toHaveLength(2);
});

it("筛选后空组消失，不会留一排空组头", () => {
  const all = [conn("a", "生产"), conn("b", "测试"), conn("c", "生产")];
  const groups = groupConns(all, (c) => c.id === "c");
  expect(groups).toHaveLength(1);
  expect(groups[0].name).toBe("生产");
  expect(groups[0].conns.map((c) => c.id)).toEqual(["c"]);
});

it("已有分组名去重、跳过未分组", () => {
  expect(groupNames([conn("a", "生产"), conn("b", "生产"), conn("c", ""), conn("d", "测试")])).toEqual([
    "生产",
    "测试",
  ]);
});
