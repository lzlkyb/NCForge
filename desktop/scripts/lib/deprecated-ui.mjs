/**
 * 旧组件导入棘轮（DESIGN.md §5：两代弹层并存）。
 *
 * 只对「已有替代品」的组件设棘轮。Menu / ConfirmDialog 没有替代实现，
 * 不在此列——给没有替代品的东西标废弃只会制造噪音。
 */

export const DEPRECATED_MODULES = {
  "components/ui/Modal": { replacement: "components/ui/dialog", note: "Dialog / DialogHeader / DialogTitle" },
};

/** 导入路径归一化：`../ui/Modal`、`../../ui/Modal`、`./Modal` 都算同一个模块。 */
export function normalizeImportPath(spec) {
  const m = /(?:^|\/)(ui\/)?(Modal|ConfirmDialog|Menu|InfoPopover)$/.exec(spec);
  if (!m) return null;
  const name = m[2];
  return `components/ui/${name}`;
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
 * @returns {{ violations: {module:string,allowed:number,actual:number,files:string[]}[], stale: string[] }}
 */
export function checkDeprecated(files, baseline) {
  const imports = collectImports(files);
  const violations = [];
  const stale = [];
  for (const [mod, meta] of Object.entries(DEPRECATED_MODULES)) {
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
