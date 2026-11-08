import { useState } from "react";
import type { ChangeItem } from "../../lib/svn";
import { keyOf } from "../../lib/svn";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";

/** 专注模式仍需可见的文件导航，不能要求用户先退出或记住快捷键。 */
export function SvnReviewFiles({ items, selected, onSelect }: { items: ChangeItem[]; selected: string | null; onSelect: (item: ChangeItem) => void }) {
  const [query, setQuery] = useState("");
  const index = items.findIndex(item => selected && keyOf(item.path) === keyOf(selected));
  return <div className="vc-focus-files">
    <button type="button" className="vc-btn vc-btn-sm" aria-label="上一个文件" title="上一个文件" disabled={index <= 0} onClick={()=>onSelect(items[index-1])}><Icon name="arrowUp" size={12}/></button>
    <button type="button" className="vc-btn vc-btn-sm" aria-label="下一个文件" title="下一个文件" disabled={index >= items.length-1 || index < 0} onClick={()=>onSelect(items[index+1])}><Icon name="chevronDown" size={12}/></button>
    <Menu portal align="left" width="w-72" trigger={(open,toggle)=><button type="button" className="vc-btn vc-btn-sm" aria-haspopup="menu" aria-expanded={open} onClick={()=>{setQuery("");toggle();}}>切换文件 {index >= 0 ? `${index+1}/${items.length}` : ""}<Icon name="chevronDown" size={12}/></button>}>
      {close=><>
        <div className="vc-focus-search"><input autoFocus aria-label="搜索审查文件" placeholder="搜索文件或路径" value={query} onChange={e=>setQuery(e.target.value)}/></div>
        {items.filter(item=>item.rel.toLowerCase().includes(query.trim().toLowerCase())).map(item=><MenuItem key={item.path} label={item.rel} checked={selected ? keyOf(item.path)===keyOf(selected) : false} onClick={()=>{close();onSelect(item);}}/>)}
        {!items.some(item=>item.rel.toLowerCase().includes(query.trim().toLowerCase())) && <p className="vc-file-info">没有匹配的文件</p>}
      </>}
    </Menu>
  </div>;
}
