import type { ResultSnapshot } from "./dbResultTools";
import type { Cell } from "./dbApi";
import { compareResults } from "./dbResultTools";
import type { ComparisonModel, ComparisonRecord } from "./dbCompareState";
export function buildComparison(before:ResultSnapshot,after:ResultSnapshot,keys:string[]):ComparisonModel {
  const diff=compareResults(before,after,keys);
  const keyColumns=keys.map(key=>before.columns.findIndex(c=>c.name.toUpperCase()===key.toUpperCase()));
  const record=(kind:ComparisonRecord["kind"],a:Cell[]|null,b:Cell[]|null):ComparisonRecord=>({kind,before:a,after:b,key:keyColumns.map(c=>String((b ?? a)![c])).join(" · ")});
  return {columns:before.columns,keyColumns,counts:{changed:diff.changed.length,added:diff.added.length,removed:diff.removed.length},
    records:[...diff.changed.map(r=>record("changed",r.before,r.after)),...diff.added.map(r=>record("added",null,r)),...diff.removed.map(r=>record("removed",r,null))]};
}
