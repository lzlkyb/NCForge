let previewRun=0;
// Browser-only simulation. No native IPC or database network connection.
import './query-preview.css';
const orderColumns=[{name:'ORDER_NO',type:'VARCHAR2'},{name:'CUSTOMER_NAME',type:'VARCHAR2'},{name:'AMOUNT',type:'NUMBER'},{name:'STATUS',type:'VARCHAR2'}];
const orderRows=Array.from({length:128},(_,i)=>['SO20261108'+String(128-i).padStart(4,'0'),['上海恒信贸易有限公司','北京中联数科有限公司','广州华远电子有限公司','深圳铭达实业有限公司'][i%4],[235600,98000,412350,76800][i%4],['已完成','已发货','处理中'][i%3]]);

import {mockIPC,mockWindows} from '/node_modules/@tauri-apps/api/mocks.js';
mockWindows('main'); window.dbCalls=[]; window.dbReadonly=false;
const tx=()=>({autoCommit:false,statements:0,rows:0,since:0});
const columns=[{name:'ID',type:'NUMBER',full:'NUMBER',pk:true,nullable:false,zh:'主键'},{name:'CODE',type:'VARCHAR2',full:'VARCHAR2(50)',pk:false,nullable:true,zh:'编码'},{name:'NAME',type:'VARCHAR2',full:'VARCHAR2(100)',pk:false,nullable:true,zh:'名称'}];
const conn={id:'c',name:'NC测试库',env:'test',source:'manual',url:'jdbc:oracle:thin:@localhost:1521/test',user:'NC_TEST',autoCommit:false,engine:'rust',hasPassword:true};
mockIPC(async (cmd,args)=>{
 window.dbCalls.push({cmd,args});
 if(cmd==='get_config') return {workspace_root:null,nc_home:null,autostart_enabled:false,lang_enabled:false,lang_auto_start:false,lang_xmx_mb:null,linked_overrides:[],auto_compile:false,deploy_on_start:false};
 if(cmd==='get_app_info') return {version:'0.1.0',platform:'windows',running:false};
 if(cmd==='get_autostart') return false;
 if(cmd==='resources_status' || cmd==='workspace_recent') return [];
 if(cmd==='db_conn_list') return [conn];
 if(cmd==='db_schema_cache') return null;
 if(cmd==='db_cached_tables') return {tables:[],fetchedAt:0};
 if(cmd==='db_connect') return {url:conn.url,user:conn.user,autoCommit:false,preparedSlot:'preview-slot',tables:[{name:'BD_ORDER',kind:'TABLE'},{name:'BD_CUSTOMER',kind:'TABLE'}],names:{bd_order:'订单',bd_customer:'客户'},schemas:['NC_TEST','PUBLIC'],current:'NC_TEST'};
 if(cmd==='db_caps') return {engine:'rust',connected:true,cancel:true,stats:true};
 if(cmd==='db_read_only') {if(args.enabled!==null) window.dbReadonly=args.enabled;return {readOnly:window.dbReadonly,tx:tx()};}
 if(cmd==='db_tx') return {tx:tx()};
 if(cmd==='db_meta') {
  if(args.kind==='schemas') return {schemas:['NC_TEST','PUBLIC'],current:'NC_TEST',user:'NC_TEST'};
  if(args.kind==='tables') return {tables:[{name:'TEST_TABLE',kind:'TABLE'},{name:'TEST_CHILD',kind:'TABLE'}]};
  if(args.kind==='columns') return {columns};
  if(args.kind==='objects') return {objects:[{name:'TEST_PKG',type:'PACKAGE',status:'VALID'}]};
  if(args.kind==='ncNames') return {names:{test_table:'测试主表',test_child:'测试子表'}};
  if(args.kind==='indexes') return {indexes:[]};
  if(args.kind==='ddl') return {ddl:'create table TEST_TABLE (ID number primary key)'};
  return {names:{}};
 }
 if(cmd==='db_slot_acquire') return {slot:'preview-slot',tx:tx()};
 if(cmd==='db_cancel') { window.previewCancel?.(); return null; }
 // `db_exec_result` 是控制台真正走的命令（带 resultId 的游标式执行）。缺了它，
 // 预览里一按执行就立刻失败，慢查询/停止那条演示路径根本走不到。
 if(cmd==='db_exec' || cmd==='db_exec_bound' || cmd==='db_exec_result') {
   const scenario=window.previewScenario || 'success';
   const run=++previewRun;
   const started=performance.now();
   window.dispatchEvent(new CustomEvent('preview-query',{detail:{state:'running',scenario}}));
   let cancelled=false;
   await new Promise(resolve=>{
     const timer=setTimeout(resolve,scenario==='fast'?90:scenario==='slow'?12000:3200);
     window.previewCancel=()=>{cancelled=true;clearTimeout(timer);setTimeout(resolve,450);window.dispatchEvent(new CustomEvent('preview-query',{detail:{state:'cancelling',scenario}}));};
   });
   window.previewCancel=null;
   const ms=Math.round(performance.now()-started);
   const state=cancelled?'cancelled':scenario==='error'?'error':scenario==='empty'?'empty':'success';
   window.dispatchEvent(new CustomEvent('preview-query',{detail:{state,scenario,ms}}));
   if(cancelled) throw 'cancelled|ORA-01013: 用户请求取消当前操作';
   if(scenario==='error') throw 'ORA-00942: 表或视图不存在';
   return {kind:'rows',columns:orderColumns,rows:scenario==='empty'?[]:orderRows.map((row,i)=>i===0?[row[0],row[1],Number(row[2])+run*100,row[3]]:row),hasMore:false,rowCount:scenario==='empty'?0:128,output:[],ms,tx:tx()};
 }
 if(cmd==='server_status' || cmd==='client_status') return {state:'stopped'};
 if(cmd==='nc_home_probe') return {root:null};
 if(cmd==='db_slot_release' || cmd==='db_disconnect') return null;
 if(cmd==='db_relations') return {foreign:{kind:'rows',columns:['RELATION','SOURCE_TABLE','SOURCE_COLUMN','TARGET_TABLE','TARGET_COLUMN','POSITION'].map(name=>({name,type:'VARCHAR2'})),rows:[['FK_CHILD','TEST_CHILD','ID','TEST_TABLE','ID',1]],hasMore:false},references:{kind:'rows',columns:[],rows:[]},notes:['NC类引用不可用：当前库缺少元数据表'],sharedSession:false};
 if(cmd==='nc_md_dict') return {tables:[],missing:[],tableCount:0,columnCount:0};
 if(cmd==='plugin:window|is_visible') return true;
 if(cmd==='plugin:window|is_maximized') return false;
 if(cmd.startsWith('plugin:')) return null;
 return null;
},{shouldMockEvents:true});

localStorage.setItem('ncforge-db-tabs',JSON.stringify({tabs:[{kind:'sql',id:'query-preview',title:'订单查询',connId:'c',sql:"SELECT order_no, customer_name, amount, status\nFROM bd_order\nWHERE created_at >= DATE '2026-11-01'\nORDER BY created_at DESC;",maxRows:500,timeoutSec:30}],active:'query-preview'}));
localStorage.setItem('ncforge-db-result-height','420');
await import('/src/main.tsx');
const store=await import('/src/lib/dbStore.ts');
await store.loadConns();
await store.connect('c');
await import('./query-controls.tsx');
