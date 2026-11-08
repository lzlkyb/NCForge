import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import type { Cell, ColumnMeta } from "../../lib/dbApi";
import { isLobPreview, lobPreviewChars } from "../../lib/db";
import { decodeCell, decodeSqlTemplate, describeDecoded } from "../../lib/cellCodec";
import { copyText } from "../../lib/utils";
import "../../db-grid-inspector.css";

function prettyJson(s: string): string | null {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

/**
 * 「加载完整值」的取数器。由结果表提供——它才知道连接、SQL 与**原始行下标**。
 * 结果集里 CLOB 只带前 8K 字符的预览（否则 500 行大文本会撑爆 16MB 结果预算）。
 */
export interface LobLoader {
  canLoad: boolean;
  load: () => Promise<{ value: string; chars: number; truncated: boolean }>;
}

/**
 * 单元格详情：长文本 / CLOB 看全，可切 JSON 格式化。
 *
 * 另外认「二次编码」：有些系统把 JSON 转成十六进制存进 CLOB（NC 的
 * `UAPBD_LOG_H.JSON` 就是），这里给一键解码视图。解码只影响这一屏，
 * 「复制原值」拿到的始终是库里的原串。
 */
export function CellDetail({ column, zh, row, value, empty, lob, sql, onClose }: {
  column: ColumnMeta | null;
  zh?: string;
  row: number | null;
  value: Cell;
  empty: boolean;
  lob?: LobLoader;
  /** 产生这一格的 SQL：用来生成「在 SQL 里解码」的模板。不传就没有这个入口。 */
  sql?: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<"raw" | "json" | "whitespace" | "decoded">("raw");
  const [full, setFull] = useState<{ value: string; chars: number; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const contentRef=useRef<HTMLPreElement>(null), infoId=useId();
  // 加载完整值是异步的：切到别的格子后，旧的请求不能再把结果写进面板。
  const reqRef = useRef(0);
  const baseText = value === null ? "" : String(value);
  // 长度先取出来：`isLobPreview` 是类型谓词，`preview || baseText.length` 里
  // 右侧会被 TypeScript 收窄成 never（false 分支 = 不是 string，而它本来就是 string）。
  const baseLength = baseText.length;
  // 加载完整值之后一律用完整值展示：复制、JSON 格式化、显示空白都跟着它走。
  const text = full?.value ?? baseText;
  const preview = isLobPreview(baseText);
  const total = lobPreviewChars(baseText);
  const pretty = useMemo(()=>prettyJson(text),[text]);
  // 手动态（默认）：允许 GBK 与短串，面板上会标出编码和字节数，用户是明确点的。
  const decoded = useMemo(()=>decodeCell(text),[text]);
  // 解出来是 JSON 就直接漂亮化——两段式（先解码再点 JSON）没人愿意点两次。
  const decodedShown = useMemo(()=>decoded ? (decoded.json ? prettyJson(decoded.text) ?? decoded.text : decoded.text) : null,[decoded]);
  const onlyWhitespace=!empty && value!==null && text.length>0 && !/\S/.test(text);
  const valueInfo=empty ? "" : value===null ? "NULL · 数据库空值" : text.length===0 ? "空字符串 · 0 字符"
    : `${onlyWhitespace ? "仅空白字符 · " : ""}${text.length} 字符${full ? " · 完整值" : preview ? " · 预览" : ""}`;
  const shown=view==="decoded" ? decodedShown ?? text : view==="json" ? pretty ?? text : view==="whitespace" ? text.replace(/[\t\r\n ]/g,c=>c===" " ? "·" : c==="\t" ? "⇥" : c==="\r" ? "␍" : "↵\n") : text;
  useEffect(()=>{
    reqRef.current++;
    setView("raw");
    setFull(null);
    setLoadError(null);
    setLoading(false);
  },[column?.name,row,value]);
  useLayoutEffect(()=>{
    contentRef.current?.focus({preventScroll:true});
    contentRef.current?.scrollIntoView?.({block:"nearest",inline:"nearest"});
  },[]);

  const loadFull = async () => {
    if (!lob?.canLoad || loading || full) return;
    const token = ++reqRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const r = await lob.load();
      if (token === reqRef.current) setFull(r);
    } catch (e) {
      if (token === reqRef.current) setLoadError(String(e));
    } finally {
      if (token === reqRef.current) setLoading(false);
    }
  };
  const canLoad = !!lob?.canLoad && !empty && (preview || baseLength >= 4096);
  const copySql = () => {
    if (!sql || !column) return;
    void copyText(decodeSqlTemplate(sql, column.name), () => toast("解码 SQL 已复制", "success"), (e) => toast(`复制失败：${e}`, "error"));
  };

  return (
    <div className="dbx-detail" role="region" aria-label="单元格详情" onKeyDown={e=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();onClose();}}}>
      <div className="hd">
        <div style={{ flex: 1, minWidth: 0 }}>
          {empty || !column ? (
            <span className="dbx-muted">选择单元格查看完整原值</span>
          ) : (
            <>
              <b>{column.name.toLowerCase()}</b>
              <div className="s" id={infoId}>
                {[zh, column.type, `第 ${row} 行`, valueInfo].filter(Boolean).join(" · ")}
              </div>
            </>
          )}
        </div>
        <button type="button" className="dbx-ibtn" aria-label="关闭详情" title="关闭详情 · Esc" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      {view!=="raw" && view!=="decoded" && <div className="dbx-detail-note" role="status">{view==="json" ? "JSON 仅格式化展示" : "· 空格　⇥ 制表符　␍ 回车　↵ 换行"}；复制保留原值。</div>}
      {view==="decoded" && decoded && (
        <div className="dbx-detail-note" role="status">
          {describeDecoded(decoded)}。{decoded.json ? "已按 JSON 格式化；" : ""}这是解码后的内容，「复制原值」拿到的仍是库里的编码串。
          {sql && column && <button type="button" className="dbx-lk" onClick={copySql}>复制解码 SQL</button>}
        </div>
      )}
      {preview && !full && !loadError && (
        <div className="dbx-detail-note" role="status">
          当前是预览（前 8K 字符{total ? `，原值共 ${total} 字符` : ""}）。完整值要按原 SQL 重查这一行。
          {decoded && !decoded.complete && "解码结果末尾可能不完整。"}
        </div>
      )}
      {loadError && <div className="dbx-detail-note" role="alert">{loadError}</div>}
      <pre ref={contentRef} tabIndex={0} aria-label="单元格完整值" aria-describedby={!empty && column ? infoId : undefined} className={value === null ? "dbx-muted" : undefined}>{empty ? "" : value === null ? "NULL" : shown}</pre>
      <div className="ft">
        <button type="button" className="dbx-btn ghost" disabled={empty || value === null} onClick={() => void copyText(text, () => toast("已复制原值", "success"), (e) => toast(`复制失败：${e}`, "error"))}>
          <Icon name="copy" size={12} />
          复制原值
        </button>
        {decoded && view==="decoded" && (
          <button type="button" className="dbx-btn ghost" data-on onClick={() => void copyText(decoded.text, () => toast("已复制解码结果", "success"), (e) => toast(`复制失败：${e}`, "error"))}>
            <Icon name="copy" size={12} />
            复制解码后
          </button>
        )}
        {canLoad && (
          <button type="button" className="dbx-btn ghost" data-on={full ? true : undefined} disabled={loading || !!full}
            title={full?.truncated ? "已达 1MB 读取上限" : "按当前 SQL 重查这一行，取回完整值"}
            onClick={() => void loadFull()}>
            <Icon name="download" size={12} />
            {loading ? "加载中…" : full ? (full.truncated ? "已加载（达 1MB 上限）" : "已加载完整值") : "加载完整值"}
          </button>
        )}
        {decoded && (
          <button type="button" className="dbx-btn ghost" data-on={view==="decoded" || undefined} aria-pressed={view==="decoded"}
            title={`${describeDecoded(decoded)} · 只影响这一屏，原值与复制都不变`}
            onClick={() => setView(view==="decoded" ? "raw" : "decoded")}>
            <Icon name="code" size={12} />
            {view==="decoded" ? "看原始编码" : "解码显示"}
          </button>
        )}
        <button type="button" className="dbx-btn ghost" data-on={view==="json" || undefined} aria-pressed={view==="json"} disabled={empty || pretty===null} onClick={() => setView(view==="json" ? "raw" : "json")}>
          JSON 格式化
        </button>
        <button type="button" className="dbx-btn ghost" data-on={view==="whitespace" || undefined} aria-pressed={view==="whitespace"} disabled={empty || !/\s/.test(text)} onClick={()=>setView(view==="whitespace" ? "raw" : "whitespace")}>显示空白</button>
      </div>
    </div>
  );
}
