/**
 * 令牌分层检查（P0-2）。
 *
 * 唯一会真正让主题"瞎掉"的错法：新增语义色只写了 :root、忘了 .dark（或反之）。
 * 这里只查这一条——它是可判定的；至于"页面别直接引用 primitive"这种风格问题，
 * 存量太大且收益低，不做硬门禁（见 DESIGN.md §2 的约定）。
 */

/** 不属于「语义色」的令牌前缀：原语（刻度）、组件层（允许单边定义）。 */
const NON_SEMANTIC = [
  "--r-",
  "--row-h",
  "--h-",
  "--gap-",
  "--dur",
  "--ease",
  "--dur-",
  "--ease-",
  "--fs-",
  "--lh-",
  "--sh-",
  "--grad-",
  "--shadow-",
  "--glass-",
  "--chart-",
  "--badge-",
  "--material-",
  "--forge-",
  "--window-",
  "--version-",
  "--logo-",
  "--card-primary-",
  "--radius",
  "--disabled-opacity",
  "--border-strong",
  "--hero-",
  "--header-",
  "--raised",
];

export function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** 顶层块（depth 0 → 1 → 0）。按选择器原文取第一个匹配块。 */
export function topLevelBlocks(rawText) {
  const lines = stripCssComments(rawText).split("\n");
  const blocks = [];
  let depth = 0;
  let current = null;
  lines.forEach((line, i) => {
    if (depth === 0 && line.includes("{")) {
      current = { selector: line.slice(0, line.indexOf("{")).trim(), start: i + 1, decls: [] };
    }
    if (current && depth >= 1) {
      const m = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/);
      if (m) current.decls.push({ token: m[1], value: m[2].trim(), line: i + 1 });
    }
    for (const ch of line) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    if (current && depth === 0) {
      blocks.push(current);
      current = null;
    }
  });
  return blocks;
}

export function isSemantic(token) {
  return !NON_SEMANTIC.some((p) => token === p || (p.endsWith("-") && token.startsWith(p)));
}

/** 值是 var(...) 引用时自动跟随被引令牌，不需要在另一主题再写一份（如 --ring: var(--primary)）。 */
export function isReference(value) {
  return /^var\(/.test(String(value).trim());
}

/** 同名顶层块可能不止一个（index.css 有 3 个 :root：动效 / 色彩 / 几何档位），必须合并。 */
export function mergeBySelector(blocks, selector) {
  return blocks.filter((b) => b.selector === selector).flatMap((b) => b.decls);
}

/**
 * @returns {{ missingInDark: {token:string,line:number}[], missingInLight: {token:string,line:number}[] }}
 */
export function checkThemePairs(rawText) {
  const blocks = topLevelBlocks(rawText);
  const light = mergeBySelector(blocks, ":root");
  const dark = mergeBySelector(blocks, ".dark");
  if (!light.length || !dark.length) return { missingInDark: [], missingInLight: [] };

  const darkTokens = new Set(dark.map((d) => d.token));
  const lightTokens = new Set(light.map((d) => d.token));

  const missingInDark = light
    .filter((d) => isSemantic(d.token) && !isReference(d.value) && !darkTokens.has(d.token))
    .map((d) => ({ token: d.token, line: d.line }));
  const missingInLight = dark
    .filter((d) => isSemantic(d.token) && !isReference(d.value) && !lightTokens.has(d.token))
    .map((d) => ({ token: d.token, line: d.line }));

  return { missingInDark, missingInLight };
}
