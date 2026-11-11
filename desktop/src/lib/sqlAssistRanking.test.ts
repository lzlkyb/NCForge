import { expect, it } from "vitest";
import { sqlAssistSort, sqlMatchQuality, sqlSnippetText } from "./sqlAssistRanking";
it("exact and prefix intent precede Chinese and fuzzy matches", () => {
  expect(sqlMatchQuality("bd_proj", "bd_project")).toBe(1);
  expect(sqlMatchQuality("bd_proj", "bd_material", "物料")).toBe(9);
  expect(sqlMatchQuality("物料", "bd_material", "物料")).toBe(2);
  expect(sqlAssistSort(0, 5, "b") < sqlAssistSort(1, 0, "a")).toBe(true);
});
it("preserves SQL literals while making explicit saved parameters navigable", () => {
  expect(sqlSnippetText("select '$1', x from a where id={{id}} and code={{code}}" )).toBe("select '\\$1', x from a where id=${1:id} and code=${2:code}");
});
