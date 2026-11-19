import { listCommands, type Command } from "./commandRegistry";
import { recentCommandIds, recordCommandUse } from "./commandUsage";
import { getFileIndex } from "./fileIndex";
import { fuzzyMatch, rankFiles, type FileEntry, type Range } from "./fuzzy";
import { matchText } from "./pinyin";
import { parseLineQuery, rankFilesRecent } from "./gotoAnything";
import { uriToPath } from "./langConvert";
import { failureText } from "./friendlyError";
import type { PaletteMode } from "./keymap";
import { getRecent } from "./recentFiles";
import { fetchSymbols, kindLetter, type FlatSymbol } from "./symbols";
import { isXmlFamily, ncDeclarationLabel } from "./ncDeclarationOutline";
import { jarTypeUri, searchSymbols, searchTypes, type SymbolHit, type SymbolSearchResult, type TypeHit } from "./typeSearch";
import { libraryUri, searchLibraryFiles, type LibraryHit, type LibraryOutcome } from "./libraryFiles";

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
  documentSymbols?: FlatSymbol[];
  methodsOnly?: boolean;
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
  const library = await libraryNames(q);
  const extra = library?.items.map(hit => libraryItem(hit, ctx)) ?? [];
  return {
    items: ranked.map((r) =>
      fileItem(r.entry, ctx, r.on === "name" ? { ranges: r.ranges } : { detail: r.entry.rel }),
    ).concat(extra),
    note: [ranked.length || extra.length ? `匹配 ${ranked.length + extra.length} 项` : "没有匹配的文件", library?.building ? "库文件目录准备中" : "", library?.truncated ? "库文件结果已截断" : ""].filter(Boolean).join(" · "),
  };
}

