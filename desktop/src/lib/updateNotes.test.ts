import { describe, expect, it } from "vitest";
import { createUpdateNotesModel, parseUpdateNotes } from "./updateNotes";
// 跨侧契约锁：写入侧的标记常量直接 import，任一侧单独改动此测试即红。
import { readFileSync } from "node:fs";
import { buildUpdateNotes, HISTORY_MARKER } from "../../scripts/update-release-notes.mjs";

/** 复刻写入侧的最终产物形态：notes 正文 + 空行 + 转义后的元数据注释。 */
function withHistory(notes: string, entries: unknown[]): string {
  const metadata = JSON.stringify(entries).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `${notes}\n\n<!-- ${HISTORY_MARKER}${metadata} -->`;
}

describe("updateNotes 历史标记协议（跨前后端契约）", () => {
  it("剥掉写入侧产出的历史标记，元数据不作为段落泄漏进弹窗", () => {
    // 曾经前端匹配 cc-bridge- 前缀、写入侧无前缀 → 标记永不匹配：
    // 远端历史静默失效，且元数据 JSON 作为一个段落渲染出来。
    const body = withHistory("### 亮点\n- 更稳定", [
      { version: "99.0.0", date: "2026-10-27", body: "### 修复\n- 修了一个 bug" },
    ]);
    const parsed = parseUpdateNotes(body);
    expect(parsed.paragraphs.join("\n")).not.toContain(HISTORY_MARKER);
    expect(parsed.paragraphs.join("\n")).not.toContain("99.0.0");
    expect(parsed.highlights).toContain("更稳定");
  });

  it("远端历史标记可被解析，不再回落随包 CHANGELOG", () => {
    const body = withHistory("", [
      { version: "99.0.0", date: "2026-10-27", body: "### 修复\n- 远端条目" },
    ]);
    // bundled 传空数组：历史只能来自远端标记，兜底路径被排除在断言外
    const model = createUpdateNotesModel(
      { version: "99.0.0", currentVersion: "2.9.1", body },
      [],
    );
    expect(model.releases.map((r) => r.version)).toContain("99.0.0");
    expect(model.counts["修复"]).toBe(1);
  });

  it("兼容 cc-bridge- 历史遗留标记（旧发布说明仍可读）", () => {
    const body = `<!-- cc-bridge-release-history:${JSON.stringify([
      { version: "1.0.0", date: "2026-01-01", body: "### 修复\n- 旧标记条目" },
    ])} -->`;
    const model = createUpdateNotesModel(
      { version: "1.0.0", currentVersion: "0.9.0", body },
      [],
    );
    expect(model.releases.map((r) => r.version)).toContain("1.0.0");
    expect(model.counts["修复"]).toBe(1);
  });
});

describe("更新摘要 → 弹窗高亮卡片（CHANGELOG 约定）", () => {
  // 回归：摘要写成一句话（非列表）时曾被当成普通段落，顶部卡片区整块消失，弹窗只剩空白。
  it("单句更新摘要进 summary，并被模型当成亮点", () => {
    const body = "### 更新摘要\n标签栏各归其页，关于页一并改进\n\n### 修复\n- 修好了";
    const parsed = parseUpdateNotes(body);
    expect(parsed.summary).toEqual(["标签栏各归其页，关于页一并改进"]);
    expect(parsed.paragraphs).toEqual([]);
    const model = createUpdateNotesModel({ version: "1.2.3", body }, []);
    expect(model.highlights.map((item) => item.text)).toEqual(["标签栏各归其页，关于页一并改进"]);
  });

  it("显式「亮点」优先于摘要，摘要不会重复占卡", () => {
    const body = "### 更新摘要\n一句话摘要\n\n### 亮点\n- **更稳定**：可靠复制\n\n### 修复\n- 修好了";
    const model = createUpdateNotesModel({ version: "1.2.3", body }, []);
    expect(model.highlights.map((item) => item.text)).toEqual(["**更稳定**：可靠复制"]);
  });

  it("随包 CHANGELOG 的摘要不再被丢弃，离线也能出卡片", () => {
    const model = createUpdateNotesModel({ version: "9.9.9", body: "" }, [
      { version: "9.9.9", date: "2026-11-06", summary: ["随包摘要"], items: [{ category: "fix", text: "修好了" }] },
    ]);
    expect(model.latest.summary).toEqual(["随包摘要"]);
    expect(model.highlights.map((item) => item.text)).toEqual(["随包摘要"]);
  });
});

it("0.2.0 到 0.3.0 的完整记录与八个亮点不截断，不混入旧版本内容", () => {
  const model = createUpdateNotesModel({version:"0.3.0",currentVersion:"0.2.0",body:""});
  expect(model.highlights).toHaveLength(8);
  expect(model.total).toBeGreaterThan(20);
  expect(model.releases.map(release=>release.version)).toEqual(["0.3.0"]);
});
it("远端简短摘要不会覆盖同版本元数据的分类详情和亮点", () => {
  const body = withHistory("### 更新摘要\n简短导读", [{version:"1.2.0",body:"### 亮点\n- 功能亮点\n### 新增\n- 完整的新功能记录"}]);
  const model = createUpdateNotesModel({version:"1.2.0",currentVersion:"1.1.0",body}, []);
  expect(model.total).toBe(1);
  expect(model.highlights[0].text).toBe("功能亮点");
  expect(model.latest.groups[0].items).toEqual(["完整的新功能记录"]);
});

it("真实发布清单的短摘要与内嵌历史保留完整0.3.0内容", () => {
  const source = readFileSync(new URL("../../../CHANGELOG.md", import.meta.url), "utf8");
  const published = buildUpdateNotes("### 更新摘要\n更新导读", "0.3.0", source);
  const model = createUpdateNotesModel({version:"0.3.0",currentVersion:"0.2.0",body:published}, []);
  expect(model.highlights).toHaveLength(8);
  expect(model.total).toBeGreaterThan(20);
  expect(model.releases.map(release=>release.version)).toEqual(["0.3.0"]);
});

it("技术小节及嵌套标题均不泄漏到用户说明，后续公开小节正常保留", () => {
  const notes = parseUpdateNotes("### 亮点\n- 更顺手\n### 技术细节\nprivate-a\n#### 原始说明\n- private-b\n### 修复\n- 公开修复");
  expect(JSON.stringify(notes)).not.toContain("private-");
  expect(notes.groups[0].items).toEqual(["公开修复"]);
});
