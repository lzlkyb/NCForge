import { useEffect, useMemo, useState } from "react";
import { Icon } from "../ui/icon";
import { Spinner } from "../ui/Spinner";
import { toast } from "../ui/toast";
import { copyText, formatBytes } from "../../lib/utils";
import {
  dictDocOf,
  mdDictExport,
  mdDictReveal,
  mdDictText,
  mdErrorText,
  type DocFormat,
  type ExportOut,
  type MdDictOut,
  type TableDict,
} from "../../lib/mdDict";

// 格式的展示名。只有这一处，按钮与提示语都从这里取。
const FMT_NAME: Record<DocFormat, string> = { csv: "CSV", md: "Markdown" };

/**
 * 右栏字典文档。
 *
 * 表卡片**默认全折叠**，展开才渲染列行：328 张 `bd_` 表 × 25 列 ≈ 8000 行，
 * 一次全铺出来是四万个格子，滚动会明显掉帧。折叠后同时只渲染展开的那几张。
 *
 * 抬头里的「缺中文名 N 列」不是装饰：本库实测有 15 列取不到中文名（多为二开自建列），
 * 交付前得知道这份字典的完整度，否则会以为「没中文名 = 这列不存在」。
 *
 * 导出与复制**都走后端渲染**（`nc_md_dict_text` / `nc_md_dict_export`）：CSV 的 BOM、
 * 转义、Markdown 的表格竖线转义都在 Rust 里有单测，前端再拼一份就是两套格式。
 */
