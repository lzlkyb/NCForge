import { listCommands, type Command } from "./commandRegistry";
import { recentCommandIds, recordCommandUse } from "./commandUsage";
import { getFileIndex } from "./fileIndex";
import { fuzzyMatch, rankFiles, type FileEntry, type Range } from "./fuzzy";
import { matchText } from "./pinyin";
import { parseLineQuery, rankFilesRecent, recentFirst } from "./gotoAnything";
import { getLangView, langReady, langRequest } from "./lang";
import { uriToPath } from "./langConvert";
import type { PaletteMode } from "./keymap";
import { getRecent } from "./recentFiles";
import { searchWorkspace } from "./search";
import { fetchSymbols, kindLetter } from "./symbols";
import { jarTypeUri, searchTypes, type TypeHit } from "./typeSearch";

/** 快速面板 `#内容` 搜索在后端的来源标识：同来源新搜索顺带取消旧的。 */
export const PALETTE_SEARCH_SOURCE = "palette";

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
    // 每改一次词就是一次全量扫描：按来源登记，新的一发出，后端就停掉旧的
    out = await searchWorkspace({ text, maxResults: LIMIT }, false, PALETTE_SEARCH_SOURCE);
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

/** 一条语言服务命中，附带按全限定名去重时用的优先级。 */
interface LangHit {
  item: PaletteItem;
  /** 包名 + 类名；同名的已编译副本 / jar 副本靠它合并。 */
  fq: string;
  /** 0 = 工作区源码，1 = 工作区已编译产物，2 = 依赖 jar。 */
  rank: number;
}

/**
 * `jdt://contents/<容器>/...` 的容器是 jar 时是「依赖」，否则是工作区里已编译的类目录。
 *
 * 以前一律标 `jar`，而 `BaseDaoUtils` 其实来自 `out/baseapp` 这类类目录——用户据此
 * 以为工程里没有这个类。容器里的百分号转义（盘符、空格）先解开再判断。
 */
function jdtBadge(uri: string): { badge: string; rank: number } {
  const path = uri.split("?")[0];
  const prefix = "jdt://contents/";
  const container = path.startsWith(prefix) ? path.slice(prefix.length).split("/")[0] : "";
  let decoded = container;
  try {
    decoded = decodeURIComponent(container);
  } catch {
    // 不合法转义：按原文判断
  }
  return decoded.toLowerCase().endsWith(".jar")
    ? { badge: "依赖", rank: 2 }
    : { badge: "已编译", rank: 1 };
}

/** 语言服务的符号搜索（连依赖 jar 里的类一起搜）。失败 / 没结果返回 null，由调用方退回工作区扫描。 */
async function langHits(
  query: string,
  ctx: PaletteCtx,
  accept: (kind: number) => boolean,
): Promise<LangHit[] | null> {
  if (!langReady()) return null;
  let res: unknown;
  try {
    res = await langRequest<unknown>("workspace/symbol", null, { query }, 20_000);
  } catch {
    return null;
  }
  if (!Array.isArray(res)) return null;
  const seen = new Set<string>();
  const hits: LangHit[] = [];
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
    const kind = path ? { badge: undefined, rank: 0 } : jdtBadge(uri);
    hits.push({
      fq: `${s.containerName ?? ""}#${s.name}`,
      rank: kind.rank,
      item: {
        key,
        title: s.name,
        ranges: hit?.ranges,
        detail: s.containerName,
        kind: kindLetter(s.kind ?? 0),
        badge: kind.badge,
        run: () => (path ? ctx.run.file(path, line, column) : ctx.run.jdt(uri, line, column)),
      },
    });
    if (hits.length >= LIMIT) break;
  }
  return hits.length ? hits : null;
}

async function langSymbols(
  query: string,
  ctx: PaletteCtx,
  accept: (kind: number) => boolean,
): Promise<PaletteItem[] | null> {
  return (await langHits(query, ctx, accept))?.map((h) => h.item) ?? null;
}

/** 同一个类只留一份：工作区源码 > 工作区已编译产物 > 依赖 jar，其余副本折成一句说明。 */
function dedupeTypes(hits: LangHit[]): PaletteItem[] {
  const groups = new Map<string, { at: number; hit: LangHit; copies: Set<string> }>();
  const out: LangHit[] = [];
  for (const h of hits) {
    const prev = groups.get(h.fq);
    if (!prev) {
      groups.set(h.fq, { at: out.length, hit: h, copies: new Set() });
      out.push(h);
      continue;
    }
    if (h.rank < prev.hit.rank) {
      if (prev.hit.item.badge) prev.copies.add(prev.hit.item.badge);
      prev.hit = h;
      out[prev.at] = h;
    } else if (h.item.badge && h.item.badge !== prev.hit.item.badge) {
      prev.copies.add(h.item.badge);
    }
  }
  for (const g of groups.values()) {
    if (!g.copies.size) continue;
    const note =
      g.copies.size === 1
        ? `另有${[...g.copies][0]}副本`
        : `另有 ${g.copies.size} 个其它副本`;
    const detail = g.hit.item.detail;
    g.hit.item.detail = detail ? `${detail} · ${note}` : note;
  }
  return out.map((h) => h.item);
}

