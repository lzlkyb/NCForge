// UI fixtures only; no file is written outside the browser and no JVM is started.
export const codeFixture = String.raw`
window.codeWrites=[];window.codeMtime=1;
window.codeFiles={
 'A.java':'package demo;\npublic class A {\n    private String name;\n    public String getName() { return name; }\n    public void execute() {\n        System.out.println("A");\n    }\n}\n',
 'B.java':'package demo;\npublic class B {\n    public void execute() {\n        System.out.println("B");\n    }\n}\n'
};
for(let i=1;i<=18;i++){const name='File'+String(i).padStart(2,'0')+'.java';window.codeFiles[name]='public class File'+i+' {}\n';}
window.codeDebug={target:'server',state:'stopped',module:'demo',dapPort:5001,jdwpPort:8000,jdwpHost:'127.0.0.1',message:'',exceptionFilters:[]};
const codeSearch={hits:[{path:'A.java',line:6,text:'        System.out.println("A");',ranges:[{start:8,end:14}]},{path:'B.java',line:4,text:'        System.out.println("B");',ranges:[{start:8,end:14}]}],filesScanned:20,filesMatched:2,truncated:false,elapsedMs:10,scopeDirs:[],missingDirs:[],scopeFallback:false};
const codeMock=(cmd,args)=>{
 if(cmd==='fs_list_dir')return Object.keys(window.codeFiles).map(name=>({name,isDir:false,size:window.codeFiles[name].length}));
 if(cmd==='fs_read_file'){const name=args.path.split(/[\\/]/).at(-1);return {text:window.codeFiles[name]??'// 预览源码\n',encoding:'UTF-8',hasBom:false,eol:'LF',lossless:true,size:500,mtimeMs:window.codeMtime};}
 if(cmd==='fs_write_file'){window.codeWrites.push(args);window.codeFiles[args.path.split(/[\\/]/).at(-1)]=args.text;return ++window.codeMtime;}
 if(cmd==='fs_stat')return {isDir:false,size:500,mtimeMs:window.codeMtime};
 if(cmd==='fs_java_outline_source')return window.codeFiles[args.path.split(/[\\/]/).at(-1)]??'';
 if(cmd==='search_workspace')return codeSearch;
 if(cmd==='search_projects')return {projects:[{project:'验收工程',root:serviceRoot,outcome:codeSearch}],errors:[],truncated:false,elapsedMs:10};
 if(cmd==='debug_status')return {...window.codeDebug,target:args.target,state:args.target==='server'?window.codeDebug.state:'stopped'};
 if(cmd==='debug_start'){window.codeDebug.state='attached';return window.codeDebug;}
 if(cmd==='debug_threads')return {threads:[{id:1,name:'main'}]};
 if(cmd==='debug_stack_trace')return {stackFrames:[{id:1,name:'B.execute()',line:4,column:1,source:{path:serviceRoot+'/B.java'}}]};
 if(cmd==='debug_scopes')return {scopes:[{name:'局部变量',variablesReference:1,expensive:false}]};
 if(cmd==='debug_variables')return {variables:[{name:'name',value:'验收值',type:'String',variablesReference:0}]};
 if(cmd==='debug_set_exception_breakpoints'||cmd==='debug_set_breakpoints')return {};
 if(cmd==='debug_evaluate')return {result:'验收值',type:'String',variablesReference:0};
 if(cmd==='compile_module')return {ok:false,durationMs:100,sourceCount:20,errorCount:1,warningCount:0,problems:[{severity:'error',file:serviceRoot+'/B.java',line:4,message:'验收：方法调用错误'}],jarCount:0,rounds:1,outDir:serviceRoot+'/classes',diagnostics:[],modules:[{module:'demo',status:'failed',errorCount:1,warningCount:0,durationMs:100,sourceCount:20,outDir:serviceRoot+'/classes',cleaned:0,reason:'方法调用错误'}]};
 if(cmd==='local_history_list'||cmd==='local_history_capture'||cmd==='fs_source_roots')return [];
 return undefined;
};
`;
