import { expect, it } from "vitest";
import { sqlAssistSort, sqlMatchQuality, sqlSnippetText } from "./sqlAssistRanking";
it("exact and prefix intent precede Chinese and fuzzy matches", () => {
  expect(sqlMatchQuality("bd_proj", "bd_project")).toBe(1);
  expect(sqlMatchQuality("bd_proj", "bd_material", "物料")).toBe(9);
  expect(sqlMatchQuality("物料", "bd_material", "物料")).toBe(2);
  expect(sqlAssistSort(0, 5, "b") < sqlAssistSort(1, 0, "a")).toBe(true);
});
it("pinyin initials match Chinese names without displacing exact or prefix intent", () => {
  expect(sqlMatchQuality("cgdd", "po_order", "采购订单")).toBe(3);
  expect(sqlMatchQuality("cg", "po_order", "采购订单")).toBe(3);
  expect(sqlMatchQuality("ryjb", "bd_psndoc", "人员基本档案")).toBe(3);
  expect(sqlMatchQuality("po_order", "po_order", "采购订单")).toBe(0);
  expect(sqlMatchQuality("po_", "po_order", "采购订单")).toBe(1);
  expect(sqlMatchQuality("采购", "po_order", "采购订单")).toBe(2);
  expect(sqlMatchQuality("xyz", "po_order", "采购订单")).toBe(9);
  expect(sqlMatchQuality("cgdd", "po_order")).toBe(9);
});
it("fuzzy tiers stay ordered below pinyin and above no-match", () => {
  expect(sqlMatchQuality("订单", "po_order", "采购订单")).toBe(4);
  expect(sqlMatchQuality("order", "po_order")).toBe(5);
  expect(sqlMatchQuality("pord", "po_order")).toBe(6);
  expect(sqlMatchQuality("zzz", "po_order")).toBe(9);
});
it("preserves SQL literals while making explicit saved parameters navigable", () => {
  expect(sqlSnippetText("select '$1', x from a where id={{id}} and code={{code}}" )).toBe("select '\\$1', x from a where id=${1:id} and code=${2:code}");
});
