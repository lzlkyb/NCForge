// 类型搜索：工作区源码走本地索引，依赖 jar 走全库类名目录。
//
// 数据都来自后端 `search_types`，前端不做二次过滤——「工作区优先、jar 去重」这类
// 规则只写一份，快速面板与将来的其它入口看到的结果才一致。
import { invoke } from "./tauri";

export interface TypeHit {
  /** 全限定名 */
  name: string;
  simple: string;
  package: string;
  /** LSP SymbolKind：5 类 / 10 枚举 / 11 接口 */
  kind: number;
  /** 工作区源码的绝对路径；jar 条目为空串 */
  file: string;
  /** 工作区模块名；jar 条目为空串 */
  module: string;
  /** jar 的绝对路径；工作区条目为空串 */
  jar: string;
  line: number;
  column: number;
}

export interface TypeSearchResult {
  workspace: TypeHit[];
  jars: TypeHit[];
  /** jar 目录还没建好（首次建索引较慢）：本次结果只有工作区部分 */
  jarsPending: boolean;
  /** 工作区索引还在后台建（首次查询）：本次结果为空，调用方应退回文件名匹配 */
  indexing: boolean;
  elapsedMs: number;
}

export const searchTypes = (query: string, limit = 30) =>
  invoke<TypeSearchResult>("search_types", { query, limit });

/**
 * 工作区里的一条成员（方法 / 字段 / 构造器 / 枚举常量），行列为 1 基。
 *
 * 与 `TypeHit` 不同，这条**不依赖语言服务**：来自同一份工作区索引，语言服务建索引
 * 期间也能秒回。
 */
export interface SymbolHit {
  name: string;
  /** 所属类型，嵌套类是 `Outer.Inner`。 */
  container: string;
  /** LSP SymbolKind：6 方法 / 8 字段 / 9 构造器 / 14 常量 / 22 枚举成员 */
  kind: number;
  file: string;
  module: string;
  line: number;
  column: number;
}

export interface SymbolSearchResult {
  items: SymbolHit[];
  /** 索引里一共多少条成员：说明「搜的是多大范围」，也便于判断索引是否还没建好。 */
  total: number;
  /** 工作区索引还在后台建（首次查询）：本次结果为空 */
  indexing: boolean;
  elapsedMs: number;
}

export const searchSymbols = (query: string, limit = 50) =>
  invoke<SymbolSearchResult>("search_workspace_symbols", { query, limit });

/**
 * jar 内类型的打开地址。查询串是标记而不是 jdt.ls 的真实附件：
 * `loadJdtSource` 见到它就不问语言服务，直接让后端用 CFR 反编译。
 */
export function jarTypeUri(hit: TypeHit): string {
  const name = hit.jar.split(/[\\/]/).pop() ?? hit.jar;
  return `jdt://contents/${encodeURIComponent(name)}/${hit.name.replace(/\./g, "/")}.class?=ncforge-decompile`;
}
