/**
 * BMF 路径比较口径。
 *
 * Windows 上同一文件可能以 `D:\a\METADATA\x.bmf`、`d:/a/METADATA/x.bmf`、
 * `\\?\D:\a\METADATA\x.bmf` 三种形态出现（后端 `resolve_safe_path` 会 canonicalize
 * 成第三种）。索引、选中项、新建回传路径之间直接 `===` 比较，会把同一个文件当成
 * 两个——表现为「新建成功但没选中」或「保存后选中项丢失」。
 */
export function normalizeBmfPath(path: string): string {
  let p = path.trim();
  // `\\?\UNC\server\share` → `\\server\share`
  if (p.startsWith("\\\\?\\UNC\\")) p = `\\\\${p.slice(8)}`;
  else if (p.startsWith("\\\\?\\")) p = p.slice(4);
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 组件/模块编码：与后端 `normalize_ident` 同一口径（小写字母开头，仅 [a-z0-9_]）。 */
export const BMF_IDENT = /^[a-z][a-z0-9_]*$/;
