import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChangelog, renderChangelog } from './changelog.mjs';

test('用户摘要、分类与技术记录分别保留，不将代码块或模板解析成版本', () => {
 const entries=parseChangelog(`\n\`\`\`markdown\n## [99.0.0] - 2026-01-01\n\`\`\`\n## [Unreleased]\n### 修复\n- 未发布项\n## [1.2.3] - 2026-11-05\n### 更新摘要\n本次更新 **改进编辑体验**。\n第二行摘要。\n### 新增\n- [搜索](https://example.com)支持\n  多行说明\n### 优化\n- 更快\n### 技术细节\n- 仅在技术区展示\n\`\`\`sh\n## [88.0.0] - 2026-01-01\nnpm run build\n\`\`\`\n`);
 assert.equal(entries.length,1);
 assert.equal(entries[0].version,'1.2.3');
 assert.deepEqual(entries[0].summary,['本次更新 改进编辑体验。 第二行摘要。']);
 assert.deepEqual(entries[0].items,[{category:'feat',text:'搜索支持 多行说明'},{category:'improve',text:'更快'}]);
 assert.equal(entries[0].technical[0].heading,'技术细节');
 assert.ok(entries[0].technical[0].text.includes('## [88.0.0]'));
 assert.ok(!entries[0].items.some(item=>item.text.includes('build')));
});
test('版本按语义倒序，保留旧版本和空版本；未发布分区不串到上一版本', () => {
 const entries=parseChangelog('## [0.1.9] - 2026-01-01\n### 修复\n- 修复 A\n## [Unreleased]\n### 新增\n- 不展示\n## [0.1.10] - 2026-02-01\n### 亮点\n- 亮点 B\n## [0.1.0] - 2025-12-01\n');
 assert.deepEqual(entries.map(e=>e.version),['0.1.10','0.1.9','0.1.0']);
 assert.deepEqual(entries[0].highlights,['亮点 B']);
 assert.deepEqual(entries[1].items,[{category:'fix',text:'修复 A'}]);
 assert.deepEqual(entries[2].items,[]);
});
test('生成内容可加载，原始文字安全保留，不生成执行语句', () => {
 const entries=parseChangelog('## [1.0.0] - 2026-11-05\n### 修复\n- `a < b` 和 "引号"\n');
 const output=renderChangelog(entries);
 assert.ok(output.includes('AUTO-GENERATED'));
 assert.ok(output.includes('"a < b"')===false);
 assert.ok(output.includes('`a < b`'));
});
