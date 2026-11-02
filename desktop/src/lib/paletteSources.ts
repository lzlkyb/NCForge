import { listCommands } from "./commandRegistry";
import { getFileIndex } from "./fileIndex";
import { fuzzyMatch, rankFiles, type FileEntry, type Range } from "./fuzzy";
import { parseLineQuery, rankFilesRecent, recentFirst } from "./gotoAnything";
import { langReady, langRequest } from "./lang";
import { uriToPath } from "./langConvert";
import type { PaletteMode } from "./keymap";
import { getRecent } from "./recentFiles";
import { searchWorkspace } from "./search";
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
/** 成员级：方法 6 / 字段 8 / 构造器 9 / 常量 14 / 枚举成员 22。 */
const MEMBER_KINDS = new Set([6, 8, 9, 14, 22]);

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
  const q = query.trim();
  // `#` 搜内容、`:` 跳行号：和 VS Code 的「转到任意位置」同一套前缀，
  // 不必为它们再占一个入口键，也不用离开这个输入框。
  if (q.startsWith("#")) return contentMode(q.slice(1).trim(), ctx);
  if (q.startsWith(":")) return lineMode(q, ctx);
  const entries = await getFileIndex(ctx.root);
  if (!q) {
    const byPath = new Map(entries.map((e) => [lower(e.path), e]));
    const recent = getRecent(ctx.root)
      .filter((p) => lower(p) !== lower(ctx.activePath ?? ""))
      .map((p) => byPath.get(lower(p)))
      .filter((e): e is FileEntry => !!e)
      .slice(0, 12);
    return { items: recent.map((e) => fileItem(e, ctx, { badge: undefined })), note: recent.length ? "最近打开" : `输入文件名（工程内共 ${entries.length} 个文件）` };
  }
  const ranked = rankFilesRecent(entries, q, LIMIT, getRecent(ctx.root));
  return {
    items: ranked.map((r) =>
      fileItem(r.entry, ctx, r.on === "name" ? { ranges: r.ranges } : { detail: r.entry.rel }),
    ),
    note: ranked.length ? `匹配 ${ranked.length} 项` : "没有匹配的文件",
  };
}

/** `#内容`：在工作区文件里找文本，最近打开过的文件排前面。 */
async function contentMode(text: string, ctx: PaletteCtx): Promise<PaletteResult> {
  if (!text) return { items: [], note: "输入要在工程里找的内容（# 开头）" };
  let out;
  try {
    out = await searchWorkspace({ text, maxResults: LIMIT });
  } catch (e) {
    return { items: [], note: `搜索失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const base = (ctx.root ?? "").replace(/[\\/]+$/, "");
  const hits = out.hits.map((h) => ({ hit: h, path: `${base}\\${h.path.replace(/\//g, "\\")}` }));
  const ordered = recentFirst(hits, (h) => h.path, getRecent(ctx.root));
  const items: PaletteItem[] = ordered.map(({ hit, path }) => ({
    key: `${path}:${hit.line}:${hit.ranges[0]?.start ?? 0}`,
    title: hit.text.trim() || "（空行）",
    detail: `${hit.path}:${hit.line}`,
    run: () => ctx.run.file(path, hit.line, (hit.ranges[0]?.start ?? 0) + 1),
  }));
  const note = out.truncated
    ? `内容命中 ${items.length} 条（已到上限，缩小关键词可看到更精确的结果）`
    : items.length
      ? `内容 · ${items.length} 项`
      : "没有匹配的内容";
  return { items, note };
}

/** `:行号` / `:行号:列号`：跳到当前文件的位置（jar 内的类也能跳）。 */
function lineMode(query: string, ctx: PaletteCtx): PaletteResult {
  const target = parseLineQuery(query);
  if (!target) return { items: [], note: "输入 :行号，或 :行号:列号" };
  const path = ctx.activePath;
  if (!path) return { items: [], note: "先打开一个文件再跳行号" };
  const column = target.column ?? 1;
  const name = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
  return {
    items: [
      {
        key: `line:${target.line}:${column}`,
        title: `跳到第 ${target.line} 行${target.column ? `第 ${column} 列` : ""}`,
        detail: name,
        run: () =>
          path.startsWith("jdt://")
            ? ctx.run.jdt(path, target.line, column)
            : ctx.run.file(path, target.line, column),
      },
    ],
    note: "行号跳转",
  };
}

interface RawSymbolInfo {
  name?: string;
  kind?: number;
  containerName?: string;
  location?: { uri?: string; range?: { start?: { line: number; character: number } } };
}

/** 语言服务的符号搜索（连依赖 jar 里的类一起搜）。失败 / 没结果返回 null，由调用方退回工作区扫描。 */
async function langSymbols(
  query: string,
  ctx: PaletteCtx,
  accept: (kind: number) => boolean,
): Promise<PaletteItem[] | null> {
  if (!langReady()) return null;
  let res: unknown;
  try {
    res = await langRequest<unknown>("workspace/symbol", null, { query }, 20_000);
  } catch {
    return null;
  }
  if (!Array.isArray(res)) return null;
  const seen = new Set<string>();
  const items: PaletteItem[] = [];
  for (const s of res as RawSymbolInfo[]) {
    const uri = s.location?.uri;
    const pos = s.location?.range?.start;
    if (!s.name || !uri || !pos || !accept(s.kind ?? 0)) continue;
    const key = `${uri}#${s.name}#${pos.line}`;
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
  const fromLang = await langSymbols(q, ctx, (k) => TYPE_KINDS.has(k));
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

/** 工作区符号：方法 / 字段级搜索（IDEA 的 Ctrl+Alt+Shift+N）。 */
async function workspaceSymbolsMode(query: string, ctx: PaletteCtx): Promise<PaletteResult> {
  const q = query.trim();
  if (!q) return { items: [], note: "输入方法名或字段名（整个工作区 + 依赖 jar）" };
  if (!langReady()) return { items: [], note: "代码智能未就绪，工作区符号搜索需要它" };
  const items = await langSymbols(q, ctx, (k) => MEMBER_KINDS.has(k));
  if (!items) return { items: [], note: "没有匹配的方法或字段" };
  return { items, note: `方法与字段 · ${items.length} 项` };
}

function commandsMode(query: string): PaletteResult {  const q = query.trim();
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
    case "sym":
      return workspaceSymbolsMode(query, ctx);
    case "cmd":
      return commandsMode(query);
  }
}
