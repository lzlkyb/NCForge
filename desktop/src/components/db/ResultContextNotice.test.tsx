// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ResultContextNotice } from "./ResultContextNotice";
import { captureResultContext } from "../../lib/dbResultContext";
import { __resetDbForTest, openSqlTab, setConns, setSqlDraft, useDbSelector } from "../../lib/dbStore";
import type { DbConn } from "../../lib/dbApi";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../../lib/tauri",()=>({invoke:vi.fn()}));
const host=document.createElement("div"),root=createRoot(host);
afterEach(()=>{act(()=>root.render(null));__resetDbForTest();});
it("编辑 SQL 只更新旧结果提示，不让结果网格跟着每次输入重渲染",()=>{
  __resetDbForTest();
  const conn={id:"c",name:"TEST",env:"test",source:"manual",url:"jdbc:test",user:"NC",engine:"java",propDs:null} as DbConn;
  setConns([conn]);
  const sql="select 1 from dual;",id=openSqlTab("c",sql);
  const context=captureResultContext("c",conn,undefined,sql,{text:sql,startLine:1,startOffset:0,endOffset:sql.length,editorSql:sql,editorVersion:1});
  let gridRenders=0;
  function GridConsumer(){useDbSelector(s=>s.tabs.find(t=>t.id===id));gridRenders++;return null;}
  act(()=>root.render(<><GridConsumer/><ResultContextNotice tabId={id} context={context}/></>));
  expect(host.textContent).toBe("");
  act(()=>setSqlDraft(id,"select 2 from dual;"));
  expect(host.textContent).toContain("SQL 已修改，结果尚未更新");
  expect(gridRenders).toBe(1);
  act(()=>setSqlDraft(id,sql));
  expect(host.textContent).toBe("");expect(gridRenders).toBe(1);
});
