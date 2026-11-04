/**
 * NC 模块边界：**工作区根下的第一级目录**就是模块（`bill` / `gl` / `aim`）。
 *
 * 与后端 `compile::module_of` 是同一条规则。放在前端只为一件事：右键菜单要显示
 * 「编译模块 bill」这个名字，而不是让用户点一个不知道会编什么的「编译」。
 *
 * 三条必须与后端一致的边界：
 * - 路径不在 `root` 底下（关联工程的文件）→ `null`。编译只认当前工作区，
 *   菜单里就不该出现一个后端必拒的项。
 * - `root` 自己（或与 `root` 同级的文件）→ `null`，根不是一个模块。
 * - 前缀相同但不同目录（`C:\w\newar-备份`）→ `null`：`root` 后面必须紧跟分隔符。
 */
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * `dir`（**目录**，文件请先取 `dirName`）属于哪个模块；不在工作区里返回 `null`。
 */
export function moduleOf(root: string, dir: string): string | null {
  if (!root || !dir) return null;
  const r = norm(root);
  const d = norm(dir);
  if (d.length <= r.length + 1) return null;
  if (d.slice(0, r.length).toLowerCase() !== r.toLowerCase()) return null;
  if (d[r.length] !== "/") return null;
  const seg = d.slice(r.length + 1).split("/")[0];
  return seg || null;
}