export function MdDictResult({
  data,
  running,
  error,
}: {
  data: MdDictOut | null;
  running: boolean;
  error: string | null;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<DocFormat | null>(null);
  const [saved, setSaved] = useState<ExportOut | null>(null);

  const doc = useMemo(() => (data ? dictDocOf(data) : null), [data]);

  // 重新生成后上一份的落盘路径就不再对应当前内容了，别让它挂在抬头下面误导人
  useEffect(() => setSaved(null), [data]);

  const toggle = (name: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const copy = async (format: DocFormat) => {
    if (!doc) return;
    setBusy(format);
    try {
      const { text, bytes } = await mdDictText(doc, format);
      await copyText(
        text,
        () => toast(`已复制 ${FMT_NAME[format]} · ${formatBytes(bytes)}`, "success"),
        (e) => toast(`复制失败：${mdErrorText(e)}`, "error"),
      );
    } catch (e) {
      toast(mdErrorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const exportFile = async (format: DocFormat) => {
    if (!doc) return;
    setBusy(format);
    try {
      const out = await mdDictExport(doc, format);
      setSaved(out);
      toast(`已导出 ${out.name}`, "success");
    } catch (e) {
      toast(mdErrorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="md-fill" data-tone="bad">
        <Icon name="alertTriangle" size={18} />
        <p>{error}</p>
      </div>
    );
  }

  if (running && !data) {
    return (
      <div className="md-fill">
        <Spinner size={16} />
        <p>正在读库里的元数据…</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="md-fill">
        <Icon name="database" size={22} />
        <p>
          <b>还没生成</b>
        </p>
        <p>
          在左边找表勾选，或换成「前缀」「补丁涉及」；定好范围后点右上角<b>生成字典</b>。
        </p>
        <p>
          取的是库里的 <span className="md-mono">md_table / md_column / md_ormap</span> 元数据，
          所以二开扩展表和现场打的补丁表都有中文名。
        </p>
      </div>
    );
  }

  const withoutName = data.columnsWithoutName;
  const disabled = busy !== null;

  return (
    <>
      <div className="md-sum">
        <b>
          {data.tableCount} 张表 · {data.columnCount} 列
        </b>
        <span style={withoutName > 0 ? { color: "hsl(var(--warning-ink))" } : undefined}>
          缺中文名 {withoutName} 列
        </span>
        <span>{data.selection}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{data.elapsedMs}ms</span>
        <span className="md-sum-src" title={data.source}>
          {data.source}
        </span>
      </div>

      <div className="md-acts">
        <Icon name="download" size={12} />
        {(["csv", "md"] as const).map((f) => (
          <button
            key={f}
            type="button"
            className="md-act"
            disabled={disabled}
            onClick={() => void exportFile(f)}
          >
            导出 {FMT_NAME[f]}
          </button>
        ))}
        <span className="md-acts-sp" />
        <Icon name="copy" size={12} />
        {(["csv", "md"] as const).map((f) => (
          <button
            key={f}
            type="button"
            className="md-act"
            disabled={disabled}
            onClick={() => void copy(f)}
          >
            复制 {FMT_NAME[f]}
          </button>
        ))}
        {busy && <span className="md-act-busy">正在渲染 {FMT_NAME[busy]}…</span>}
      </div>

      {saved && (
        <div className="md-note" data-tone="info" role="status">
          <Icon name="check" size={12} style={{ marginTop: 2, flex: "none" }} />
          <span>
            已保存 <span className="md-mono">{saved.name}</span>（{formatBytes(saved.bytes)}）
            <button type="button" className="md-lk" onClick={() => void mdDictReveal(saved.path)}>
              打开所在文件夹
            </button>
          </span>
        </div>
      )}

      {data.missing.length > 0 && (
        <div className="md-note" data-tone="warn">
          <Icon name="alertTriangle" size={12} style={{ marginTop: 2, flex: "none" }} />
          <span>
            <b>{data.missing.length} 张表库里没有</b>
            ：{data.missing.slice(0, 6).join("、")}
            {data.missing.length > 6 ? ` 等${data.missing.length} 张` : ""}。没进这份字典。
          </span>
        </div>
      )}

      <div className="md-tables">
        {data.tables.map((t) => (
          <TableCard key={t.name} t={t} open={open.has(t.name)} onToggle={() => toggle(t.name)} />
        ))}
      </div>
    </>
  );
}

function TableCard({ t, open, onToggle }: { t: TableDict; open: boolean; onToggle: () => void }) {
  const ent =
    t.entities.length === 0
      ? null
      : t.entities.length === 1
        ? t.entities[0].className
        : `${t.entities.length} 个实体`;

  return (
    <div className="md-tcard">
      <button type="button" className="md-tcard-h" onClick={onToggle} aria-expanded={open}>
        <Icon name="chevronRight" size={12} className="md-caret" data-open={open || undefined} />
        <span className="md-tname">{t.name}</span>
        <span className="md-tcn">{t.displayName || "（无中文名）"}</span>
        {t.isExtend && <span className="md-tag-ext">扩展</span>}
        <span className="md-tmeta">
          {t.columns.length} 列{ent ? ` · ${ent}` : ""}
        </span>
      </button>

      {t.notes.length > 0 && (
        <div className="md-notes">
          {t.notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}

      {open && (
        <div className="md-cols">
          <div className="md-col" data-h>
            <span>列</span>
            <span>中文名</span>
            <span>类型</span>
            <span>键</span>
            <span>实体属性</span>
          </div>
          {t.columns.map((c) => (
            <div className="md-col" key={c.name}>
              <span className="md-mono" title={c.name}>
                {c.name}
              </span>
              <span className={c.displayName ? undefined : "md-none"} title={c.displayName}>
                {c.displayName || "（无中文名）"}
              </span>
              <span className="md-mono" title={c.type}>
                {c.type}
              </span>
              <span>{c.pkey ? <span className="md-pk">PK</span> : <span className="md-none">—</span>}</span>
              <span className="md-mono" title={c.props.map((p) => `${p.name} ${p.displayName}`).join("\n")}>
                {c.props.length > 0 ? (
                  c.props.map((p) => p.name).join(" / ")
                ) : (
                  <span className="md-none">—</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
