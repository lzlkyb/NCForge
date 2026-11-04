// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { compileFilter, emptyFilter, loadFilter, saveFilter } from "./dbConditions";
import { lookupRow, optimisticChanges } from "./dbOptimisticEdit";
import { compareResults, gridColumns, defaultLayout, selectionText, loadLayout, saveLayout, type ResultSnapshot } from "./dbResultTools";
import { relationQuery, relationRows } from "./dbRelations";
import type { ColumnInfo, ColumnMeta, RowsResult } from "./dbApi";
const col=(name:string,type="VARCHAR2"):ColumnInfo & ColumnMeta=>({name,type,size:0,zh:null,precision:0,scale:0,full:type,pk:name==="ID",nullable:true,default:null,comment:null});
const columns=[col("ID","NUMBER"),col("CODE"),col("TS","TIMESTAMP"),col("NOTE","CLOB")];
beforeEach(()=>localStorage.clear());
describe("bound filters",()=>{
 it("never concatenates quoted values and escapes LIKE wildcards",()=>{const f=emptyFilter();f.conditions=[{column:"CODE",op:"contains",value:"x' or 1=1 --%_",end:""}];const q=compileFilter(f,columns);expect(q.where).not.toContain("1=1");expect(q.params).toEqual(["%x' or 1=1 --\\%\\_%"]);});
 it("keeps 38-digit numbers exact",()=>{const f=emptyFilter();f.conditions=[{column:"ID",op:"eq",value:"12345678901234567890123456789012345678",end:""}];expect(compileFilter(f,columns)).toMatchObject({where:"(ID = :1)",params:[{number:f.conditions[0].value}]});});
 it("binds dates, nulls, multiple conditions and sorting",()=>{const f=emptyFilter();f.conditions=[{column:"TS",op:"between",value:"2026-11-04",end:"2026-11-05T12:30"},{column:"CODE",op:"null",value:"",end:""}];f.join="or";f.sort="ID";f.descending=true;const q=compileFilter(f,columns);expect(q.params).toEqual(["2026-11-04T00:00:00","2026-11-05T12:30:00"]);expect(q.where).toContain(" or ");expect(q.order).toBe("ID desc");});
 it("rejects unknown columns, invalid number/date and bad saved preferences",()=>{const f=emptyFilter();f.conditions=[{column:"UNKNOWN",op:"eq",value:"x",end:""}];expect(()=>compileFilter(f,columns)).toThrow();f.conditions[0].column="ID";expect(()=>compileFilter(f,columns)).toThrow();localStorage.setItem("ncforge-db-filter:c:table",JSON.stringify({...f,conditions:[null]}));expect(loadFilter("c","table")).toEqual(emptyFilter());});
 it("restores only explicitly saved filters",()=>{const f={...emptyFilter(),sort:"ID"};saveFilter("c","table",f);expect(loadFilter("c","TABLE")).toEqual(f);expect(loadFilter("other","table")).toEqual(emptyFilter());});
});
describe("optimistic write",()=>{
 it("guards primary key and previous value atomically",()=>{const q=optimisticChanges("T",columns,[["9007199254740993","old",null,null]],["ID"],new Map([["0:1","O'Brien"]]))[0];expect(q.sql).toContain("where ID = :2 and CODE = :3");expect(q.params).toEqual(["O'Brien",{number:"9007199254740993"},"old"]);expect(q.sql).not.toContain("O'Brien");});
 it("supports NULL, dates, CLOB and one update per row",()=>{const q=optimisticChanges("T",columns,[[1,null,"2026-11-04 01:02:03",null]],["ID"],new Map([["0:1","new"],["0:2","2026-11-04 01:02:04"],["0:3","note"]]));expect(q).toHaveLength(1);expect(q[0].sql).toContain("CODE is null");expect(q[0].sql).toContain("NOTE is null");expect(q[0].sql).toContain("to_timestamp");expect(q[0].sql).toContain("to_clob");});
 it("looks up date and exact numeric compound keys without NLS coercion",()=>{const q=lookupRow("T",columns,["12345678901234567890123456789012345678",null,"2026-11-04T01:02",null],["ID","TS"]);expect(q.sql).toContain("TS = to_timestamp(:2");expect(q.params).toEqual([{number:"12345678901234567890123456789012345678"},"2026-11-04 01:02:00.0"]);});
 it("cannot write missing or NULL primary keys",()=>{expect(optimisticChanges("T",columns,[],["missing"],new Map())).toEqual([]);expect(()=>optimisticChanges("T",columns,[[null,"old",null,null]],["ID"],new Map([["0:1","new"]]))).toThrow();});
});
describe("display selection and layout",()=>{
 it("copies 3 rows and 2 columns in visible order after sorting",()=>{expect(selectionText([[1,"a","A"],[2,"b","B"],[3,"c","C"]],[2,0,1],[2,1,0],{anchor:{r:2,c:2},end:{r:1,c:1}})).toBe("C\tc\r\nA\ta\r\nB\tb");});
 it("preserves NULL edits and quotes multiline values",()=>{const rows=[[1,"a\nb"]];expect(selectionText(rows,[0],[0,1],{anchor:{r:0,c:0},end:{r:0,c:1}},(r,c)=>c===0?null:rows[r][c])).toBe('\t"a\nb"');});
 it("ignores hidden endpoints and saves only valid widths",()=>{expect(selectionText([[1]],[0],[],{anchor:{r:0,c:0},end:{r:0,c:0}})).toBe("");const v={...defaultLayout(),order:["CODE","ID"],frozen:["ID"],hidden:["NOTE"],widths:{ID:80}};saveLayout("t",v);expect(loadLayout("t")).toEqual(v);expect(gridColumns(columns,v)).toEqual([0,1,2]);});
});
describe("snapshot matching",()=>{
 const snap=(rows:(string|number|null)[][],cols:ColumnMeta[]=columns.slice(0,2)):ResultSnapshot=>({source:"test",sql:"select",at:1,complete:true,columns:cols,rows});
 it("does not report reordered rows or columns as changes",()=>{expect(compareResults(snap([[1,"a"],[2,"b"]]),snap([["b",2],["a",1]],[columns[1],columns[0]]),["ID"])).toEqual({added:[],removed:[],changed:[]});});
 it("reports adds, removals and field updates",()=>{const d=compareResults(snap([[1,"a"],[2,"b"]]),snap([[2,"new"],[3,"c"]]),["ID"]);expect(d.added).toEqual([[3,"c"]]);expect(d.removed).toEqual([[1,"a"]]);expect(d.changed).toEqual([{before:[2,"b"],after:[2,"new"]}]);});
 it("requires unique non-null keys and identical field sets",()=>{expect(()=>compareResults(snap([[null,"a"]]),snap([[1,"a"]]),["ID"])).toThrow(/NULL/);expect(()=>compareResults(snap([[1,"a"],[1,"b"]]),snap([]),["ID"])).toThrow(/重复/);expect(()=>compareResults(snap([]),snap([], [columns[0],columns[0]]),["ID"])).toThrow();});
});
describe("declared relationships",()=>{
 it("binds date and numeric relationship values using their actual types",()=>{const r={id:"FK",source:"T",target:"P",from:["ID","TS"],to:["PID","PTS"],kind:"外键" as const};const q=relationQuery(r,"T",columns,["12345678901234567890123456789012345678",null,"2026-11-04 01:02:03",null]);expect(q.where).toContain("PTS = to_timestamp(:2");expect(q.params).toEqual([{number:"12345678901234567890123456789012345678"},"2026-11-04 01:02:03.0"]);});
 it("keeps compound key pairs aligned by position in either direction",()=>{const result={kind:"rows",rowCount:2,hasMore:false,ms:1,output:[],tx:{autoCommit:false,statements:0,rows:0,since:0},columns:["RELATION","SOURCE_TABLE","SOURCE_COLUMN","TARGET_TABLE","TARGET_COLUMN","POSITION"].map(n=>col(n)),rows:[["FK","CHILD","P2","PARENT","ID2",2],["FK","CHILD","P1","PARENT","ID1",1]]} as RowsResult;const r=relationRows(result,"外键")[0];expect(r.from).toEqual(["P1","P2"]);expect(relationQuery(r,"PARENT",[col("ID1"),col("ID2")],["a'","b"]).where).toBe("P1 = :1 and P2 = :2");expect(relationQuery(r,"CHILD",[col("P1"),col("P2")],[1,2]).table).toBe("PARENT");});
});
