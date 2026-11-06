export function breadcrumbParts(root: string, path: string): string[] {
  const normalized = path.replace(/\\/g, "/"), prefix = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = normalized.toLowerCase().startsWith(`${prefix.toLowerCase()}/`) ? normalized.slice(prefix.length + 1) : normalized;
  return relative.split("/").filter(Boolean);
}
