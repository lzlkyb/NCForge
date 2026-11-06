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
  elapsedMs: number;
}

export const searchTypes = (query: string, limit = 30) =>
  invoke<TypeSearchResult>("search_types", { query, limit });

/**
 * jar 内类型的打开地址。查询串是标记而不是 jdt.ls 的真实附件：
 * `loadJdtSource` 见到它就不问语言服务，直接让后端用 CFR 反编译。
 */
export function jarTypeUri(hit: TypeHit): string {
  const name = hit.jar.split(/[\\/]/).pop() ?? hit.jar;
  return `jdt://contents/${encodeURIComponent(name)}/${hit.name.replace(/\./g, "/")}.class?=ncforge-decompile`;
}
