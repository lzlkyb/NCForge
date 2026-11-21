import { buildItems, libraryItem, type PaletteCtx, type PaletteItem, type PaletteResult } from "./paletteSources";
import { cancelSearch, searchProjectsStream, type ProjectSearchBatch } from "./search";
import { cancelLibrarySearch, searchLibraryFiles } from "./libraryFiles";
import { getRecent } from "./recentFiles";
import { getLinkedFileIndex, toEntry } from "./fileIndex";
import { rankFiles } from "./fuzzy";
import { isLineQuery } from "./gotoAnything";
import { buildSearchPreview } from "./searchPreview";

const LIMIT = 9;
let nextQuery = 0;
export type PaletteGroup = "正文" | "文件" | "类型与符号" | "命令";
export type GroupedItem = PaletteItem & { group?: PaletteGroup };
type Source = "files" | "linked" | "libraryNames" | "types" | "document" | "symbols" | "commands" | "body" | "library";
const groups: Record<Source, PaletteGroup> = {
  files: "文件", linked: "文件", libraryNames: "文件", types: "类型与符号", document: "类型与符号", symbols: "类型与符号", commands: "命令",
  body: "正文", library: "正文",
};
const labels: Record<Source, string> = {
  files: "文件", linked: "关联工程文件", libraryNames: "依赖库名称", types: "类型", document: "当前文件符号", symbols: "工作区符号",
  commands: "命令", body: "工程正文", library: "依赖库正文",
};

