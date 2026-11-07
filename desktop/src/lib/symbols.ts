import { flushDoc, langRequest } from "./lang";

/** 文件内的一个符号（类 / 方法 / 字段），行列都是 1 基。 */
export interface FlatSymbol {
  name: string;
  kind: number;
  /** 外层符号名（点号连接），顶层为空串。 */
  container: string;
  /** 符号名所在的行列（跳转落点）。 */
  line: number;
  column: number;
  /** 符号整体起止行（用来判断光标在不在它里面）。 */
  startLine: number;
  endLine: number;
  depth: number;
}

interface LspPos {
  line: number;
  character: number;
}
interface LspRng {
  start: LspPos;
  end: LspPos;
}
interface RawSymbol {
  name?: string;
  kind?: number;
  range?: LspRng;
  selectionRange?: LspRng;
  children?: RawSymbol[];
  location?: { range?: LspRng };
  containerName?: string;
}

/**
 * 把 `textDocument/documentSymbol` 的返回拍平。
 *
 * 服务端按客户端声明的能力返回两种形态：层级的 `DocumentSymbol`（有 `selectionRange` 与 `children`）或平铺的
 * `SymbolInformation`（有 `location` 与 `containerName`）。两种都要认，稍后改能力声明也不会坏。
 */
export function flattenSymbols(result: unknown): FlatSymbol[] {
  if (!Array.isArray(result)) return [];
  const out: FlatSymbol[] = [];
  const walk = (list: RawSymbol[], container: string, depth: number) => {
    for (const s of list) {
      if (!s.name) continue;
      const whole = s.range ?? s.location?.range;
      const sel = s.selectionRange ?? whole;
      if (!whole || !sel) continue;
      out.push({
        name: s.name,
        kind: s.kind ?? 0,
        container: s.containerName ?? container,
        line: sel.start.line + 1,
        column: sel.start.character + 1,
        startLine: whole.start.line + 1,
        endLine: whole.end.line + 1,
        depth,
      });
      if (s.children?.length) walk(s.children, container ? `${container}.${s.name}` : s.name, depth + 1);
    }
  };
  walk(result as RawSymbol[], "", 0);
  return out;
}

/** 光标所在行的包含链：从最外层到最里层。同一深度取起始行最靠近光标的那个。 */
export function chainAt(symbols: FlatSymbol[], line: number): FlatSymbol[] {
  const hits = symbols.filter((s) => s.startLine <= line && line <= s.endLine);
  const chain: FlatSymbol[] = [];
  // 平铺形态没有 depth（都是 0），按跨度从大到小排，外层在前
  const ordered = [...hits].sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine) || a.depth - b.depth);
  for (const s of ordered) {
    const last = chain[chain.length - 1];
    if (!last || (s.startLine >= last.startLine && s.endLine <= last.endLine)) chain.push(s);
  }
  return chain;
}

/** 符号种类的单字母标记与名称（LSP SymbolKind）。 */
export function kindLetter(kind: number): string {
  switch (kind) {
    case 5: return "C";
    case 11: return "I";
    case 10: return "E";
    case 6: case 9: case 12: return "M";
    case 8: case 13: case 14: case 22: return "F";
    default: return "·";
  }
}

/**
 * 按 mtime 缓存的文件符号。
 *
 * 面包屑与「文件结构」面板要的是同一份数据，两边各请求一次等于每次保存都多发一个
 * documentSymbol（服务端还要重算一遍 AST）。mtime 变了说明文件被保存过，这时才重新取。
 */
const cache = new Map<string, { mtime: number; list: FlatSymbol[] }>();

/**
 * 缓存文件数上限。
 *
 * 不设上限就等于把整个工程的符号堆在内存里（一个 java 文件几百个符号），
 * 而且切到别的模块后旧数据也不会释放。Map 保序，超了就淘汰最早写入的。
 */
const CACHE_MAX = 200;

export async function symbolsFor(path: string, mtimeMs?: number): Promise<FlatSymbol[]> {
  const key = path.toLowerCase();
  const hit = cache.get(key);
  if (hit && mtimeMs !== undefined && hit.mtime === mtimeMs) return hit.list;
  const list = await fetchSymbols(path);
  if (!cache.has(key) && cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { mtime: mtimeMs ?? -1, list });
  return list;
}

/** 清空符号缓存（切工作区时：旧工程的符号在新工程里没有意义）。 */
export function resetSymbolCache(): void {
  cache.clear();
}

/** 取一个 Java 文件的符号。调用方负责确认代码智能已就绪。 */
export async function fetchSymbols(path: string): Promise<FlatSymbol[]> {
  // 与补全 / 跳转同理：先把还没发出去的修改发给服务端，否则算的是改动前的文本
  await flushDoc(path);
  // 5 秒。单文件的 documentSymbol 正常是几十毫秒；15 秒只会在服务端卡住时
  // 让面包屑/结构面板一起僵着，宁可先空一次（下一次保存就会重取）。
  const res = await langRequest<unknown>("textDocument/documentSymbol", path, { textDocument: {} }, 5_000);
  return flattenSymbols(res);
}
