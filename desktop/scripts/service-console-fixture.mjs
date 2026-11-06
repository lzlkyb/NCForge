// Bounded fixtures for the real production console. No NC process is launched.
export const serviceFixture = `
window.serviceCalls=[];window.serviceErrors=false;
const serviceRoot='D:/验收工程';
const common={state:'stopped',pid:null,startedAtMs:null,runId:'initial',launchPhase:null,launchStartedAtMs:null,uptimeMs:null,port:80,logPath:'D:/config/logs/middleware.log',logSize:200000,java:'D:/NC/ufjdk/bin/java.exe',classpathEntries:7000,mainClass:'nc.bs.framework.test.StartDirectServer',commandLine:'java -Xmx4096m',exitCode:null,reason:null,projectRoot:serviceRoot,ncHome:'D:/NC',heapMb:4096,defaultHeapMb:4096,debugPort:null};
window.serviceStatus={middleware:{...common,portAddress:'127.0.0.1',portFromConfig:true,portConfigPath:'D:/NC/ierp/bin/prop.xml',portOwner:null,portOwnedBySelf:false},client:{...common,host:'10.0.0.8',port:9080,serverReachable:true,logPath:'D:/config/logs/client.log',mainClass:'nc.starter.test.JStarter',heapMb:768,defaultHeapMb:768}};
const startup=['===== 普通启动输出 =====','[nc-forge] 检查环境','java -Xmx4096m '+Array.from({length:150},(_,i)=>'-D参数'+i+'=完整中文值').join(' ')];
const lines=Array.from({length:3991},(_,i)=>'12:04:03 [main] INFO nc.demo.Logger - 正常日志 '+i);
window.serviceLogs={middleware:[startup.concat(lines,['12:04:05 [main] ERROR nc.demo.Logger - java.lang.IllegalStateException: 启动失败','    at nc.demo.Start.run(Start.java:23)','Caused by: java.net.BindException: 端口冲突','    at nc.demo.Start.main(Start.java:42)','    ... 2 more','12:04:06 [main] INFO nc.demo.Logger - 后续上下文']).join('\\n')+'\\n','上次运行中文日志\\n12:00:00 [main] WARN nc.demo.Logger - 历史警告\\n'],client:['客户端普通输出\\n12:05:00 [main] INFO nc.demo.Client - 客户端日志\\n','上次客户端日志\\n']};
const encoder=new TextEncoder();
const logPage=(args,tail)=>{const all=window.serviceLogs[args.target][args.previous?1:0],bytes=encoder.encode(all),id=args.target+'-'+(args.previous?'previous':window.serviceStatus[args.target].runId),reset=!!args.fileId&&args.fileId!==id;let end=tail?(args.before??bytes.length):bytes.length,start=tail?Math.max(0,end-256*1024):(reset?0:args.offset);end=Math.min(end,bytes.length);if(tail&&start>0){while(start<end&&bytes[start-1]!==10)start++;}const text=new TextDecoder().decode(bytes.slice(start,Math.min(end,start+256*1024))),lineOffsets=[start];let at=start;for(const l of text.split('\\n').slice(0,-1)){at+=encoder.encode(l+'\\n').length;lineOffsets.push(at);}return {text,startOffset:start,offset:start+encoder.encode(text).length,fileId:id,size:bytes.length,eof:end===bytes.length,reset,truncated:false,lineOffsets};};
const serviceMock=(cmd,args)=>{
 window.serviceCalls.push({cmd,args});
 if(cmd==='get_workspace')return serviceRoot;
 if(cmd==='tree_projects')return [{name:'验收工程',root:serviceRoot,origin:'primary',depth:0,exported:true,classDirs:[],disabled:false,hasClasspath:true}];
 if(['fs_list_dir','fs_encoding_marks','workspace_recent','local_history_list','lang_diagnostics','breakpoints_list'].includes(cmd))return [];
 if(cmd==='lang_status')return {state:'stopped',ready:false};
 if(cmd==='server_status'||cmd==='client_status'){if(window.serviceErrors)throw Error('读取状态失败');return {...window.serviceStatus[cmd==='server_status'?'middleware':'client']};}
 if(cmd==='service_log_read'||cmd==='service_log_tail'){if(window.logReadError)throw Error('读取文件失败');return logPage(args,cmd==='service_log_tail');}
 if(cmd==='service_log_clear')return {offset:encoder.encode(window.serviceLogs[args.target][0]).length,rotated:false};
 if(cmd==='service_log_export')return new Promise((resolve,reject)=>{window.logExportArgs=args;window.logExportResolve=()=>resolve({path:'D:/验收/日志.log',bytes:100000,canceled:false,ms:1000});window.logExportCancel=()=>resolve(null);window.logExportReject=reject;});
 if(cmd==='service_log_cancel_export'){window.logExportCancel?.();return null;}
 if(cmd==='server_start'||cmd==='client_start'){const target=cmd==='server_start'?'middleware':'client';Object.assign(window.serviceStatus[target],{state:'starting',runId:args.requestId,launchPhase:'准备 classpath',launchStartedAtMs:Date.now(),pid:null});window.startResolve=()=>{Object.assign(window.serviceStatus[target],{state:'running',pid:target==='client'?8002:8001,launchPhase:null,portOwnedBySelf:target==='middleware',portOwner:target==='middleware'?{pid:8001,name:'java.exe'}:null});return args.requestId;};return window.holdStart?new Promise((resolve,reject)=>{window.startFinish=()=>resolve(window.startResolve());window.startReject=reject;}):window.startResolve();}
 if(cmd==='server_stop'||cmd==='client_stop'){const target=cmd==='server_stop'?'middleware':'client';if(args.expectedRunId&&args.expectedRunId!==window.serviceStatus[target].runId)return 'idle';Object.assign(window.serviceStatus[target],{state:'stopped',pid:null,launchPhase:null,portOwner:null,portOwnedBySelf:false});window.startReject?.(Error('CANCELLED:启动已取消'));window.startReject=null;return 'stopped';}
 if(cmd==='deploy_status')return {home:'D:/NC',manifestPath:'D:/manifest',hasManifest:false,combo:[],files:0,written:0,backups:0,updatedMs:0};
 if(cmd==='deploy_apply'){if(window.deployError)throw Error('投送失败');return {home:'D:/NC',projectRoots:[serviceRoot],comboChanged:false,previousCombo:[],planned:0,created:[],updated:[],adopted:[],unchanged:0,conflicts:[],skipped:[],applied:true,backupRoot:'D:/backup',manifestPath:'D:/manifest'};}
 if(cmd==='search_types')return {workspace:[{name:'nc.demo.Start',simple:'Start',package:'nc.demo',kind:5,file:serviceRoot+'/src/nc/demo/Start.java',module:'demo',jar:'',line:1,column:1}],jars:[],jarsPending:false,elapsedMs:1};
 if(cmd==='fs_read_file')return {text:Array.from({length:60},(_,i)=>'// 源码行 '+(i+1)).join('\\n'),encoding:'UTF-8',hasBom:false,eol:'LF',lossless:true,size:500,mtimeMs:1};
 if(cmd==='local_history_sweep')return {removed:0};
 if(cmd==='auto_compile_status'||cmd==='worker_stats')return {state:'idle',available:false};
 if(cmd==='server_hotwebs')return {all:['uap'],active:['uap'],default:['uap'],configured:null};
 if(cmd==='server_command_line'||cmd==='client_command_line')return {commandLine:'java -Xmx4096m',classpathJar:'D:/cp.jar',entryCount:7000,workDir:'D:/NC',java:common.java,endpoints:{httpPort:80,httpAddress:'127.0.0.1',servicePort:9080,configPath:'D:/prop.xml',fromConfig:true},heapMb:4096,reused:false};
 if(cmd.endsWith('_reveal_log'))return null;
 return undefined;
};
`;
