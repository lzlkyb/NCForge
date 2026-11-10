import { useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { copyText } from "../../lib/utils";
import type { ColumnInfo } from "../../lib/dbApi";

/** 表结构页：字段、中文名、类型与可空性；带搜索与主键/非空过滤。 */
export function StructView({ cols }: { cols: ColumnInfo[] | null }) {
  const [query,setQuery]=useState("");
  const [only,setOnly]=useState("all");
  const shown=cols?.filter(c=>(only === "pk" ? c.pk : only === "required" ? !c.nullable : true) && [c.name,c.zh,c.comment,c.full].some(value=>value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  if (!cols) return <div className="dbx-empty"><Icon name="spinner" size={18} />读取中…</div>;
  return (
    <>
      <div className="dbx-reading-tools"><input aria-label="搜索结构字段" placeholder="字段名 / 中文名 / 注释" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="结构字段范围" value={only} onChange={e=>setOnly(e.target.value)}><option value="all">全部字段</option><option value="pk">主键字段</option><option value="required">非空字段</option></select><span role="status">{shown?.length} / {cols.length} 字段</span></div>
      <div className="dbx-meta"><table>
        <thead>
          <tr><th>#</th><th>字段</th><th>中文名（NC）</th><th>类型</th><th>可空</th><th>默认值</th><th>注释</th><th>复制</th></tr>
        </thead>
        <tbody>
          {shown?.map((c) => (
            <tr key={c.name}>
              <td className="dbx-muted">{cols.indexOf(c) + 1}</td>
              <td className="mono">{c.pk && <span className="pk" title="主键">PK </span>}{c.name.toLowerCase()}</td>
              <td>{c.zh ?? ""}</td>
              <td className="mono">{c.full}</td>
              <td>{c.nullable ? "是" : ""}</td>
              <td className="mono">{c.default ?? ""}</td>
              <td>{c.comment ?? ""}</td>
              <td><button type="button" className="dbx-lk" aria-label={`复制字段名 ${c.name}`} onClick={()=>void copyText(c.name,()=>toast("已复制字段名","success"),()=>toast("复制失败","error"))}>字段名</button> <button type="button" className="dbx-lk" aria-label={`复制字段定义 ${c.name}`} onClick={()=>void copyText(`${c.name} ${c.full}${c.default ? ` DEFAULT ${c.default}` : ""}${c.nullable ? "" : " NOT NULL"}`,()=>toast("已复制字段定义","success"),()=>toast("复制失败","error"))}>定义</button></td>
            </tr>
          ))}
          {shown?.length === 0 && <tr><td colSpan={8}>没有匹配的字段，请调整搜索或筛选。</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
