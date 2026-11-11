import { describe, expect, it } from "vitest";
import { captureResultContext, connectionKey, resultSqlState, resultTargetIssue } from "./dbResultContext";
import { splitStatements } from "./sqlSplit";
import type { DbConn } from "./dbApi";

const conn: DbConn = { id:"c",name:"NC 测试",env:"test",source:"manual",url:"jdbc:oracle:thin:@localhost:1521:TEST",user:"NC",propDs:null,autoCommit:false,note:"",hasPassword:false,engine:"java" };
const contextFor = (editorSql:string,index:number) => {
  const statement=splitStatements(editorSql)[index];
  return captureResultContext("c",conn,"SCHEMA_A",statement.text,{...statement,editorSql,editorVersion:7,startOffset:statement.start,endOffset:statement.end});
};
describe("不可变结果身份", () => {
  it("连接重命名、环境和目标变化不改写过去的来源", () => {
    const context=contextFor("select 1 from dual;",0);
    const renamed={...conn,name:"已改名",env:"prod" as const};
    expect(context.source).toContain("NC 测试 · 测试");
    expect(resultTargetIssue(context,renamed,"SCHEMA_A")).toBeNull();
    expect(resultTargetIssue(context,renamed,"SCHEMA_B")).toContain("SCHEMA_A");
    expect(resultTargetIssue(context,{...conn,user:"OTHER"},"SCHEMA_A")).toContain("连接目标已变化");
    expect(resultTargetIssue(context,null,"SCHEMA_A")).toContain("无法找到这份结果的原连接");
    expect(context.connectionKey).toBe(connectionKey(conn));
    expect(Object.isFrozen(context)).toBe(true);expect(Object.isFrozen(context.target)).toBe(true);
  });
  it("只修改其他语句、在前后插入语句不会误标旧结果", () => {
    const sql="select 1 from dual;\nselect 2 from dual;\nselect 3 from dual;";
    const context=contextFor(sql,1);
    expect(resultSqlState(context,sql.replace("select 1","select 10"))).toBe("unchanged");
    expect(resultSqlState(context,`select 0 from dual;\n${sql}`)).toBe("unchanged");
    expect(resultSqlState(context,sql.replace("select 1","select 10").replace("select 3","select 30"))).toBe("unchanged");
    expect(resultSqlState(context,sql.replace("select 2","select 20"))).toBe("changed");
    expect(resultSqlState(context,sql)).toBe("unchanged");
  });
  it("局部选择按真实偏移检查，外部脚本不冒充编辑器结果", () => {
    const editorSql="-- first\nselect 2 from dual; -- last";
    const target={text:"select 2 from dual",startLine:2,endLine:2,startOffset:9,endOffset:27,editorSql,editorVersion:9};
    const context=captureResultContext("c",conn,"SCHEMA_A",target.text,target);
    target.editorSql="overwritten";
    expect(context.target?.editorSql).toBe(editorSql);
    expect(resultSqlState(context,editorSql.replace("select 2","select 5"))).toBe("changed");
    expect(resultSqlState(captureResultContext("c",conn,undefined,"select 1"),"select 2")).toBeNull();
  });
});