/** Quick navigation previews are isolated from the full search form and its replace criteria. */
export function startUnifiedPalette(query: string, ctx: PaletteCtx, publish: (result: PaletteResult, pending: boolean) => void) {
  const q = query.trim();
  const lineQuery = isLineQuery(q);
  const namedQuery = q && !lineQuery && !q.includes("\n");
  const id = `palette-unified:${++nextQuery}`;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const results = new Map<Source, PaletteItem[]>();
  const waiting = new Set<Source>();
  const warnings = new Map<Source, string>();
  const failures = new Set<Source>();
  const localContext = { ...ctx, skipLibraryNames: true };
  const update = () => {
    if (!active) return;
    const items: GroupedItem[] = [];
    const seen = new Set<string>();
    const order: PaletteGroup[] = ["正文", "文件", "类型与符号", "命令"];
    // Exact names outrank prose. A fuzzy file result cannot hide a literal text match.
    const exact = (source: Source) => results.get(source)?.some(item => item.title.toLowerCase() === q.toLowerCase());
    if (exact("files") || exact("linked") || exact("libraryNames")) order.splice(0, 3, "文件", "正文", "类型与符号");
    else if (exact("types") || exact("document") || exact("symbols")) order.splice(0, 3, "类型与符号", "正文", "文件");
    else if (exact("commands")) order.unshift(...order.splice(order.indexOf("命令"), 1));
    for (const group of order) {
      let count = 0;
      const candidates = (Object.keys(groups) as Source[]).filter(source => groups[source] === group)
        .flatMap(source => results.get(source) ?? []);
      if (group !== "正文") candidates.sort((a, b) => Number(b.title.toLowerCase() === q.toLowerCase()) - Number(a.title.toLowerCase() === q.toLowerCase()));
      for (const item of candidates) {
        const key = `${group}:${item.key}`;
        if (seen.has(key)) continue;
        items.push({ ...item, group, key });
        seen.add(key);
        if (++count >= LIMIT) break;
      }
    }
    const note = [...new Set(warnings.values())].join(" · ") || (!items.length && !waiting.size ?
      query.trim() ? "没有匹配的结果" : ctx.root ? "输入关键词以搜索当前与关联工程" : "尚未打开工程" : "");
    publish({ items, note, retryable: !items.length && failures.size > 0 }, waiting.size > 0);
  };
  const execute = (source: Source, read: () => Promise<PaletteResult>) => {
    waiting.add(source);
    return () => {
      if (!active) return;
      void Promise.resolve().then(read).then(result => {
        if (!active) return;
        results.set(source, result.items);
        if (result.note.includes("失败")) failures.add(source);
        if (lineQuery || /准备中|未就绪|建.*索引|截断|未查全|失败/.test(result.note)) {
          warnings.set(source, groups[source] === "类型与符号" ? "部分类型与符号暂不可用" : result.note);
        }
      }, () => {
        if (active) {
          failures.add(source);
          warnings.set(source, `${labels[source]}查询失败`);
        }
      }).finally(() => { waiting.delete(source); update(); });
    };
  };
  const immediate = [
    ...(q.includes("\n") ? [] : [execute("files", () => buildItems("file", q, localContext))]),
    ...(namedQuery ? [execute("commands", () => buildItems("cmd", q, ctx))] : []),
  ];
  const deferred = namedQuery ? [
    execute("types", () => buildItems("type", q, localContext)),
    execute("document", () => buildItems("symbol", q, ctx)),
    execute("symbols", () => buildItems("sym", q, ctx)),
  ] : [];
  if (q && !lineQuery && ctx.root) {
    const root = ctx.root.replace(/[\\/]+$/, "").replace(/\\/g, "/");
    const priority = [ctx.activePath, ...getRecent(ctx.root)].flatMap(path => {
      const normalized = path?.replace(/\\/g, "/");
      return normalized?.toLowerCase().startsWith(root.toLowerCase() + "/") ? [normalized.slice(root.length + 1)] : [];
    }).slice(0, 12);
    const options = { text: q, maxResults: 32, priority };
    if (!q.includes("\n")) deferred.push(execute("linked", async () => {
      const outcome = await getLinkedFileIndex(ctx.root!);
      const items = (outcome.projects ?? []).flatMap(project => rankFiles(project.files.map(rel => toEntry(project.root.replace(/[\\/]+$/, ""), rel)), q, LIMIT).map(({ entry, ranges, on }) => ({
        key: entry.path, title: entry.name, detail: `${project.name} · ${on === "name" ? entry.dir : entry.rel}`,
        ranges: on === "name" ? ranges : undefined,
        run: () => (ctx.run.projectFile ?? ctx.run.file)(entry.path, 1, 1),
      })));
      return { items, note: outcome.errors?.length || outcome.truncated ? "关联工程文件未查全" : "" };
    }), execute("libraryNames", async () => {
      const outcome = await searchLibraryFiles(options, true, `${id}:names`);
      return { items: outcome.items.map(hit => libraryItem(hit, ctx)), note: outcome.error ? "依赖库名称查询失败" : outcome.building ? "依赖库目录准备中" : "" };
    }));
    deferred.push(execute("body", async () => {
      const batches = new Map<string, PaletteItem>();
      const add = ({ root, project, hits }: Omit<ProjectSearchBatch, "stream">) => {
        for (const hit of hits) {
          const path = `${root.replace(/[\\/]+$/, "")}/${hit.path}`;
          const key = JSON.stringify([root, hit.path, hit.line, hit.column]);
          if (batches.has(key)) continue;
          const preview = buildSearchPreview(hit.text, hit.ranges);
          batches.set(key, { key, title: preview.text, detail: `${project} · ${hit.path}:${hit.line}`,
            ranges: preview.ranges.map(range => [range.start, range.end]),
            run: () => (ctx.run.projectFile ?? ctx.run.file)(path, hit.line, hit.column ?? (hit.ranges[0]?.start ?? 0) + 1) });
        }
      };
      const outcome = await searchProjectsStream(options, batch => {
        if (!active) return;
        add(batch);
        results.set("body", [...batches.values()]);
        update();
      }, id, () => active);
      for (const project of outcome.projects) add({ ...project, hits: project.outcome.hits });
      return { items: [...batches.values()], note: [
        outcome.truncated ? "工程正文未查全，可查看完整搜索" : "",
        outcome.errors.length ? `${outcome.errors.length} 个工程搜索失败` : "",
      ].filter(Boolean).join(" · ") };
    }));
    deferred.push(execute("library", async () => {
      const outcome = await searchLibraryFiles(options, false, id);
      return { items: outcome.items.map(hit => {
        const preview = buildSearchPreview(hit.text, hit.ranges);
        return { key: JSON.stringify([hit.source, hit.entry, hit.line]), title: preview.text || hit.entry,
          detail: `依赖库 · ${hit.entry}:${hit.line}`, ranges: preview.ranges.map(range => [range.start, range.end]),
          run: () => ctx.run.library?.(hit) };
      }), note: outcome.error ? "依赖库正文查询失败" : outcome.building ? "依赖库目录准备中"
        : outcome.stale || outcome.truncated || outcome.skipped ? "依赖库正文未查全" : "" };
    }));
  }
  immediate.forEach(run => run());
  if (deferred.length) timer = setTimeout(() => {
    timer = undefined;
    deferred.forEach(run => run());
  }, 180);
  update();
  return () => {
    active = false;
    if (timer) { clearTimeout(timer); return; }
    if (waiting.has("body")) void cancelSearch(id);
    if (waiting.has("library")) void cancelLibrarySearch(id);
    if (waiting.has("libraryNames")) void cancelLibrarySearch(`${id}:names`);
  };
}
