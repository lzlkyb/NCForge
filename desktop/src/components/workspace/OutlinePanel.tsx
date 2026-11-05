import { useEffect, useMemo, useRef, useState } from "react";
import { JavaSymbolIcon } from "./JavaSymbolIcon";
import { Icon } from "../ui/icon";
import { WorkspaceGlyph } from "./WorkspaceGlyph";
import { useCursor } from "../../lib/cursorStore";
import { isNcDeclaration, ncDeclarationLabel } from "../../lib/ncDeclarationOutline";
import { useLocalOutline } from "../../hooks/useLocalOutline";
import { usePresence } from "../../hooks/usePresence";
import { inLangModule, useLangView } from "../../lib/lang";
import { trackOperation } from "../../lib/operations";
import { chainAt, symbolsFor, type FlatSymbol } from "../../lib/symbols";
import { buildOutline, filterOutline, moveActive, outlineRows } from "../../lib/outline";

interface Props {
  open: boolean;
  onClose: () => void;
  path: string | null;
  mtimeMs?: number;
  onJump: (line: number, column?: number) => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  dirty?: boolean;
}

/**
 * 结构弹层。`open` 由文件页控制（命令面板也要能打开它，所以状态不放组件里）。
 */
export function OutlinePanel({ open, onClose, path, mtimeMs, onJump, pinned = false, onTogglePin, dirty = false }: Props) {
  const lang = useLangView();
  const cursor = useCursor();
  const [methodsOnly, setMethodsOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [data, setData] = useState<{ path: string; list: FlatSymbol[] } | null>(null);
  const [request,setRequest]=useState({loading:false,error:"",revision:0});
  const panelRef = useRef<HTMLDivElement|null>(null);
  const {mounted,entered}=usePresence(open);
  // onClose 每次渲染都是新身份：监听只在开屏时注册一次，用 ref 穿透闭包读最新值
  const live = useRef({ onClose });
  live.current = { onClose };

  const javaPath = path && path.toLowerCase().endsWith(".java") ? path : null;
  const ncPath = path && isNcDeclaration(path) ? path : null;
  const canAsk = !dirty && javaPath !== null && lang.state === "ready" && inLangModule(javaPath);
  const local = useLocalOutline(open ? javaPath || ncPath : null, mtimeMs);

  useEffect(() => {
    if (!open) return;
    if (!canAsk || !javaPath) {
      // 不能问的时候必须清掉上一份数据：留着会显示**别的文件**的结构，
      // 点一行还跳到别的文件的行——用户以为结构面板坏了，其实是数据陈旧
      setData(null);setRequest(v=>({...v,loading:false,error:""}));
      return;
    }
    let alive = true;
    setData(null);
    setRequest(v=>({...v,loading:true,error:""}));
    trackOperation({key:`outline:${javaPath}`,label:"读取文件结构",scope:javaPath,page:"files",path:javaPath,phase:"向代码智能查询符号"},()=>symbolsFor(javaPath, mtimeMs))
      .then((list) => {if(alive) {setData({ path: javaPath, list });setRequest(v=>({...v,loading:false}));}})
      .catch(e => {if(alive) {setData(null);setRequest(v=>({...v,loading:false,error:String(e)}));}});
    return () => {
      alive = false;
    };
  }, [open, canAsk, javaPath, mtimeMs,request.revision]);

  useEffect(() => {
    setQuery("");
    setActive(-1);
  }, [open, path]);

  const remote = canAsk && data?.path === javaPath ? data.list : null;
  const symbols = remote ?? local;
  const rows = useMemo(() => {
    const matches = outlineRows(filterOutline(buildOutline(symbols), query));
    return javaPath && methodsOnly ? matches.filter(row => [6, 9, 12].includes(row.sym.kind)) : matches;
  }, [symbols, query, javaPath, methodsOnly]);
  const current = pinned ? chainAt(symbols, cursor.line).slice(-1)[0] : undefined;

  // 开屏期间：点面板外面关、按 Esc 关。监听挂 document，不再用全屏遮罩——
  // 遮罩会盖住整个编辑区：看结构的同时想滚动代码、点别处对照，都会被它吃掉。
  // 触发按钮（data-popover="outline"）要排除：那是开关，交给外层的 toggle 逻辑，
  // 否则「点按钮关」会被这里先关、toggle 再开，表现为点了没反应。
  useEffect(() => {
    if (!open || pinned) return;
    const outside = (t: EventTarget | null) => {
      if (!t) return false;
      if (panelRef.current?.contains(t as Node)) return true;
      return Boolean((t as Element).closest?.('[data-popover="outline"]'));
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!outside(e.target)) live.current.onClose();
    };
    // Esc 从过滤输入框里挪到文档级：焦点在列表行按钮上时原来按了没反应
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.key !== "Escape") return;
      e.preventDefault();
      live.current.onClose();
      panelRef.current?.closest(".wb-reading-layout")?.querySelector<HTMLButtonElement>('[data-popover="outline"]')?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, pinned]);

  if (!mounted) return null;

  const jump = (i: number) => {
    const row = rows[i];
    if (!row) return;
    onJump(row.sym.line, row.sym.column);
    if (!pinned) onClose();
  };

  return (
    <div ref={node=>{panelRef.current=node;if(node) node.inert=!open;}} className="wb-outline ui-surface" data-pinned={pinned || undefined} data-state={entered?"open":"closed"} data-exiting={!open || undefined} role={pinned ? "region" : "dialog"} aria-hidden={!open || undefined} aria-label={ncPath ? "声明结构" : "文件结构"} aria-busy={canAsk && request.loading}>
      <div className="wb-outline-head">
        <WorkspaceGlyph name="outline" size={13} />
        <span>{ncPath ? "声明结构" : "文件结构"}</span>
        <span className="wb-outline-count">{rows.length > 0 ? `${rows.length} 项` : ""}</span>
        {onTogglePin && <button type="button" className="wb-outline-option" aria-pressed={pinned}
          onClick={onTogglePin}>{pinned ? "已固定" : "固定到右侧"}</button>}
      </div>
      <input
        className="wb-outline-q"
        autoFocus={!pinned}
        aria-label="按名称筛选结构"
        placeholder={ncPath ? "按声明名称筛选" : "按类名或方法名筛选"}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if(e.nativeEvent.isComposing) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive(moveActive(rows.length, active, e.key === "ArrowDown" ? 1 : -1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            jump(active);
          }
        }}
      />
      {javaPath && <div className="wb-outline-options">
        <button type="button" className="wb-outline-option" aria-pressed={methodsOnly}
          onClick={() => { setMethodsOnly(value => !value); setActive(-1); }}>只看方法</button>
        {!remote && local.length > 0 && <span>本地解析</span>}
      </div>}
      <div className="wb-outline-list">
        {canAsk && request.loading && !local.length && <div className="wb-outline-note" role="status"><Icon name="spinner" size={13} className="animate-spin"/> 正在读取文件结构…</div>}
        {canAsk && request.error && !local.length && <div className="wb-outline-note" role="alert">读取结构失败：{request.error}<button type="button" className="wb-outline-btn" onClick={()=>setRequest(v=>({...v,revision:v.revision+1}))}>重新读取</button></div>}
        {rows.length === 0 && (!canAsk || (!request.loading && !request.error) || local.length > 0) &&
          <div className="wb-outline-note">{query || (javaPath && methodsOnly) ? "没有匹配的符号"
            : ncPath ? "没有可定位的 XML 声明" : "没有可显示的符号"}</div>}
        {rows.map((r, i) => (
          <button
            type="button"
            key={`${r.sym.line}:${r.sym.name}:${i}`}
            className="wb-outline-row"
            data-active={i === active || undefined}
            data-current={current === r.sym || undefined}
            aria-current={current === r.sym || undefined}
            style={{ paddingLeft: 8 + r.depth * 14 }}
            title={`第 ${r.sym.line} 行 · ${r.sym.container ? `${r.sym.container}.` : ""}${r.sym.name}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => jump(i)}
          >
            {ncPath ? <span className="wb-outline-kind">{ncDeclarationLabel(r.sym.kind)}</span>
              : <JavaSymbolIcon kind={r.sym.kind} />}
            <span className="wb-outline-name">{r.sym.name}</span>
            <span className="wb-outline-ln">{r.sym.line}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
