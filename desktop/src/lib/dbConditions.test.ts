// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { compileFilter, emptyFilter, loadFilter, saveFilter, type Operator } from "./dbConditions";
import type { ColumnInfo } from "./dbApi";
const columns=[{name:"ID",type:"NUMBER"},{name:"NAME",type:"VARCHAR2"},{name:"CREATED",type:"DATE"}] as ColumnInfo[];
const filter=(op:Operator,column="ID",value="90071992547409931234")=>({...emptyFilter(),conditions:[{column,op,value,end:""}]});
afterEach(()=>{vi.useRealTimers();localStorage.clear();});
it.each([["ne","<>"],["gt",">"],["gte",">="],["lt","<"],["lte","<="]] as const)("%s保留精确数字绑定",(op,sql)=>{
 const result=compileFilter(filter(op),columns);expect(result.where).toBe(`(ID ${sql} :1)`);expect(result.params).toEqual([{number:"90071992547409931234"}]);
});
it("IN逐项绑定，文本不能变成SQL，空列表与超过上限拒绝",()=>{
 const result=compileFilter(filter("in","NAME","O'Reilly, x); drop table T;--"),columns);
 expect(result.where).toBe("(NAME in (:1, :2))");expect(result.params).toEqual(["O'Reilly","x); drop table T;--"]);
 expect(()=>compileFilter(filter("in","ID","1,,2"),columns)).toThrow();
 expect(()=>compileFilter(filter("in","ID",Array(1001).fill("1").join(",")),columns)).toThrow();
});
it("NULL与NOT NULL不生成绑定，日期范围使用次日排他上限并保持OR分组",()=>{
 expect(compileFilter(filter("notnull"),columns)).toEqual({where:"(ID is not null)",order:"",params:[]});
 vi.useFakeTimers();vi.setSystemTime(new Date(2026,10,10,12));
 const value=filter("last7days","CREATED","");value.join="or";value.conditions.push({column:"ID",op:"eq",value:"1",end:""});
 const result=compileFilter(value,columns);
 expect(result.params).toEqual(["2026-11-04T00:00:00","2026-11-11T00:00:00",{number:"1"}]);
 expect(result.where).toContain(") or (ID = :3)");expect(result.where).toContain("CREATED < to_timestamp(:2");
 expect(()=>compileFilter(filter("today","ID"),columns)).toThrow();
});
it("常用筛选保存并恢复新增运算符",()=>{
 const value=filter("gte");saveFilter("c","T",value);expect(loadFilter("c","T")).toEqual(value);
});
