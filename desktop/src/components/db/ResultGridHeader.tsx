import type { CSSProperties } from "react";
import type { ColumnMeta } from "../../lib/dbApi";
import type { SortState } from "../../lib/resultView";
import type { columnViewport, selectionBounds } from "../../lib/gridViewport";
import { gridSelectionHeading } from "../../lib/gridSelection";
import type { useResultGridNavigation } from "../../hooks/useResultGridNavigation";
import { Icon } from "../ui/icon";
import type { CellPos } from "./ResultGrid";
import type { GridCodec } from "../../lib/cellCodec";

/** Headers keep their visual and menu controls together while navigation owns the single keyboard tab stop. */
export function ResultGridHeader({columns,sort,zh,order,visible,viewport,bounds,total,rnW,cellStyle,navigation,onSel,onSort,onHeaderMenu,resize,fit,codec}: {
  columns:ColumnMeta[];sort:SortState|null;zh?:Record<string,string>;order:number[];visible:number[];
  viewport:ReturnType<typeof columnViewport>;bounds:ReturnType<typeof selectionBounds>;total:number;rnW:number;
  cellStyle:(c:number)=>CSSProperties;navigation:ReturnType<typeof useResultGridNavigation>;
  onSel:(pos:CellPos,extend?:boolean)=>void;onSort:(c:number)=>void;onHeaderMenu?:(c:number,x:number,y:number)=>void;
  resize:(c:number,x:number)=>void;
  /** 双击分隔线：本列宽度贴到内容。 */
  fit:(c:number)=>void;
  /** 只用来标出「这列是编码数据」，开关在列头右键菜单里。 */
  codec?:GridCodec;
}) {
  const {headerRefs,headerCol,setHeaderCol,focusHeader,onHeaderKey}=navigation;
  const headerTabStop=viewport.some(c=>c.column===headerCol) ? headerCol : viewport[0]?.column;
  return <div className="dbx-ghead" style={{ width: total }} role="row" aria-rowindex={1}>
    <div className="dbx-gh rn" style={{ width: rnW }} role="columnheader" aria-colindex={1} title="选择全部" onClick={()=>{if(order.length && visible.length) {onSel({r:order[0],c:visible[0]});onSel({r:order[order.length-1],c:visible[visible.length-1]},true);}}} />
    {viewport.map(({column:k,index:vi}) => { const c=columns[k]; return (
      <div
        key={k}
        className="dbx-gh"
        data-has-menu={!!onHeaderMenu || undefined}
        data-range-heading={gridSelectionHeading(bounds,vi,"column")}
        style={cellStyle(k)}
        role="columnheader"
        aria-colindex={vi + 2}
        aria-sort={sort?.col === k ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
        title={[c.name.toLowerCase(), zh?.[c.name.toLowerCase()], c.type]
          .concat(codec?.encoded(k) ? (codec.active(k) ? "正在显示解码后的值 · 右键可恢复" : "检测到编码 · 右键可显示明文") : [])
          .filter(Boolean).join(" · ")}
        onKeyDown={e=>onHeaderKey(e,k)}
        onContextMenu={(e) => {
          if (!onHeaderMenu) return;
          e.preventDefault();
          headerRefs.current.get(k)?.focus({preventScroll:true});
          onHeaderMenu(k, e.clientX, e.clientY);
        }}
      >
        <button type="button" className="dbx-header-action" data-column={k}
          ref={node=>{if(node) headerRefs.current.set(k,node);else headerRefs.current.delete(k);}}
          tabIndex={headerTabStop===k ? 0 : -1} onFocus={e=>{setHeaderCol(k);e.currentTarget.scrollIntoView?.({block:"nearest",inline:"nearest"});}}
          aria-label={`${c.name}${zh?.[c.name.toLowerCase()] ? ` · ${zh[c.name.toLowerCase()]}` : ""}，本地排序，仅已加载行`}
          aria-keyshortcuts={onHeaderMenu ? "Enter Space Shift+F10" : "Enter Space"}
          title={`Enter 排序已加载行；左右键换列；${onHeaderMenu ? "Shift+F10 打开列菜单；" : ""}下箭头返回数据`}
          onClick={e=>{if(e.shiftKey && order.length){onSel({r:order[0],c:k});onSel({r:order[order.length-1],c:k},true);}else onSort(k);}}>
          <span className="nm">{c.name.toLowerCase()}{codec?.encoded(k) && <i className="dbx-codec" data-on={codec.active(k) || undefined} aria-hidden="true" />}</span>
          {sort?.col === k && <span className="so" aria-hidden="true">{sort.dir === "asc" ? "▲" : "▼"}</span>}
          {/* 第二行：有中文名放中文名（业务上更认得），没有就放数据类型。
              没有这一层的话，NC 里大量没有中文名的列名（`OUTTRANSLATEJSON` 之类）
              第二行是空的，那 17px 纯浪费，列名一挤就只能看省略号。 */}
          <span className="t">{zh?.[c.name.toLowerCase()] ?? c.type}</span>
        </button>
        {onHeaderMenu && <button type="button" className="dbx-header-menu" tabIndex={-1} aria-label={`${c.name} 列菜单`} aria-haspopup="menu" title="列菜单 · Shift+F10" onClick={()=>focusHeader(k,true)}><Icon name="more" size={13} /></button>}
        <span className="rz" title="拖动调整列宽 · 双击自适应" onClick={(e) => e.stopPropagation()} onDoubleClick={() => fit(k)} onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); resize(k, e.clientX); }} />
      </div>
    );})}
  </div>;
}
