import { JsonInspector } from "./JsonInspector";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { Modal } from "../ui/Modal";
import { toast } from "../ui/toast";
import type { Cell, ColumnMeta } from "../../lib/dbApi";
import { isLobPreview, lobPreviewChars } from "../../lib/db";
import { binaryColumn, binaryPreview, decodeCell, decodeSqlTemplate, describeDecoded, type TextEncoding } from "../../lib/cellCodec";
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
  const [mode, setView] = useState<"auto" | "raw" | "json" | "whitespace" | "decoded">("auto");
  const [encoding, setEncoding] = useState<TextEncoding | undefined>();
  const [full, setFull] = useState<{ value: string; chars: number; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 放大到独立大窗：340px 侧栏读一千多字的报错堆栈太窄。 */
  const [expanded, setExpanded] = useState(false);
  const contentRef=useRef<HTMLPreElement>(null), infoId=useId();
  // 加载完整值是异步的：切到别的格子后，旧的请求不能再把结果写进面板。
  const reqRef = useRef(0);
  const baseText = value === null ? "" : String(value);
  // 长度先取出来：`isLobPreview` 是类型谓词，`preview || baseText.length` 里
  // 右侧会被 TypeScript 收窄成 never（false 分支 = 不是 string，而它本来就是 string）。
  const baseLength = baseText.length;
  // 加载完整值之后一律用完整值展示：复制、JSON 格式化、显示空白都跟着它走。
  const text = full?.value ?? baseText;
  const binary = binaryColumn(column?.type);
  const preview = isLobPreview(baseText) || binary && binaryPreview(baseText);
  const total = lobPreviewChars(baseText);
  const pretty = useMemo(()=>prettyJson(text),[text]);
  // 手动态（默认）：允许 GBK 与短串，面板上会标出编码和字节数，用户是明确点的。
  const autoDecoded = useMemo(()=>binary ? decodeCell(text, { binary: true, auto: true }) : null,[text, binary]);
  const decoded = useMemo(()=>!encoding && autoDecoded ? autoDecoded : decodeCell(text, { binary, encoding }),[text, binary, encoding, autoDecoded]);
  const view = mode === "auto" ? autoDecoded ? "decoded" : "raw" : mode;
  // 解出来是 JSON 就直接漂亮化——两段式（先解码再点 JSON）没人愿意点两次。
  const decodedShown = useMemo(()=>decoded ? (decoded.json ? prettyJson(decoded.text) ?? decoded.text : decoded.text) : null,[decoded]);
  const onlyWhitespace=!empty && value!==null && text.length>0 && !/\S/.test(text);
  const valueInfo=empty ? "" : value===null ? "NULL · 数据库空值" : text.length===0 ? "空字符串 · 0 字符"
    : binary ? "" : `${onlyWhitespace ? "仅空白字符 · " : ""}${text.length} 字符${full ? " · 完整值" : preview ? " · 预览" : ""}`;
  const shown=view==="decoded" ? decodedShown ?? text : view==="json" ? pretty ?? text : view==="whitespace" ? text.replace(/[\t\r\n ]/g,c=>c===" " ? "·" : c==="\t" ? "⇥" : c==="\r" ? "␍" : "↵\n") : text;
  useEffect(()=>{
    reqRef.current++;
    setView("auto");
    setEncoding(undefined);
    setFull(null);
    setLoadError(null);
    setLoading(false);
  },[column?.name,row,value]);
  // 放大到 Modal 时内容会被 portal 重建，焦点必须跟着重落一次：Modal 的焦点陷阱
  // 挂载时把焦点给「第一个可聚焦元素」，DOM 顺序上那是「关闭详情」，键盘用户
  // 放大后一按回车就把面板关了。CellDetail 的 effect 晚于子组件 Modal 的 effect，
  // 所以这里用普通 useEffect 就能盖住陷阱的初始聚焦。
  useEffect(()=>{
    contentRef.current?.focus({preventScroll:true});
    contentRef.current?.scrollIntoView?.({block:"nearest",inline:"nearest"});
  },[expanded]);

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
  // `>= 4096` 是「值可能被后端截断」的兜底猜测，与 `isWideText`（网格显示不全，>300）不是一回事：
  // 300~4096 的完整值不需要按行重查，合并判据会让每个长值都多出一个点了没用的按钮。
  const canLoad = !!lob?.canLoad && !empty && (preview || baseLength >= 4096);
  const copySql = () => {
    if (!sql || !column) return;
    void copyText(decodeSqlTemplate(sql, column.name), () => toast("解码 SQL 已复制", "success"), (e) => toast(`复制失败：${e}`, "error"));
  };

  const panel = (
    <div className="dbx-detail" data-binary={binary || undefined} data-expanded={expanded || undefined} role="region" aria-label="单元格详情" onKeyDown={e=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();if(expanded) setExpanded(false);else onClose();}}}>
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
        {binary && <button type="button" className="dbx-ibtn" aria-label={expanded ? "退回侧栏" : "放大"} title={expanded ? "退回侧栏 · Esc" : "放大阅读"} onClick={() => setExpanded(!expanded)}><Icon name={expanded ? "collapse" : "expand"} size={14} /></button>}
        <button type="button" className="dbx-ibtn" aria-label="关闭详情" title="关闭详情 · Esc" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      {view!=="raw" && view!=="decoded" && <div className="dbx-detail-note" role="status">{view==="json" ? "JSON 仅格式化展示" : "· 空格　⇥ 制表符　␍ 回车　↵ 换行"}；“复制原值”保留数据库内容，“复制展示内容”只复制当前视图。</div>}
      {!binary && view==="decoded" && decoded && (
        <div className="dbx-detail-note" role="status">
          {describeDecoded(decoded)}。{decoded.json ? "已按 JSON 格式化；" : ""}这是解码后的内容，「复制原值」拿到的仍是库里的编码串。
          {sql && column && <button type="button" className="dbx-lk" onClick={copySql}>复制解码 SQL</button>}
        </div>
      )}
      {!binary && preview && !full && !loadError && (
        <div className="dbx-detail-note" role="status">
          当前是预览（前 8K 字符{total ? `，原值共 ${total} 字符` : ""}）。
          {canLoad ? "点「加载完整值」按这一行重查。" : lob?.canLoad === false ? "这一行没有可用的定位条件，无法加载完整值；请直接查询该表。" : "当前结果不支持按行重查；请直接查询该表取完整值。"}
          {decoded && !decoded.complete && "解码结果末尾可能不完整。"}
        </div>
      )}
      {binary && !empty && value !== null && <div className="dbx-detail-status">
        <span role="status" title={view === "decoded" && decoded ? describeDecoded(decoded) : undefined}>
          {preview && !full ? "预览" : full?.truncated ? "已达读取上限" : "完整值"}
          {view === "decoded" && decoded ? ` · ${decoded.json ? "JSON · " : ""}${decoded.encoding.toUpperCase()}` : " · 原始 Hex"}
        </span>
        {canLoad && !full && <button type="button" className="dbx-btn pri" disabled={loading} onClick={() => void loadFull()}>{loading ? "加载中…" : "加载完整值"}</button>}
        {preview && !canLoad && <span title="没有可用的唯一键定位这一行">无法按行重查</span>}
      </div>}
      {loadError && <div className="dbx-detail-note" role="alert">{loadError}</div>}
      {binary && encoding && !decoded && <div className="dbx-detail-note" role="status">无法按所选编码解读，显示原始值</div>}
      <JsonInspector preRef={contentRef} text={empty ? "" : value === null ? "NULL" : shown} json={!empty && (view === "json" && pretty !== null || view === "decoded" && !!decoded?.json)}/>

      <div className="ft">
        <button type="button" className="dbx-btn ghost" disabled={empty || value === null} onClick={() => void copyText(text, () => toast("已复制原值", "success"), (e) => toast(`复制失败：${e}`, "error"))}>
          <Icon name="copy" size={12} />
          {binary && (preview && !full || full?.truncated) ? "复制原始预览" : "复制原值"}
        </button>
        {decoded && view==="decoded" && (
          <button type="button" className="dbx-btn ghost" data-on onClick={() => void copyText(decoded.text, () => toast("已复制解码结果", "success"), (e) => toast(`复制失败：${e}`, "error"))}>
            <Icon name="copy" size={12} />
            {decoded.complete && !full?.truncated ? "复制解码后" : "复制文本预览"}
          </button>
        )}
        {!binary && canLoad && (
          <button type="button" className="dbx-btn ghost" data-on={full ? true : undefined} disabled={loading || !!full}
            title={full?.truncated ? "已达读取上限" : "按当前结果定位这一行，取回完整值"}
            onClick={() => void loadFull()}>
            <Icon name="download" size={12} />
            {loading ? "加载中…" : full ? (full.truncated ? "已加载（达上限）" : "已加载完整值") : "加载完整值"}
          </button>
        )}
        {binary && !empty && value !== null && <select className="dbx-inp sm" aria-label="文本编码" value={encoding ?? ""} onChange={event => {
          const next = event.target.value as TextEncoding | "";
          setEncoding(next || undefined);
          setView(next ? "decoded" : "auto");
        }}><option value="">自动编码</option><option value="utf-8">UTF-8</option><option value="gb18030">GB18030</option></select>}
        {decoded && (
          <button type="button" className="dbx-btn ghost" data-on={view==="decoded" || undefined} aria-pressed={view==="decoded"}
            title={`${describeDecoded(decoded)} · 只影响这一屏，原值与复制都不变`}
            onClick={() => setView(view==="decoded" ? "raw" : "decoded")}>
            <Icon name="code" size={12} />
            {binary ? view==="decoded" ? "Hex" : "文本" : view==="decoded" ? "看原始编码" : "解码显示"}
          </button>
        )}
        {!binary && <><button type="button" className="dbx-btn ghost" data-on={view==="json" || undefined} aria-pressed={view==="json"} disabled={empty || pretty===null} onClick={() => setView(view==="json" ? "raw" : "json")}>
          JSON 格式化
        </button>
        <button type="button" className="dbx-btn ghost" data-on={view==="whitespace" || undefined} aria-pressed={view==="whitespace"} disabled={empty || !/\s/.test(text)} onClick={()=>setView(view==="whitespace" ? "raw" : "whitespace")}>显示空白</button>
        <button type="button" className="dbx-btn ghost" data-on={expanded || undefined} aria-pressed={expanded}
          title={expanded ? "退回侧栏（Esc）" : "在大窗口里查看，读长文本更舒服"}
          onClick={() => setExpanded(!expanded)}>
          <Icon name={expanded ? "collapse" : "expand"} size={12} />
          {expanded ? "退回侧栏" : "放大"}
        </button></>}
      </div>
    </div>
  );
  return expanded
    ? <Modal open onClose={() => setExpanded(false)} className="modal-surface dbx-detail-modal" ariaLabel="单元格详情（放大）">{panel}</Modal>
    : panel;
}