async function libraryNames(query: string, include = ""): Promise<LibraryOutcome | null> {
  try { return await searchLibraryFiles({ text: query, caseSensitive: false, wholeWord: false, regex: false, include, dirs: [] }, true, `library-names:${query.trim()}`); }
  catch { return null; }
}
function libraryItem(hit: LibraryHit, ctx: PaletteCtx): PaletteItem {
  return { key: libraryUri(hit), title: hit.entry.split("/").pop() ?? hit.entry,
    detail: `${hit.source}${hit.archive ? " ! " : "/"}${hit.entry}`, badge: hit.class ? "已编译" : "库文件", kind: hit.class ? "C" : undefined,
    run: () => ctx.run.jdt(libraryUri(hit), hit.line, 1) };
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
          path.startsWith("jdt://") || path.startsWith("nc-library://")
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
  qualifiedTypes = false,
): Promise<LangHit[] | null> {
  const { langReady, langRequest } = await import("./lang");
  if (!langReady()) return null;
  const qualified = qualifiedTypes && query.includes(".");
  const nameQuery = qualified ? query.slice(query.lastIndexOf(".") + 1) : query;
  const qualifiedQuery = query.toLowerCase();
  let res: unknown;
  try {
    // 4 秒。以前是 20 秒：面板上就一行「查询中…」，用户体感是卡死；而 jdt.ls 一旦
    // 索引没建完，等到 20 秒也只是拿到空结果。宁可早退回本地/文件名，也别让人干等。
    res = await langRequest<unknown>("workspace/symbol", null, { query: nameQuery }, 4_000);
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
    // JDT 按短名取候选；包名过滤必须先于 LIMIT，否则其他包的同名类会挤掉目标。
    if (qualified && !`${s.containerName ?? ""}.${s.name}`.toLowerCase().startsWith(qualifiedQuery)) continue;
    const key = `${uri}#${s.name}#${pos.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = pos.line + 1;
    const column = pos.character + 1;
    const path = uriToPath(uri);
    const hit = fuzzyMatch(nameQuery, s.name);
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
    .filter((r) => r.on === "name" || query.includes("."))
    .map((r) =>
      fileItem(r.entry, ctx, {
        title: r.entry.name.replace(/\.java$/, ""),
        ranges: r.on === "name" ? r.ranges : fuzzyMatch(query.replace(/\.java$/i, "").split(".").pop() ?? query, r.entry.name)?.ranges,
        kind: "C",
        badge: undefined,
      }),
    );
}

function typeHitItem(hit: TypeHit, ctx: PaletteCtx, query: string): PaletteItem {
  const ranges = fuzzyMatch(query.slice(query.lastIndexOf(".") + 1), hit.simple)?.ranges;
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
  const library = await libraryNames(q, "*.class");
  const loose = library?.items.filter(h => h.class && !h.archive).map(hit => libraryItem(hit, ctx)) ?? [];
  const extraJars = library?.items.filter(h => h.class && h.archive && !local?.jars.some(j => j.jar === h.source && j.name.replace(/\./g, "/") + ".class" === h.entry))
    .map(hit => libraryItem(hit, ctx)) ?? [];
  if (local && (local.workspace.length || local.jars.length) || loose.length || extraJars.length) {
    const items = (local?.workspace ?? []).map(h => typeHitItem(h, ctx, q)).concat(loose, (local?.jars ?? []).map(h => typeHitItem(h, ctx, q)), extraJars);
    const parts = [
      local?.workspace.length ? `工作区 ${local.workspace.length}` : "",
      local?.jars.length ? `依赖 jar ${local.jars.length}` : "",
      loose.length + extraJars.length ? `库类与散类 ${loose.length + extraJars.length}` : "",
      local?.jarsPending ? "依赖 jar 目录准备中" : "",
      library?.building ? "扩展类目录准备中" : "",
      local ? `${local.elapsedMs}ms` : "",
    ].filter(Boolean);
    return { items, note: `类型 · ${parts.join(" · ")}` };
  }
  const { getLangView, langReady } = await import("./lang");
  if (local?.indexing && !langReady()) {
    // 首次建索引要读完整个源码树（这台机器上近百秒），不能把用户扣在输入框前
    const items = await typeFileItems(q, ctx);
    return { items, note: items.length ? "正在建类索引，先按文件名匹配" : "正在建类索引，稍后再搜" };
  }
  const langState = getLangView().state;
  if (langState === "starting" || langState === "indexing") {
    // 本地没有结果、语言服务又在建索引：先给文件名结果，别让输入框空等。
    const items = await typeFileItems(q, ctx);
    const what = langState === "indexing" ? "索引中" : "启动中";
    return { items, note: `${what}，先按文件名匹配，结果可能不全` };
  }
  const hits = await langHits(q, ctx, (k) => TYPE_KINDS.has(k), true);
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
  if (!path || path.includes("://") || (!/\.java$/i.test(path) && !isXmlFamily(path))) {
    return { items: [], note: "先打开一个 Java 或 XML 文件" };
  }
  let symbols = ctx.documentSymbols;
  if (!symbols) {
    if (isXmlFamily(path)) {
      // XML 族没有语言服务，退回本地大纲（编辑模型）。动态引入：避免把 Monaco 拉进纯逻辑测试。
      const { currentDocumentOutline } = await import("./documentOutlineModel");
      symbols = currentDocumentOutline(path);
    } else {
      const { langReady } = await import("./lang");
      if (!langReady()) return { items: [], note: "代码智能未就绪，暂时列不出符号" };
      try {
        symbols = await fetchSymbols(path);
      } catch (e) {
        return { items: [], note: failureText("取符号", e) };
      }
    }
  }
  const q = query.trim();
  const items: PaletteItem[] = [];
  symbols.forEach((s, i) => {
    if (ctx.methodsOnly && /\.java$/i.test(path) && ![6, 9, 12].includes(s.kind)) return;
    const hit = q ? fuzzyMatch(q, s.name) : { score: 0, ranges: [] };
    if (!hit) return;
    items.push({
      key: `${i}:${s.name}`,
      title: s.name,
      ranges: hit.ranges,
      detail: `${s.container ? `${s.container} · ` : ""}第 ${s.line} 行`,
      kind: isXmlFamily(path) ? ncDeclarationLabel(s.kind) : kindLetter(s.kind),
      run: () => ctx.run.file(path, s.line, s.column),
    });
  });
  return { items: items.slice(0, 200), note: `当前文件符号 · ${items.length} 项${items.length > 200 ? "，请输入名称缩小范围" : ""}` };
}

/** 工作区符号：方法 / 字段级搜索（IDEA 的 Ctrl+Alt+Shift+N）。 */
async function workspaceSymbolsMode(query: string, ctx: PaletteCtx): Promise<PaletteResult> {
  const q = query.trim();
  if (!q) return { items: [], note: "输入方法名或字段名（整个工作区 + 依赖 jar）" };
  // 本地索引优先：它和类型索引是同一份，扫一次 `.java` 就把类声明和方法/字段都记下了，
  // 不用等 jdt.ls 建索引（那是 10 秒级）。依赖 jar 里的成员仍要语言服务，所以本地没
  // 结果时才问它——绝大多数「找方法」的目标都在工作区源码里。
  let local: SymbolSearchResult | null = null;
  try {
    local = await searchSymbols(q, LIMIT);
  } catch {
    // 后端不可用（未打开工程 / 索引损坏）：继续走语言服务
  }
  if (local && local.items.length) {
    const items = local.items.map((h) => symbolHitItem(h, ctx, q));
    const scope = local.total >= 200_000 ? "工作区" : `工作区 ${local.total} 个成员`;
    return { items, note: `方法与字段 · ${scope} · ${local.elapsedMs}ms` };
  }
  const { langReady } = await import("./lang");
  if (local?.indexing) {
    if (!langReady()) return { items: [], note: "正在建工作区符号索引，稍后再搜" };
  } else if (!langReady()) {
    return { items: [], note: local ? "工作区里没有匹配的方法或字段（依赖 jar 需要代码智能）" : "代码智能未就绪，暂时列不出符号" };
  }
  const items = await langSymbols(q, ctx, (k) => MEMBER_KINDS.has(k));
  if (!items) return { items: [], note: "没有匹配的方法或字段" };
  return { items, note: `方法与字段 · ${items.length} 项（含依赖 jar）` };
}

function symbolHitItem(hit: SymbolHit, ctx: PaletteCtx, query: string): PaletteItem {
  return {
    key: `sym:${hit.file}:${hit.line}:${hit.name}`,
    title: hit.name,
    ranges: fuzzyMatch(query, hit.name)?.ranges,
    detail: [hit.container, hit.module].filter(Boolean).join(" · "),
    kind: kindLetter(hit.kind),
    run: () => ctx.run.file(hit.file, hit.line, hit.column),
  };
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

/**
 * 生成快速导航条目；完整工程内容搜索由 searchRunner 执行。
 */
export async function buildItems(
  mode: PaletteMode,
  query: string,
  ctx: PaletteCtx,
): Promise<PaletteResult> {
  switch (mode) {
    case "search":
      return { items: [], note: "" };
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
