import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import postcss from "postcss";
import { JSDOM } from "jsdom";

const material = postcss.parse(readFileSync(new URL("../src/glass-material.css", import.meta.url), "utf8"));
const theme = postcss.parse(readFileSync(new URL("../src/index.css", import.meta.url), "utf8"));

function definitions(stylesheet, match) {
  const values = {};
  for (const rule of stylesheet.nodes.filter(node => node.type === "rule" && match(node.selector))) {
    for (const declaration of rule.nodes.filter(node => node.type === "decl")) values[declaration.prop] = declaration.value;
  }
  return values;
}

test("隐藏的缓存设置不改变数据库正文材质，显示设置后才启用", () => {
  const rule = material.nodes.find(node => node.type === "rule" && node.selector.includes(".wb-document-surface:has"));
  assert.ok(rule, "设置阅读面的材质规则必须存在");
  const dom = new JSDOM('<html data-ui-style="glass"><body><div class="app-shell"><div class="wb-document-surface"><div class="wb-dock-region" hidden><div class="wb-settings-page"><div class="wb-settings-body"></div></div></div><div class="wb-dock-region"><div class="dbx-page"></div></div></div></div></body></html>');
  try {
    const document = dom.window.document;
    const surface = document.querySelector(".wb-document-surface");
    const settings = document.querySelector("[hidden]");
    assert.equal(surface.matches(rule.selector), false);
    settings.hidden = false;
    assert.equal(surface.matches(rule.selector), true);
    settings.hidden = true;
    assert.equal(surface.matches(rule.selector), false);
  } finally {
    dom.window.close();
  }
});

const rgb = value => value.match(/[\d.]+/g).map(Number);
function hsl(value) {
  const [hue, saturation, lightness] = rgb(value);
  const light = lightness / 100;
  const amplitude = saturation / 100 * Math.min(light, 1 - light);
  return [0, 8, 4].map(offset => {
    const channel = (offset + hue / 30) % 12;
    return 255 * (light - amplitude * Math.max(-1, Math.min(channel - 3, 9 - channel, 1)));
  });
}
function over(foreground, background, strength = 1) {
  const alpha = (foreground[3] ?? 1) * strength;
  return foreground.slice(0, 3).map((channel, index) => channel * alpha + background[index] * (1 - alpha));
}
function luminance(color) {
  return color.map(channel => channel / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
}
function contrast(foreground, background) {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

for (const mode of ["light", "dark"]) {
  test(`${mode} 柔光底、侧栏、正文与浮层上的文字达到 4.5:1`, () => {
    const shared = definitions(material, selector => selector.startsWith(":is(html["));
    const surfaces = { ...shared, ...(mode === "dark" ? definitions(material, selector => selector.startsWith(":is(html.dark")) : {}) };
    const colors = { ...definitions(theme, selector => selector === ":root"), ...(mode === "dark" ? definitions(theme, selector => selector === ".dark") : {}) };
    const layers = [...surfaces["--glass-backdrop"].matchAll(/rgb\(([^)]+)\)/g)].map(match => rgb(match[1]));
    const sheen = rgb(surfaces["--glass-sheen"].match(/rgb\(([^)]+)\)/)[1]);
    const samples = [hsl(colors["--card"])];
    // 每层取零和最大强度，组合覆盖比实际空间渐变更宽的色域。
    // 在线性叠色的各端点核对亮度，避免只测背景中心而漏掉边缘颜色。
    for (let mask = 0; mask < 2 ** layers.length; mask++) {
      let background = rgb(surfaces["--glass-stage"]);
      for (let index = layers.length - 1; index >= 0; index--) background = over(layers[index], background, (mask >> index) & 1);
      samples.push(over(rgb(surfaces["--glass-wash"]), background));
      for (const token of ["--glass-panel", "--glass-document", "--glass-inset", "--glass-floating"]) {
        const panel = over(rgb(surfaces[token]), background);
        samples.push(panel, over(sheen, panel));
      }
    }
    for (const [role, value] of [["正文", colors["--foreground"]], ["辅助文字", surfaces["--muted-foreground"]]]) {
      const minimum = Math.min(...samples.map(background => contrast(hsl(value), background)));
      assert.ok(minimum >= 4.5, `${role}最低对比度为 ${minimum.toFixed(2)}:1`);
    }
  });
}
