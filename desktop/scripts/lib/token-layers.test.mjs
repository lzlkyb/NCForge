import { test } from "node:test";
import assert from "node:assert/strict";
import { checkThemePairs, isReference, isSemantic, topLevelBlocks } from "./token-layers.mjs";

const css = (light, dark) => `:root {\n${light}\n}\n.dark {\n${dark}\n}\n`;

test("明暗成对定义 → 无缺失", () => {
  const r = checkThemePairs(css("  --background: 0 0% 100%;", "  --background: 0 0% 10%;"));
  assert.deepEqual(r, { missingInDark: [], missingInLight: [] });
});

test("只在浅色写字面色 → missingInDark", () => {
  const r = checkThemePairs(
    css("  --brand: 200 50% 40%;\n  --background: 0 0% 100%;", "  --background: 0 0% 10%;"),
  );
  assert.deepEqual(r.missingInDark.map((x) => x.token), ["--brand"]);
  assert.deepEqual(r.missingInLight, []);
});

test("只在深色写字面色 → missingInLight", () => {
  const r = checkThemePairs(css("  --background: 0 0% 100%;", "  --brand-strong: 0 0% 0%;"));
  assert.deepEqual(r.missingInLight.map((x) => x.token), ["--brand-strong"]);
});

test("var 引用型令牌自动跟随主题，不要求成对（--ring: var(--primary)）", () => {
  const r = checkThemePairs(css("  --ring: var(--primary);", "  --primary: 170 50% 40%;"));
  assert.deepEqual(r.missingInDark, []);
  assert.equal(isReference("var(--primary)"), true);
  assert.equal(isReference(" 0 0% 100%"), false);
});

test("primitive 与组件层令牌不参与配对检查", () => {
  for (const t of ["--r-control", "--dur-fast", "--ease", "--sh-card", "--chart-1", "--material-shell", "--forge-edge"]) {
    assert.equal(isSemantic(t), false, t);
  }
  for (const t of ["--background", "--primary-foreground", "--success-ink", "--border"]) {
    assert.equal(isSemantic(t), true, t);
  }
});

test("多个 :root 块合并后再比对（index.css 有动效/色彩/几何三个 :root）", () => {
  const text = [
    ":root { --dur-fast: 100ms; }",
    ":root { --background: 0 0% 100%; }",
    ":root { --r-control: 8px; }",
    ".dark { --background: 0 0% 10%; }",
    "",
  ].join("\n");
  const r = checkThemePairs(text);
  assert.deepEqual(r.missingInDark, []);
  assert.ok(topLevelBlocks(text).filter((b) => b.selector === ":root").length === 3);
});
