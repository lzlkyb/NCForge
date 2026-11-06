import { expect, it } from "vitest";
import { newGenerationPreferences } from "./bmfGeneration";
import { filteredGeneration, generationCounts, generationSource, reconcileGeneration } from "./metaGeneration";
import { generationFixture } from "../test/generationWorkbenchFixture";
import { metaGenerationPlan } from "../test/metaGenerationFixture";
import { metaDetail } from "../test/metaFixtures";

it("全选不会强制覆盖手改文件，实际写入数取决于逐文件决策", () => {
  const preview = generationFixture("root", metaGenerationPlan, { vo: "modified" });
  const statuses = Object.fromEntries(preview.check.items.map((s) => [s.id, s]));
  expect(generationCounts(preview.plan, statuses, ["vo"], [])).toMatchObject({ selected: 1, update: 0, keep: 1 });
  expect(generationCounts(preview.plan, statuses, ["vo"], ["vo"])).toMatchObject({ update: 1, keep: 0 });
  expect(generationCounts(preview.plan, statuses, [], ["vo"])).toMatchObject({ selected: 0, update: 0 });
});
it("重新生成保留已有勾选和活动文件，新出现产物遵循默认，注册建议保持可选", () => {
  const prefs = { ...newGenerationPreferences("demo.bmf"), selected: [], activeId: "vo" };
  const next = { ...metaGenerationPlan, artifacts: [...metaGenerationPlan.artifacts,
    { ...metaGenerationPlan.artifacts[0], id: "new" }, { ...metaGenerationPlan.artifacts[0], id: "registry", kind: "registry" }] };
  expect(reconcileGeneration(next, prefs, metaGenerationPlan)).toMatchObject({ selected: ["new"], activeId: "vo" });
  expect(reconcileGeneration(metaGenerationPlan, prefs)).toMatchObject({ selected: [] });
});
it("搜索和状态筛选只控制可见项，不修改写入选择", () => {
  const fixture = generationFixture("root", metaGenerationPlan, { vo: "modified" });
  const statuses = Object.fromEntries(fixture.check.items.map((s) => [s.id, s]));
  expect(filteredGeneration(fixture.plan.artifacts, statuses, "java/", "protected")).toHaveLength(1);
  expect(filteredGeneration(fixture.plan.artifacts, statuses, "", "pending")).toHaveLength(0);
});
it("产物来源支持实体与属性联动定位，不对未知 ID 伪造定位按钮", () => {
  const detail = metaDetail();
  expect(generationSource(detail, "head")?.selection).toEqual({ kind: "entity", entityId: "head" });
  expect(generationSource(detail, "amount")?.selection).toEqual({ kind: "attr", entityId: "head", attrId: "amount" });
  expect(generationSource(detail, "missing")).toBeNull();
});
