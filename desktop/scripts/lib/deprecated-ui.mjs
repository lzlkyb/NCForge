/**
 * 旧组件导入棘轮。
 *
 * 2026-11-17 清空：原表只有 `Modal → dialog` 一条。真正去读 `dialog.tsx` 才发现
 * `Dialog` 只是 `Modal` 加一套固定样式（`max-w-lg` + `p-5` + `--r-card`），
 * 两者是「原语 / 预设」关系而非「旧 / 新」替代 —— 这条棘轮一直在逼新代码走一条
 * 等价路径，属于错误约束，已撤。
 *
 * 弹层真正的债是**宽度不一致**（迁移前 16 种宽度、四套体系），已由
 * `scripts/lib/modal-width.mjs` 接管，随 `npm run tokens:check` 执行。
 *
 * 机制保留：将来出现「确有两个同语义实现、其中一个该淘汰」再登记，登记时必须
 * 能指出替代品**在语义上覆盖**了旧件，而不是它长得像。
 */
export const DEPRECATED_MODULES = {};

/**
 * 导入路径归一化：`../ui/Modal`、`../../ui/Modal`、`./Modal` 都算同一个模块。
 *
 * 不再枚举组件名白名单——白名单会让「新登记的旧组件」静默收不到导入，
 * 棘轮看着在跑其实永远 0 违规。PascalCase 的默认导出统一归一化即可。
 */
export function normalizeImportPath(spec) {
  const m = /(?:^|\/)(?:ui\/)?([A-Z][A-Za-z0-9]*)$/.exec(spec);
  if (!m) return null;
  return `components/ui/${m[1]}`;
}

const IMPORT_RE = /from\s+["']([^"']+)["']/g;

/** @returns {Record<string, string[]>} 模块 → 导入它的文件列表（去重、已排序） */
export function collectImports(files, skipSelf = true) {
  const out = {};
  for (const file of files) {
    const seen = new Set();
    for (const m of file.text.matchAll(new RegExp(IMPORT_RE))) {
      const mod = normalizeImportPath(m[1]);
      if (!mod || seen.has(mod)) continue;
      if (skipSelf && file.path.endsWith(`/${mod}.tsx`)) continue;
      seen.add(mod);
      (out[mod] ??= []).push(file.path);
    }
  }
  for (const key of Object.keys(out)) out[key].sort();
  return out;
}

/**
 * @param {{path:string,text:string}[]} files
 * @param {Record<string, number>} baseline
 * @param {typeof DEPRECATED_MODULES} [modules] 可注入，便于单测验证机制本身
 * @returns {{ violations: {module:string,allowed:number,actual:number,files:string[]}[], stale: string[] }}
 */
export function checkDeprecated(files, baseline, modules = DEPRECATED_MODULES) {
  const imports = collectImports(files);
  const violations = [];
  const stale = [];
  for (const [mod, meta] of Object.entries(modules)) {
    const allowed = baseline[mod] ?? 0;
    const actual = (imports[mod] ?? []).length;
    if (actual > allowed) {
      violations.push({ module: mod, replacement: meta.replacement, allowed, actual, files: imports[mod] ?? [] });
    } else if (actual < allowed) {
      stale.push(`${mod}: 基线 ${allowed} → 实际 ${actual}（可下调基线）`);
    }
  }
  return { violations, stale };
}
