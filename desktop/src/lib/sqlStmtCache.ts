import { splitStatements, type Stmt } from "./sqlSplit";

/** 只用到 model 的这两个方法，测试里可以用假对象。 */
export interface StmtSource {
  getVersionId(): number;
  getValue(): string;
}

const cache = new WeakMap<StmtSource, { version: number; stmts: Stmt[] }>();

/**
 * 整篇 SQL 的切分结果，按 model + 版本号缓存。
 *
 * 光标移动、补全、格式化都要「光标在哪条语句」，内容没变就不重切；
 * 内容一变版本号就变，下次取时重切一遍。WeakMap 随 model 释放。
 */
export function statementsOf(model: StmtSource): Stmt[] {
  const version = model.getVersionId();
  const hit = cache.get(model);
  if (hit && hit.version === version) return hit.stmts;
  const stmts = splitStatements(model.getValue());
  cache.set(model, { version, stmts });
  return stmts;
}
