import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSingleSource, CORE_TOKENS, definitions, baseBlockLines, regionLines } from "./token-geometry.mjs";

const INDEX = "src/index.css";
const base = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: 6px;`).join("\n")}\n}`;

function indexCss(after = "", baseBody = base) {
  return [
    ":root {",
    "  --dur: 160ms;",
    "}",
    "",
    "/* @tokens-geometry:start */",
    baseBody,
    "",
    "html[data-ui-style] {",
    "  --r-control: 8px;",
    "  --r-shell: 16px;",
    "}",
    "/* @tokens-geometry:end */",
    after,
    "",
  ].join("\n");
}

test("区间内定义核心令牌 + 外观档独占圆角，无违规", () => {
  const { violations, missingCore } = checkSingleSource([{ path: INDEX, text: indexCss() }], INDEX);
  assert.deepEqual(violations, []);
  assert.deepEqual(missingCore, []);
});

test("其它 CSS 文件重复定义几何令牌 → 违规", () => {
  const { violations } = checkSingleSource(
    [
      { path: INDEX, text: indexCss() },
      { path: "src/forge-controls.css", text: ".forge-controls {\n  --r-control: 8px;\n}" },
    ],
    INDEX,
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].token, "--r-control");
  assert.equal(violations[0].path, "src/forge-controls.css");
});

test("index.css 区间外定义几何令牌 → 违规", () => {
  const { violations } = checkSingleSource(
    [{ path: INDEX, text: indexCss(":root {\n  --h-control: 30px;\n}") }],
    INDEX,
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].token, "--h-control");
  assert.match(violations[0].reason, /@tokens-geometry/);
});

test("基础档缺默认值 → missingCore 报出该令牌", () => {
  const without = CORE_TOKENS.filter((t) => t !== "--gap-control");
  const body = `:root {\n${without.map((t) => `  ${t}: 6px;`).join("\n")}\n}`;
  const { missingCore } = checkSingleSource([{ path: INDEX, text: indexCss("", body) }], INDEX);
  assert.deepEqual(missingCore, ["--gap-control"]);
});

test("注释里的令牌名不算定义", () => {
  const text = indexCss("", `${base}\n/* --r-control: 99px; 历史值 */`);
  const defs = definitions(text, INDEX, INDEX).filter((d) => d.token === "--r-control");
  assert.equal(defs.filter((d) => d.value === "6px").length, 1);
  assert.equal(defs.filter((d) => d.value === "99px").length, 0);
});

test("区间标记被正确定位，且基础档块落在区间内", () => {
  const text = indexCss();
  const region = regionLines(text);
  assert.ok(region.start > 0 && region.end > region.start);
  const block = baseBlockLines(text, region);
  assert.ok(block);
  assert.ok(block.start > region.start && block.end < region.end);
});
