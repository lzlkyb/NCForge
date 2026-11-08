import { thousands } from "../../lib/db";

/** Pagination describes the displayed page, including while the next page is still loading. */
export function TableDataFooter({ rows, pageNumber, complete, previousDisabled, nextDisabled, onPrevious, onNext, hint }: {
  rows:number; pageNumber:number; complete:boolean; previousDisabled:boolean; nextDisabled:boolean;
  onPrevious:()=>void; onNext:()=>void; hint:string;
}) {
  return <div className="dbx-rfoot">
    <strong>已加载 {thousands(rows)} 行</strong>
    <span className="dbx-completeness" data-partial={!complete || undefined}>{complete ? "完整结果" : "当前页数据"}</span>
    <button type="button" className="dbx-lk" disabled={previousDisabled} onClick={onPrevious}>上一页</button>
    <span>第 {pageNumber} 页</span>
    <button type="button" className="dbx-lk" disabled={nextDisabled} onClick={onNext}>下一页</button>
    <span className="dbx-sp" />
    <span>{hint}</span>
  </div>;
}
