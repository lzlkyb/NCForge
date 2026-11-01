// 「文件结构」弹层：当前 java 文件的类 / 方法 / 字段树。
//
// 为什么是弹层而不是常驻侧栏：编辑器横向空间在 1366 的笔记本上已经很紧，NC 的 BO/BP
// 经常一行就占满；为了偶尔看一眼结构而永久少 200px 代码宽度不划算。弹层按需出现、
// 选完就消失，代价只是「要点一下」。
//
// 数据与面包屑共用 `symbolsFor` 的缓存，所以打开这一步通常不再发请求。
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { inLangModule, useLangView } from "../../lib/lang";
import { kindLetter, symbolsFor, type FlatSymbol } from "../../lib/symbols";
import { buildOutline, filterOutline, moveActive, outlineRows } from "../../lib/outline";

interface Props {
  open: boolean;
  onClose: () => void;
  path: string | null;
  mtimeMs?: number;
  onJump: (line: number) => void;
}

/**
 * 结构弹层。`open` 由文件页控制（命令面板也要能打开它，所以状态不放组件里）。
 */
export function OutlinePanel({ open, onClose, path, mtimeMs, onJump }: Props) {
  const lang = useLangView();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [data, setData] = useState<{ path: string; list: FlatSymbol[] } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // onClose 每次渲染都是新身份：监听只在开屏时注册一次，用 ref 穿透闭包读最新值
  const live = useRef({ onClose });
  live.current = { onClose };

  const javaPath = path && path.toLowerCase().endsWith(".java") ? path : null;
  const canAsk = javaPath !== null && lang.state === "ready" && inLangModule(javaPath);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(-1);
    if (!canAsk || !javaPath) {
      // 不能问的时候必须清掉上一份数据：留着会显示**别的文件**的结构，
      // 点一行还跳到别的文件的行——用户以为结构面板坏了，其实是数据陈旧
      setData(null);
      return;
    }
    let alive = true;
    // 失败就当没有符号：结构面板是辅助功能，它取不到不该弹错打断用户
    symbolsFor(javaPath, mtimeMs)
      .then((list) => alive && setData({ path: javaPath, list }))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [open, canAsk, javaPath, mtimeMs]);

  const rows = useMemo(() => {
    if (!data || data.path !== javaPath) return [];
    return outlineRows(filterOutline(buildOutline(data.list), query));
  }, [data, javaPath, query]);

  // 开屏期间：点面板外面关、按 Esc 关。监听挂 document，不再用全屏遮罩——
  // 遮罩会盖住整个编辑区：看结构的同时想滚动代码、点别处对照，都会被它吃掉。
  // 触发按钮（data-popover="outline"）要排除：那是开关，交给外层的 toggle 逻辑，
  // 否则「点按钮关」会被这里先关、toggle 再开，表现为点了没反应。
  useEffect(() => {
    if (!open) return;
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
      if (e.key !== "Escape") return;
      e.preventDefault();
      live.current.onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open) return null;

  const jump = (i: number) => {
    const row = rows[i];
    if (!row) return;
    onJump(row.sym.line);
    onClose();
  };

  return (
    <div ref={panelRef} className="wb-outline" role="dialog" aria-label="文件结构">
      <div className="wb-outline-head">
        <Icon name="code" size={13} />
        <span>文件结构</span>
        <span className="wb-outline-count">{rows.length > 0 ? `${rows.length} 项` : ""}</span>
      </div>
      <input
        className="wb-outline-q"
        autoFocus
        placeholder="按名字过滤（类名 / 方法名）"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive(moveActive(rows.length, active, e.key === "ArrowDown" ? 1 : -1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            jump(active);
          }
        }}
      />
      <div className="wb-outline-list">
        {!canAsk && <div className="wb-outline-note">代码智能未就绪（或这个文件不在语言服务的模块里），暂时看不到结构</div>}
        {canAsk && rows.length === 0 && <div className="wb-outline-note">没有可显示的符号</div>}
        {rows.map((r, i) => (
          <button
            type="button"
            key={`${r.sym.line}:${r.sym.name}:${i}`}
            className="wb-outline-row"
            data-active={i === active || undefined}
            style={{ paddingLeft: 8 + r.depth * 14 }}
            title={`第 ${r.sym.line} 行 · ${r.sym.container ? `${r.sym.container}.` : ""}${r.sym.name}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => jump(i)}
          >
            <span className="wb-outline-k">{kindLetter(r.sym.kind)}</span>
            <span className="wb-outline-name">{r.sym.name}</span>
            <span className="wb-outline-ln">{r.sym.line}</span>
          </button>
        ))}
      </div>
    </div>
  );
}