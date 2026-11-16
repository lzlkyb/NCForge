/**
 * 几何令牌单一真源检查（纯函数，供 check-design-tokens.mjs 与单测共用）。
 *
 * 背景（2026-11-16 P0-1）：`--r-control` 曾在 index.css / forge-controls.css /
 * workbench-material.css 三处各定义一次，靠选择器特异性互相覆盖，导致 index.css 的
 * 默认值从未生效。现在几何令牌只允许存在于 index.css 的 `@tokens-geometry` 区间内。
 */

/** 受管令牌：能改变全站几何的自定义属性，必须集中在档位矩阵。 */
const MANAGED = String.raw`(?:--(?:r|h|gap)-[\w-]+|--row-h)`;

const DEF_SRC = String.raw`(${MANAGED})\s*:\s*([^;]+)`;

export const REGION_START = "@tokens-geometry:start";
export const REGION_END = "@tokens-geometry:end";

/**
 * 必须在「基础档」（区间内第一个顶层 :root 块）里有默认值的核心令牌。
 * 外观档独占的 --r-{shell,pane,work,inset} 不在此列：它们只在 material 档有意义。
 */
export const CORE_TOKENS = [
  "--r-control",
  "--r-chip",
  "--r-card",
  "--r-menu",
  "--r-dialog",
  "--h-control",
  "--h-icon",
  "--gap-control",
  "--row-h",
];

/** 与 check-design-tokens.mjs 同口径：注释里的色值/令牌名不算定义。 */
export function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** 区间标记写在注释里，所以先在原文定位行号，再做去注释。 */
export function regionLines(rawText) {
  const lines = rawText.split("\n");
  let start = -1;
  let end = -1;
  lines.forEach((line, i) => {
    if (start < 0 && line.includes(REGION_START)) start = i;
    if (line.includes(REGION_END)) end = i;
  });
  return { start, end };
}

/** 找出区间内第一个「顶层」:root 块（不在 @media 里）的行范围，作基础档。 */
export function baseBlockLines(rawText, region) {
  const lines = stripCssComments(rawText).split("\n");
  let depth = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (region.start >= 0 && (i <= region.start || i >= region.end)) {
      // 区间外只维护深度，不认 :root
      for (const ch of lines[i]) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
      }
      continue;
    }
    if (depth === 0 && /^\s*:root\s*\{/.test(lines[i])) start = i;
    for (const ch of lines[i]) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    if (start >= 0 && depth === 0 && i > start) return { start, end: i };
  }
  return null;
}

/** 抽出一个 CSS 文件里的几何令牌定义，并标注是否落在档位矩阵区间内。 */
export function definitions(rawText, path, indexFile = "src/index.css") {
  const region = regionLines(rawText);
  const stripped = stripCssComments(rawText).split("\n");
  const out = [];
  stripped.forEach((line, i) => {
    for (const m of line.matchAll(new RegExp(DEF_SRC, "g"))) {
      out.push({
        path,
        index: i,
        line: i + 1,
        token: m[1],
        value: m[2].trim(),
        inRegion: path === indexFile && region.start >= 0 && i > region.start && i < region.end,
      });
    }
  });
  return out;
}

/**
 * @param {{ path: string, text: string }[]} files
 * @returns {{ violations: {path:string,line:number,token:string,reason:string}[], missingCore: string[] }}
 */
export function checkSingleSource(files, indexFile = "src/index.css") {
  const violations = [];
  const indexEntry = files.find((f) => f.path === indexFile);

  for (const file of files) {
    for (const d of definitions(file.text, file.path, indexFile)) {
      if (file.path !== indexFile) {
        violations.push({
          path: d.path,
          line: d.line,
          token: d.token,
          reason: "几何令牌只能在 index.css 的「几何档位矩阵」里定义，本文件应改为引用",
        });
      } else if (!d.inRegion) {
        violations.push({
          path: d.path,
          line: d.line,
          token: d.token,
          reason: "index.css 内的几何令牌必须写在 @tokens-geometry:start / :end 之间",
        });
      }
    }
  }

  const missingCore = [];
  if (indexEntry) {
    const region = regionLines(indexEntry.text);
    const base = baseBlockLines(indexEntry.text, region);
    const declared = new Set(
      definitions(indexEntry.text, indexEntry.path, indexFile)
        .filter((d) => d.inRegion && base && d.index > base.start && d.index < base.end)
        .map((d) => d.token),
    );
    for (const token of CORE_TOKENS) if (!declared.has(token)) missingCore.push(token);
  } else {
    missingCore.push(...CORE_TOKENS);
  }

  return { violations, missingCore };
}
