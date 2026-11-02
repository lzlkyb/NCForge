import { useEffect, useMemo, useState } from "react";
import { toast } from "../ui/toast";
import { Icon } from "../ui/icon";
import { cleanError, joinPath, readFile } from "../../lib/workspace";
import type { SearchHit } from "../../lib/search";

interface Row {
  path: string;
  line: number;
  /** 打开预览时读到的整行原文；保存前用它挡住「搜索后文件又变了」。 */
  original: string;
}

const keyOf = (r: Row) => `${r.path}\u0000${r.line}`;

/**
 * 搜索结果的可编轻量预览：所有命中行放在一张“多缓冲”里，逐行改完一次写回。
 *
 * 只支持改命中行本身（不增删行）：这样行号始终对得上，失败时也能精确到某一行。
 * 编码 / 换行无法无损写回、编辑器里有未保存改动、行内容已变化的情况会跳过并说明。
 */
export function SearchEditPanel({
  hits,
  root,
  onClose,
}: {
  hits: SearchHit[];
  root: string;
  /** 关闭预览；`refresh` 为真时调用方要重新搜索（有行真的写回了）。 */
  onClose: (refresh?: boolean) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAny, setSavedAny] = useState(false);

  // 每个文件只读一次：命中行的截断文本不够拿来编辑，必须取磁盘上的整行。
  useEffect(() => {
    let dead = false;
    const byPath = new Map<string, number[]>();
    for (const h of hits) {
      const list = byPath.get(h.path) ?? [];
      if (!list.includes(h.line)) list.push(h.line);
      byPath.set(h.path, list);
    }
    void (async () => {
      const nextRows: Row[] = [];
      const nextIssues: string[] = [];
      for (const [path, lineNums] of byPath) {
        try {
          const content = await readFile(joinPath(root, path.replace(/\//g, "\\")));
          const lines = content.text.split("\n");
          for (const line of lineNums) {
            if (line < 1 || line > lines.length) nextIssues.push(`${path}:${line}：文件里已没有这一行`);
            else nextRows.push({ path, line, original: lines[line - 1] });
          }
        } catch (e) {
          nextIssues.push(`${path}：${cleanError(e)}`);
        }
      }
      if (dead) return;
      setRows(nextRows);
      setIssues(nextIssues);
      setLoading(false);
    })();
    return () => {
      dead = true;
    };
  }, [hits, root]);

  const groups = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of rows) {
      const list = map.get(r.path);
      if (list) list.push(r);
      else map.set(r.path, [r]);
    }
    return [...map.entries()];
  }, [rows]);

  const changed = rows.filter((r) => (drafts[keyOf(r)] ?? r.original) !== r.original);

  const save = async () => {
    if (saving || changed.length === 0) return;
    setSaving(true);
    try {
      // 动态加载：写回链路要连编辑器仓库，只有点「保存」时才需要，
      // 不该拖进搜索页首次打开的模块图。
      const { saveLineEdits } = await import("../../lib/searchEdit");
      const r = await saveLineEdits(
        root,
        rows.map((row) => ({
          path: row.path,
          line: row.line,
          original: row.original,
          value: drafts[keyOf(row)] ?? row.original,
        })),
      );
      if (r.filesChanged === 0) {
        setIssues(r.skipped.length ? r.skipped : ["没有可保存的改动"]);
        toast("没有写回任何内容，原因见预览顶部", "warning");
        return;
      }
      if (r.skipped.length === 0) {
        toast(`已保存 ${r.linesChanged} 行（${r.filesChanged} 个文件）`, "success");
        onClose(true);
        return;
      }
      // 部分写回：把已保存的行换成新的原文并清掉草稿，停留在预览里把跳过原因逐条摆出来。
      const done = new Set(r.saved.map((s) => `${s.path}\u0000${s.line}`));
      setRows((prev) =>
        prev.map((row) => {
          const s = r.saved.find((x) => x.path === row.path && x.line === row.line);
          return s ? { ...row, original: s.value } : row;
        }),
      );
      setDrafts((prev) => {
        const next = { ...prev };
        done.forEach((k) => delete next[k]);
        return next;
      });
      setIssues([`已保存 ${r.linesChanged} 行；以下 ${r.skipped.length} 处未写回：`, ...r.skipped]);
      setSavedAny(true);
      toast(`已保存 ${r.linesChanged} 行，${r.skipped.length} 处跳过，原因见预览顶部`, "warning");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose(savedAny);
        }
      }}
    >
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-[12px]">
        <span className="font-semibold">编辑匹配（轻量）</span>
        <span className="text-muted-foreground">
          只改命中行，不能增删行；每行按原文写回，冲突与不安全编码会跳过
        </span>
        <span className="flex-1" />
        <button
          type="button"
          disabled={saving || changed.length === 0}
          onClick={() => void save()}
          className="rounded bg-primary px-2 py-0.5 font-semibold text-primary-foreground disabled:opacity-50"
        >
          {saving ? "保存中…" : `保存 ${changed.length} 行`}
        </button>
        <button
          type="button"
          onClick={() => onClose(savedAny)}
          className="rounded px-2 py-0.5 hover:bg-secondary"
        >
          {savedAny ? "关闭" : "取消"}
        </button>
      </div>

      {issues.length > 0 && (
        <ul className="max-h-24 flex-shrink-0 overflow-auto border-b border-border bg-warning/10 px-3 py-1.5 text-[11.5px] text-warning-ink">
          {issues.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && <div className="px-3 py-3 text-[12px] text-muted-foreground">正在读取命中行…</div>}
        {!loading && rows.length === 0 && issues.length === 0 && (
          <div className="px-3 py-3 text-[12px] text-muted-foreground">没有可编辑的命中行。</div>
        )}
        {groups.map(([path, list]) => (
          <div key={path} className="border-b border-border">
            <div className="flex items-center gap-1.5 bg-secondary/40 px-3 py-1">
              <Icon name="file" size={13} className="text-primary" />
              <span className="text-[12px] font-semibold">{path}</span>
              <span className="ml-auto text-[11px] text-muted-foreground">{list.length} 行</span>
            </div>
            {list.map((row) => {
              const key = keyOf(row);
              const value = drafts[key] ?? row.original;
              const isChanged = value !== row.original;
              return (
                <div
                  key={key}
                  data-changed={isChanged || undefined}
                  className="wb-sedit-row grid grid-cols-[46px_minmax(0,1fr)] items-center gap-2 px-3 py-[3px]"
                >
                  <span className="text-right font-mono text-[11.5px] text-muted-foreground">
                    {row.line}
                  </span>
                  <input
                    type="text"
                    spellCheck={false}
                    aria-label={`${path} 第 ${row.line} 行`}
                    value={value}
                    onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                    className="w-full rounded border border-transparent bg-transparent px-1.5 py-0.5 font-mono text-[12px] outline-none hover:border-border focus:border-primary focus:bg-background"
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
