import { listCommands } from "./commandRegistry";
import { getFileIndex } from "./fileIndex";
import { fuzzyMatch, rankFiles, type FileEntry, type Range } from "./fuzzy";
import { langReady, langRequest } from "./lang";
import { uriToPath } from "./langConvert";
import type { PaletteMode } from "./keymap";
import { getRecent } from "./recentFiles";
import { fetchSymbols, kindLetter } from "./symbols";

/** 浮层里的一行。 */
export interface PaletteItem {
  key: string;
  title: string;
  /** 标题上要高亮的区间。 */
  ranges?: Range[];
  /** 右侧灰字（目录 / 包名 / 行号）。 */
  detail?: string;
  /** 小标签：已打开 / 最近 / jar。 */
  badge?: string;
  /** 类型字母（C / I / E / M / F）。 */
  kind?: string;
  /** 快捷键提示（命令模式）。 */
  hint?: string;
  run: () => void;
}

/** 「怎么打开一个目标」由浮层注入（文件页才知道怎么开标签）。行列都是 1 基。 */
export interface Runner {
  file: (path: string, line?: number, column?: number) => void;
  jdt: (uri: string, line: number, column: number) => void;
}

export interface PaletteCtx {
  root: string | null;
  /** 当前标签的路径（可能是 jdt:// 虚拟文件）。 */
  activePath: string | null;
  openPaths: string[];
  run: Runner;
}

export interface PaletteResult {
  items: PaletteItem[];
  /** 列表上方的一句说明（分组标题 / 为什么空）。 */
  note: string;
}

const LIMIT = 50;
/** 类 / 枚举 / 接口三种 LSP SymbolKind，类型搜索只要这些。 */
const TYPE_KINDS = new Set([5, 10, 11]);

const lower = (p: string) => p.toLowerCase();

function fileItem(e: FileEntry, ctx: PaletteCtx, extra: Partial<PaletteItem>): PaletteItem {
  const open = ctx.openPaths.some((p) => lower(p) === lower(e.path));
  return {
    key: e.path,
    title: e.name,
    detail: e.dir,
    badge: open ? "已打开" : undefined,
    run: () => ctx.run.file(e.path),
    ...extra,
  };
}

async function filesMode(query: string, ctx: PaletteCtx): Promise<PaletteResult> {
  if (!ctx.root) return { items: [], note: "尚未打开工程" };
  const entries = await getFileIndex(ctx.root);
  const q = query.trim();
  if (!q) {
    const byPath = new Map(entries.map((e) => [lower(e.path), e]));
    const recent = getRecent(ctx.root)
      .filter((p) => lower(p) !== lower(ctx.activePath ?? ""))
      .map((p) => byPath.get(lower(p)))
      .filter((e): e is FileEntry => !!e)
      .slice(0, 12);
    return { items: recent.map((e) => fileItem(e, ctx, { badge: undefined })), note: recent.length ? "最近打开" : `输入文件名（工程内共 ${entries.length} 个文件）` };
  }
  const ranked = rankFiles(entries, q, LIMIT);
  return {
    items: ranked.map((r) =>
      fileItem(r.entry, ctx, r.on === "name" ? { ranges: r.ranges } : { detail: r.entry.rel }),
    ),
    note: ranked.length ? `匹配 ${ranked.length} 项` : "没有匹配的文件",
  };
}

interface RawSymbolInfo {
  name?: string;
  kind?: number;
  containerName?: string;
  location?: { uri?: string; range?: { start?: { line: number; character: number } } };
}

