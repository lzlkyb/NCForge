// jar 内符号搜索：类名 / 包名 / 字段 / 常量 / 方法名 / **中文字符串原文**。
//
// 数据来自后端 `search_jar_symbols`，索引是 class 常量池的纯字节解析
// （`class_pool.rs`）——不启 JVM，所以第一次建索引也就是一分钟级，之后常驻内存。
//
// 🔴 物理边界：class 文件**不含注释**（javac 编译时就剥离了）。用户拿注释里的
// 关键词搜 jar 必然 0 命中，这不是实现问题。UI 常驻说明说的就是这条。
import { invoke } from "./tauri";

export interface JarSymbolPlace {
  /** jar 的绝对路径。 */
  jar: string;
  /** 点形类名，如 `nc.vo.VoucherBillOrder`。 */
  class: string;
}

export interface JarSymbolHit {
  /** 常量池里的原文（类名是 internal form：`nc/vo/VoucherBillOrder`）。 */
  term: string;
  /** 0 精确 / 1 前缀 / 2 包含。 */
  score: number;
  /** 命中的位置：一个词可能同时出现在多个 jar / 多个类里。后端每词最多列 8 处。 */
  places: JarSymbolPlace[];
  /**
   * 这个词真实命中多少处（可能远大于 `places.length`）。
   *
   * 可选：后端还没落地时缺省，界面只能按已列出的处数说话，不许拿它冒充总数。
   */
  placesTotal?: number;
}

export interface JarSymbolResult {
  items: JarSymbolHit[];
  /** 词表里一共多少个词命中（可能大于 `items.length`，后者受 limit 截断）。 */
  total: number;
  /** 扫描超预算提前停了：结果可能不全。 */
  truncated: boolean;
  /** 索引还没建好（首次，或类索引还在冷扫）：本次没有任何 jar 段结果。 */
  building: boolean;
  /** 结果来自旧索引，jar 已变动、正在后台重建。 */
  stale: boolean;
  /**
   * 索引建立失败的原因（磁盘满 / 杀软占用索引文件）。
   *
   * 可选：后端还没落地时缺省。有值时界面必须说「建失败 + 怎么办」，
   * 不能继续显示「正在后台建立」——那是永远等不到的假进度。
   */
  error?: string;
  elapsedMs: number;
}

/** 首屏条数；「加载更多」按倍数往上提，直到 `JAR_SEARCH_MAX_LIMIT`。 */
export const JAR_SYMBOL_LIMIT = 50;
/** 后端 `limit.clamp(1, 100)`：再往上要也不会给，只能让用户细化关键词。 */
export const JAR_SEARCH_MAX_LIMIT = 100;

export const searchJarSymbols = (query: string, limit = JAR_SYMBOL_LIMIT) =>
  invoke<JarSymbolResult>("search_jar_symbols", { query, limit });

/**
 * 这个查询词值不值得发一次 jar 段搜索（符号段与源码注释段共用同一条口径）。
 *
 * 长度 2 的门槛只对**纯 ASCII** 生效：单字母在几十 MB 词表里是噪音，符号索引
 * 本身也按字节长度拒（`q.len() < 2`）。中文单字（「税」「凭」）是 3 字节，后端
 * 支持且主搜索有结果——一并挡掉会让 jar 段无声消失，用户以为 jar 里没有。
 */
export function jarNeedleReady(query: string): boolean {
  const q = query.trim();
  if (q.length >= 2) return true;
  return q.length === 1 && q.charCodeAt(0) > 0x7f;
}

/**
 * jar 内 class 的打开地址。
 *
 * `preferSource` = 想让 jdt.ls 先做一次 source lookup（它会找到与编译 jar 同名的
 * `_src.jar`，于是用户看到**带注释的原始源码**）。默认 false 保持老行为：
 * 直接让后端用 CFR 反编译——合成地址带 `?=ncforge-decompile` 标记，
 * `lang.ts::fetchJdtSource` 见到它就不问语言服务。
 *
 * 为什么默认不改成 true：反编译对没有源码包的类是唯一出路，而 NC 现场补丁包
 * 经常整个不发布 `_src.jar`。有源码的地方（源码注释搜索的命中）才值得优先问 jdt.ls。
 */
export function jarClassUri(jar: string, className: string, preferSource = false): string {
  const name = jar.split(/[\\/]/).pop() ?? jar;
  const uri = `jdt://contents/${encodeURIComponent(name)}/${className.replace(/\./g, "/")}.class`;
  return preferSource ? uri : `${uri}?=ncforge-decompile`;
}
