import type { DbConn } from "./dbApi";

/**
 * 连接分组与颜色标记的纯逻辑（侧栏渲染在 `components/db/ConnTree.tsx`）。
 *
 * 分组只是显示归类：不参与连接、权限、超时任何判断。所以这里全是纯函数，
 * 拖动排序、筛选、折叠这些交互留给组件。
 */

/**
 * 颜色键白名单，与后端 `db_conns::CONN_COLORS` **必须一字不差**。
 *
 * 为什么不让用户填任意色值：这个值会写进 `data-color` 并进入渲染路径，一旦允许自由文本，
 * 拼错时整行变透明、或者串到别处的样式上。固定枚举的好处是两个方向都确定：
 * 后端认识这个键（存得下），前端样式表里有对应规则（画得出来）。
 */
export const CONN_COLORS = ["red", "orange", "amber", "green", "blue", "purple", "gray"] as const;

export type ConnColor = (typeof CONN_COLORS)[number];

export const CONN_COLOR_LABEL: Record<ConnColor, string> = {
  red: "红",
  orange: "橙",
  amber: "琥珀",
  green: "绿",
  blue: "蓝",
  purple: "紫",
  gray: "灰",
};

/** 认不出的颜色（手改配置写错、老版本数据）一律当「不标记」，不报错。 */
export function connColor(conn: Pick<DbConn, "color">): ConnColor | null {
  const c = (conn.color ?? "").trim().toLowerCase();
  return (CONN_COLORS as readonly string[]).includes(c) ? (c as ConnColor) : null;
}

/** 分组名规范化：与后端 `db_conns::normalize_group` 同口径（去首尾、压内部空白）。 */
export function normalizeGroupName(name: string | null | undefined): string {
  return (name ?? "").split(/\s+/).filter(Boolean).join(" ");
}

export interface ConnGroup {
  /** 空串 = 未分组。 */
  name: string;
  conns: DbConn[];
}

/**
 * 按分组名归类。
 *
 * 顺序规则：
 * - 有名字的组按**在连接列表里第一次出现的顺序**排（连接列表本身是用户拖动出来的顺序，
 *   组序跟着它走比按拼音重排更符合「我刚挪过」的直觉）；
 * - 「未分组」永远垫底——它不是一个组，是还没归类的散连接，不该占在分类最前面。
 *
 * `keep` 用于筛选：为假时该连接不进结果，但**空组会被丢掉**，避免筛完只剩一排组头。
 */
export function groupConns(conns: DbConn[], keep?: (conn: DbConn) => boolean): ConnGroup[] {
  const named = new Map<string, DbConn[]>();
  const loose: DbConn[] = [];
  for (const c of conns) {
    if (keep && !keep(c)) continue;
    const name = normalizeGroupName(c.group);
    if (!name) {
      loose.push(c);
      continue;
    }
    const bucket = named.get(name);
    if (bucket) bucket.push(c);
    else named.set(name, [c]);
  }
  const out: ConnGroup[] = [...named].map(([name, list]) => ({ name, conns: list }));
  if (loose.length > 0) out.push({ name: "", conns: loose });
  return out;
}

/** 全部分组名（给表单里的「已有分组」提示用，去重、跳过未分组）。 */
export function groupNames(conns: DbConn[]): string[] {
  const seen = new Set<string>();
  for (const c of conns) {
    const n = normalizeGroupName(c.group);
    if (n) seen.add(n);
  }
  return [...seen];
}