/** 语言服务的类型搜索（连依赖 jar 里的类一起搜）。失败 / 没结果返回 null，由调用方退回工作区扫描。 */
async function langTypes(query: string, ctx: PaletteCtx): Promise<PaletteItem[] | null> {
  if (!langReady()) return null;
  let res: unknown;
  try {
    res = await langRequest<unknown>("workspace/symbol", null, { query }, 15_000);
  } catch {
    return null;
  }
  if (!Array.isArray(res)) return null;
  const seen = new Set<string>();
  const items: PaletteItem[] = [];
  for (const s of res as RawSymbolInfo[]) {
    const uri = s.location?.uri;
    const pos = s.location?.range?.start;
    if (!s.name || !uri || !pos || !TYPE_KINDS.has(s.kind ?? 0)) continue;
    const key = `${uri}#${s.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = pos.line + 1;
    const column = pos.character + 1;
    const path = uriToPath(uri);
    const hit = fuzzyMatch(query, s.name);
    items.push({
      key,
      title: s.name,
      ranges: hit?.ranges,
      detail: s.containerName,
      kind: kindLetter(s.kind ?? 0),
      badge: path ? undefined : "jar",
      run: () => (path ? ctx.run.file(path, line, column) : ctx.run.jdt(uri, line, column)),
    });
    if (items.length >= LIMIT) break;
  }
  return items.length ? items : null;
}

async function typesMode(query: string, ctx: PaletteCtx): Promise<PaletteResult> {
  const q = query.trim();
  if (!q) return { items: [], note: "输入类名（支持驼峰首字母，如 VBO）" };
  const fromLang = await langTypes(q, ctx);
  if (fromLang) return { items: fromLang, note: `工作区与依赖 jar 中的类型 · ${fromLang.length} 项` };
  // 退回：只在工作区里找「文件名 = 类名」的 .java（代码智能未就绪、或它没给结果）
  if (!ctx.root) return { items: [], note: "尚未打开工程" };
  const javas = (await getFileIndex(ctx.root)).filter((e) => e.name.endsWith(".java"));
  const ranked = rankFiles(javas, q, LIMIT).filter((r) => r.on === "name");
  const note = langReady() ? "语言服务没有结果，已退回工作区文件名搜索" : "代码智能未就绪，只搜工作区里的类";
  return {
    items: ranked.map((r) => {
      const stem = r.entry.name.replace(/\.java$/, "");
      return fileItem(r.entry, ctx, { title: stem, ranges: r.ranges, kind: "C", badge: undefined });
    }),
    note: ranked.length ? note : "没有匹配的类",
  };
}

async function symbolsMode(query: string, ctx: PaletteCtx): Promise<PaletteResult> {
  const path = ctx.activePath;
  if (!path || path.startsWith("jdt://") || !path.toLowerCase().endsWith(".java")) {
    return { items: [], note: "先打开一个 Java 文件" };
  }
  if (!langReady()) return { items: [], note: "代码智能未就绪，暂时列不出符号" };
  let symbols;
  try {
    symbols = await fetchSymbols(path);
  } catch (e) {
    return { items: [], note: `取符号失败：${String(e)}` };
  }
  const q = query.trim();
  const items: PaletteItem[] = [];
  symbols.forEach((s, i) => {
    const hit = q ? fuzzyMatch(q, s.name) : { score: 0, ranges: [] };
    if (!hit) return;
    items.push({
      key: `${i}:${s.name}`,
      title: s.name,
      ranges: hit.ranges,
      detail: `${s.container ? `${s.container} · ` : ""}第 ${s.line} 行`,
      kind: kindLetter(s.kind),
      run: () => ctx.run.file(path, s.line, s.column),
    });
  });
  return { items: items.slice(0, 200), note: `${path.slice(path.lastIndexOf("\\") + 1)} 中的符号 · ${items.length} 项` };
}

function commandsMode(query: string): PaletteResult {
  const q = query.trim();
  const items: { item: PaletteItem; score: number }[] = [];
  for (const c of listCommands()) {
    const hit = q ? fuzzyMatch(q, c.title) : { score: 0, ranges: [] };
    if (hit) items.push({ item: { key: c.id, title: c.title, ranges: hit.ranges, hint: c.hint, run: c.run }, score: hit.score });
  }
  items.sort((a, b) => b.score - a.score);
  return { items: items.map((x) => x.item), note: items.length ? "命令" : "没有匹配的命令" };
}

export async function buildItems(mode: PaletteMode, query: string, ctx: PaletteCtx): Promise<PaletteResult> {
  switch (mode) {
    case "file":
      return filesMode(query, ctx);
    case "type":
      return typesMode(query, ctx);
    case "symbol":
      return symbolsMode(query, ctx);
    case "cmd":
      return commandsMode(query);
  }
}