async function typeFileItems(query: string, ctx: PaletteCtx): Promise<PaletteItem[]> {
  if (!ctx.root) return [];
  const javas = (await getFileIndex(ctx.root)).filter((e) => e.name.endsWith(".java"));
  return rankFiles(javas, query, LIMIT)
    .filter((r) => r.on === "name")
    .map((r) =>
      fileItem(r.entry, ctx, {
        title: r.entry.name.replace(/\.java$/, ""),
        ranges: r.ranges,
        kind: "C",
        badge: undefined,
      }),
    );
}

function typeHitItem(hit: TypeHit, ctx: PaletteCtx, query: string): PaletteItem {
  const ranges = fuzzyMatch(query, hit.simple)?.ranges;
  if (hit.file) {
    return {
      key: `type:ws:${hit.file}:${hit.line}:${hit.name}`,
      title: hit.simple,
      ranges,
      detail: [hit.package, hit.module].filter(Boolean).join(" · "),
      badge: "工作区",
      kind: kindLetter(hit.kind),
      run: () => ctx.run.file(hit.file, hit.line, hit.column),
    };
  }
  const jarName = hit.jar.split(/[\\/]/).pop();
  return {
    key: `type:jar:${hit.jar}:${hit.name}`,
    title: hit.simple,
    ranges,
    detail: [hit.package, jarName].filter(Boolean).join(" · "),
    badge: "依赖",
    kind: kindLetter(hit.kind),
    run: () => ctx.run.jdt(jarTypeUri(hit), hit.line, hit.column),
  };
}

async function typesMode(query: string, ctx: PaletteCtx): Promise<PaletteResult> {
  const q = query.trim();
  if (!q) return { items: [], note: "输入类名（支持驼峰首字母，如 VBO）" };
  // 本地索引不依赖语言服务：第一次搜类也不用等 jdt.ls 建索引
  let local = null;
  try {
    local = await searchTypes(q, LIMIT);
  } catch {
    // 后端不可用（未打开工程 / 命令失败）：继续走语言服务
  }
  if (local && (local.workspace.length || local.jars.length)) {
    const items = [...local.workspace, ...local.jars].map((h) => typeHitItem(h, ctx, q));
    const parts = [
      local.workspace.length ? `工作区 ${local.workspace.length}` : "",
      local.jars.length ? `依赖 jar ${local.jars.length}` : "",
      local.jarsPending ? "依赖 jar 目录准备中" : "",
      `${local.elapsedMs}ms`,
    ].filter(Boolean);
    return { items, note: `类型 · ${parts.join(" · ")}` };
  }
  const langState = getLangView().state;
  if (langState === "starting" || langState === "indexing") {
    // 本地没有结果、语言服务又在建索引：先给文件名结果，别让输入框空等。
    const items = await typeFileItems(q, ctx);
    const what = langState === "indexing" ? "索引中" : "启动中";
    return { items, note: `${what}，先按文件名匹配，结果可能不全` };
  }
  const hits = await langHits(q, ctx, (k) => TYPE_KINDS.has(k));
  if (hits) {
    const items = dedupeTypes(hits);
    return { items, note: `工作区与依赖 jar 中的类型 · ${items.length} 项` };
  }
  // 退回：只在工作区里找「文件名 = 类名」的 .java（代码智能未就绪、或它没给结果）
  if (!ctx.root) return { items: [], note: "尚未打开工程" };
  const items = await typeFileItems(q, ctx);
  const note = langReady() ? "语言服务没有结果，已退回工作区文件名搜索" : "代码智能未就绪，只搜工作区里的类";
  return { items, note: items.length ? note : "没有匹配的类" };
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

function commandItem(c: Command, extra: Partial<PaletteItem> = {}): PaletteItem {
  return {
    key: c.id,
    title: c.title,
    hint: c.hint,
    // 从面板执行才算「用过」：这是命令面板自己的排序依据，不影响真实调用。
    run: () => {
      recordCommandUse(c.id);
      c.run();
    },
    ...extra,
  };
}

function commandsMode(query: string): PaletteResult {
  const q = query.trim();
  const commands = listCommands();
  if (!q) {
    const byId = new Map(commands.map((c) => [c.id, c]));
    const recent = recentCommandIds()
      .map((id) => byId.get(id))
      .filter((c): c is Command => !!c);
    const used = new Set(recent.map((c) => c.id));
    const items = [
      ...recent.map((c) => commandItem(c, { badge: "最近" })),
      ...commands.filter((c) => !used.has(c.id)).map((c) => commandItem(c)),
    ];
    return {
      items,
      note: recent.length ? `最近使用 ${recent.length} 项 · 共 ${items.length} 条命令` : `全部命令 · ${items.length} 项`,
    };
  }
  // 中文标题支持拼音首字母（`bydqmk` → 编译当前模块），原文命中优先取高分。
  const items: { item: PaletteItem; score: number }[] = [];
  for (const c of commands) {
    const hit = matchText(q, c.title);
    if (hit) items.push({ item: commandItem(c, { ranges: hit.ranges }), score: hit.score });
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
