// @vitest-environment jsdom
import { expect, it } from "vitest";
import { rankDbObjects, rememberDbObject } from "./dbObjectRanking";
import { toggleFavorite } from "./dbFavorites";
import { connectionKey } from "./dbResultContext";
import { recordSqlUsage, sqlUsageKey, sqlUsageScope } from "./sqlUsage";
import type { DbConn } from "./dbApi";

it("对象查找共享 SQL 学习，同等匹配优先收藏和历史，精确匹配与各 Schema 隔离", () => {
  const conn = { id: "ranking-c", url: "jdbc:oracle:thin:@fixture", user: "NC" } as DbConn;
  const names = [{ name: "PO_ORDER", kind: "TABLE" }, { name: "PO_ORDER_B", kind: "TABLE" }, { name: "PO_ORDER_Z", kind: "TABLE" }];
  const rank = (prefix: string, schema = "NC") => rankDbObjects(names, prefix, {}, conn, schema).map(object => object.name);
  expect(rank("po_")[0]).toBe("PO_ORDER");
  recordSqlUsage(sqlUsageScope(connectionKey(conn), "NC"), sqlUsageKey("po_order_b"), "execute");
  expect(rank("po_")[0]).toBe("PO_ORDER_B");
  expect(rank("po_order")[0]).toBe("PO_ORDER");
  expect(rank("po_", "OTHER")[0]).toBe("PO_ORDER");
  toggleFavorite(conn.id, "table", "po_order_z");
  try { expect(rank("po_")[0]).toBe("PO_ORDER_Z"); } finally { toggleFavorite(conn.id, "table", "po_order_z"); }
  rememberDbObject(conn, "NC", names[2]);
  expect(rank("po_").indexOf("PO_ORDER_Z")).toBeLessThan(rank("po_").indexOf("PO_ORDER"));
});
