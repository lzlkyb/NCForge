// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { collectSettings, revealSetting, searchSettings } from "./settingsSearch";

afterEach(() => { document.body.innerHTML = ""; });
function fixture() {
  document.body.innerHTML = '<section data-settings-section="编辑器" data-settings-group="工作台"><details id="new-task" data-settings-item data-settings-label="新建任务" tabindex="-1"><summary>新建任务</summary><div id="size" tabindex="-1" data-settings-item data-setting-value="13px"><span class="t">字号</span><div class="d">代码字体大小</div></div></details></section>';
  return document.body;
}
describe("设置索引", () => {
  it("读取真实设置名称与当前值，不混入操作按钮文案", () => {
    const items = collectSettings(fixture());
    const hits = searchSettings(items, "编辑器 字号");
    expect(hits.map(h => [h.id, h.value])).toEqual([["size", "13px"]]);
  });
  it("更新设置后索引反映真实值", () => {
    const root = fixture();
    document.getElementById("size")!.dataset.settingValue = "16px";
    expect(searchSettings(collectSettings(root), "字号")[0].value).toBe("16px");
  });
  it("目标本身是折叠组时也可展开，且不修改其他组", () => {
    const root = fixture();
    expect(revealSetting(root, "new-task")).toBe(document.getElementById("new-task"));
    expect((document.getElementById("new-task") as HTMLDetailsElement).open).toBe(true);
    expect(revealSetting(root, "missing")).toBeNull();
  });
});
