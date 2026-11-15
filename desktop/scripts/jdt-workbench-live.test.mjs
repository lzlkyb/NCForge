#!/usr/bin/env node
// A bounded real JDT LS probe. All edits remain plans inside an isolated fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { clearTimeout } from 'node:timers';
import { mkdirSync,writeFileSync,readFileSync,copyFileSync,mkdtempSync,rmSync,readdirSync,existsSync } from 'node:fs';
import { resolve,join,dirname,sep } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ls=process.env.NCFORGE_JDTLS_DIR??join(desktop,'src-tauri/resources/jdtls');
const java=process.env.NCFORGE_JAVA_HOME?join(process.env.NCFORGE_JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'D:/ncc/1909home/ufjdk/bin/java.exe';
const base=resolve(desktop,'src-tauri/target/test-tmp');mkdirSync(base,{recursive:true});
const fixture=mkdtempSync(join(base,'ncf-jdt-workbench-'));assert.ok(fixture.startsWith(base+sep));
const project=join(fixture,'nc-forge-shadow'),src=join(project,'src/p');mkdirSync(src,{recursive:true});mkdirSync(join(project,'src/q'),{recursive:true});
const sources={
  'A.java':`package p;
public class A implements I {
  private int count;
  private int[] values = new int[2];
  /**
   * @param first first amount with {@code first} detail
   * @param second second amount
   * @param <T> preserved type parameter
   * @return combined amount
   */
  public <T> int mix(int first, int second) { return first + second; }
  public int caller() { return mix(mix(1, 2), 3); }
  public void nullable(Object value) { if (value == null) { System.out.println("null"); } }
  public boolean repeated(Object a, Object b) { return a == a || a == b; }
  public int inline() { int number = 4; return number + 1; }
  private int plus(int a, int b) { return a + b; }
  public int inlineCall() { return plus(1, 2); }
  public void accesses() { count = 1; int n = count; count += 2; ++count; count--; values[0] = count; this.count = 3; }
}
`,
  'I.java':'package p;\npublic interface I { <T> int mix(int first, int second); }\n',
  'Uses.java':'package p;\npublic class Uses { public int use(I a) { return a.mix(4, 5); } }\n',
  'SignatureCases.java':`package p;
public class SignatureCases {
  private int value = 10;
  public int field(int x) { return value + x; }
  public int local(int x) { int next = 1; return x + next; }
  public int lambda(int x) { java.util.function.IntUnaryOperator f = next -> x + next; return f.applyAsInt(1); }
  public int nestedField(int x) { class Inner { int next = 2; int read() { return x + next; } } return new Inner().read(); }
  public int nestedLocal(int x) { class Inner { int read() { int next = 2; return x + next; } } return new Inner().read(); }
  public int nestedParameter(int x) { class Inner { int read(int next) { return x + next; } } return new Inner().read(2); }
  static abstract class Parent { int next = 2; abstract int read(); }
  public int nestedInherited(int x) { class Inner extends Parent { int read() { return x; } } return new Inner().read(); }
  public int anonymousInherited(int x) { Parent inner = new Parent() { int read() { return x; } }; return inner.read(); }
  public int qualified(int x) { return this.value + x; }
  public int removed(int x) { java.util.function.IntSupplier f = () -> x; return f.getAsInt(); }
  public int swapped(int a, int b) { return a - b; }
  public long widen(int x) { return x; }
  public int platformPackage(int x) { return java.lang.Math.abs(x); }
  public int ownPackage(int x) { return root.Type.abs(x); }
}
`,
  'GenericI.java':'package p;\npublic interface GenericI<T> { void put(T value, int n); void array(T value[], int n); }\n',
  'GenericImpl.java':'package p;\npublic class GenericImpl implements GenericI<String> { public void put(String value, int n) {} public void array(String value[], int n) {} }\n',
  'GenericUse.java':'package p;\npublic class GenericUse { public void use(GenericI<String> target) { target.put("value", 1); target.array(new String[]{"value"}, 2); } }\n',
  'VarargsI.java':'package p;\npublic interface VarargsI<T> { void vary(int n, T[] values); }\n',
  'VarargsImpl.java':'package p;\npublic class VarargsImpl implements VarargsI<String> { public void vary(int n, String... values) {} }\n',
};
for(const[name,text]of Object.entries(sources))writeFileSync(join(src,name),text);
const rootType=join(project,'src/root/Type.java'),rootTypeText='package root;\npublic class Type { public static int abs(int x) { return java.lang.Math.abs(x); } }\n';
mkdirSync(dirname(rootType),{recursive:true});writeFileSync(rootType,rootTypeText);
writeFileSync(join(src,'note.xml'),'<config class="p.A"/>\n');
writeFileSync(join(project,'.project'),'<projectDescription><name>nc-forge-shadow</name><projects/><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>');
writeFileSync(join(project,'.classpath'),'<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-1.8"/><classpathentry kind="output" path="bin"/></classpath>');
mkdirSync(join(project,'.settings'));writeFileSync(join(project,'.settings/org.eclipse.core.resources.prefs'),'eclipse.preferences.version=1\nencoding/<project>=UTF-8\n');
const config=join(fixture,'config');mkdirSync(config);copyFileSync(join(ls,process.platform==='win32'?'config_win':'config_linux','config.ini'),join(config,'config.ini'));
const launcher=readdirSync(join(ls,'plugins')).find(name=>name.startsWith('org.eclipse.equinox.launcher_')&&name.endsWith('.jar'));assert.ok(launcher);assert.ok(existsSync(java));
const runtime=dirname(dirname(java)),uri=pathToFileURL(join(src,'A.java')).href,rootUri=pathToFileURL(project).href;
const settings={java:{configuration:{runtimes:[{name:'JavaSE-1.8',path:runtime,default:true}]},autobuild:{enabled:false},errors:{incompleteClasspath:{severity:'ignore'}}}};
const child=spawn(java,['-Declipse.application=org.eclipse.jdt.ls.core.id1','-Dosgi.bundles.defaultStartLevel=4','-Declipse.product=org.eclipse.jdt.ls.core.product','-noverify','-Xmx512m','-jar',join(ls,'plugins',launcher),'-configuration',config,'-data',join(fixture,'data')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
let buffer=Buffer.alloc(0),nextId=1,stderr='',readyResolve;const pending=new Map();const ready=new Promise(resolve=>{readyResolve=resolve;});
function send(message){const body=Buffer.from(JSON.stringify(message));child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);child.stdin.write(body);}
function request(method,params,timeout=60000){return new Promise((resolve,reject)=>{const id=nextId++,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out\n${stderr.slice(-3000)}`));},timeout);pending.set(id,{resolve,reject,timer});send({jsonrpc:'2.0',id,method,params});});}
function notify(method,params){send({jsonrpc:'2.0',method,params});}
child.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-16000);});
child.stdout.on('data',data=>{buffer=Buffer.concat([buffer,data]);while(true){const header=buffer.indexOf('\r\n\r\n');if(header<0)return;const match=/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0,header).toString());if(!match){buffer=buffer.subarray(header+4);continue;}const length=Number(match[1]);if(buffer.length<header+4+length)return;const message=JSON.parse(buffer.subarray(header+4,header+4+length).toString());buffer=buffer.subarray(header+4+length);
    if(message.id!==undefined&&message.method){let result=null;if(message.method==='workspace/configuration')result=(message.params?.items??[]).map(()=>settings);if(message.method==='workspace/workspaceFolders')result=[{uri:rootUri,name:'probe'}];if(message.method==='workspace/applyEdit')result={applied:false,failureReason:'probe never applies server edits'};send({jsonrpc:'2.0',id:message.id,result});}
    else if(message.id!==undefined){const item=pending.get(message.id);if(item){pending.delete(message.id);clearTimeout(item.timer);if(message.error)item.reject(new Error(JSON.stringify(message.error)));else item.resolve(message.result);}}
    else if(message.method==='language/status'&&message.params?.type==='ServiceReady')readyResolve();
  }});
child.on('exit',code=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error(`JDT exited ${code}: ${stderr}`));}pending.clear();});
const checks=[],failures=[];
function at(token,file='A.java'){const index=sources[file].indexOf(token);assert.ok(index>=0);const before=sources[file].slice(0,index),lines=before.split('\n');return{line:lines.length-1,character:lines.at(-1).length};}
async function execute(command,args,file='A.java'){return request('workspace/executeCommand',{command,arguments:[{uri:pathToFileURL(join(src,file)).href,...args}]});}
async function signature(file,token,change){const position=at(token,file),info=await execute('ncforge.signatureWorkbench',{...position,mode:'info'},file);return execute('ncforge.signatureWorkbench',{...position,name:info.name,parameters:info.parameters,...change(info)},file);}
function textAfter(response,file='A.java'){
  const target=pathToFileURL(join(src,file)).href.toLowerCase(),edits=[];
  for(const[path,changes]of Object.entries(response.edit?.changes??{}))if(path.toLowerCase()===target)edits.push(...changes);
  for(const change of response.edit?.documentChanges??[])if(change.textDocument?.uri.toLowerCase()===target)edits.push(...change.edits);
  const text=sources[file],starts=[0];for(let i=0;i<text.length;i++)if(text[i]==='\n')starts.push(i+1);
  const changes=edits.map(edit=>({start:starts[edit.range.start.line]+edit.range.start.character,end:starts[edit.range.end.line]+edit.range.end.character,text:edit.newText})).sort((a,b)=>a.start-b.start);
  for(let i=1;i<changes.length;i++)assert.ok(changes[i].start>=changes[i-1].end,'text edits must not overlap');
  let result=text;for(const change of changes.reverse())result=result.slice(0,change.start)+change.text+result.slice(change.end);return result;
}
async function check(name,run){try{await run();checks.push(name);console.log(`PASS ${name}`);}catch(error){failures.push(name);console.error(`FAIL ${name}: ${String(error)}`);}}
try{
  console.log('Starting bounded JDT fixture (512 MiB heap)…');
  const initialized=await request('initialize',{processId:process.pid,rootUri,rootPath:project,workspaceFolders:[{uri:rootUri,name:'probe'}],capabilities:{workspace:{workspaceFolders:true,configuration:true,applyEdit:false,workspaceEdit:{documentChanges:true,resourceOperations:['create','rename','delete']}},textDocument:{publishDiagnostics:{}}},initializationOptions:{settings,bundles:[join(desktop,'src-tauri/resources/jdtls-ext/ncforge-jdt-ext.jar')],extendedClientCapabilities:{classFileContentsSupport:true}}});
  assert.ok(initialized.capabilities.executeCommandProvider.commands.includes('ncforge.signatureWorkbench'),'extension command must register');notify('initialized',{});
  let timer;try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('JDT ServiceReady timed out')),90000);})]);}finally{clearTimeout(timer);}
  for(const[file,text]of Object.entries(sources))notify('textDocument/didOpen',{textDocument:{uri:pathToFileURL(join(src,file)).href,languageId:'java',version:1,text}});
  notify('textDocument/didOpen',{textDocument:{uri:pathToFileURL(rootType).href,languageId:'java',version:1,text:rootTypeText}});
  await check('signature override + call-site + nested reorder',async()=>{
    const position=at('mix(int');const info=await execute('ncforge.signatureWorkbench',{...position,mode:'info'});assert.equal(info.parameters.length,2);
    const response=await execute('ncforge.signatureWorkbench',{...position,name:'blend',parameters:[{...info.parameters[1]},{...info.parameters[0]}]});
    const changed=textAfter(response);assert.match(changed,/blend\(\s*blend\(\s*2,\s*1\s*\),\s*3\s*\)|blend\(\s*3,\s*blend\(\s*2,\s*1\s*\)\s*\)/);
    assert.match(changed,/blend\(\s*3,\s*blend\(\s*2,\s*1\s*\)\s*\)/,'outer and inner invocation must both reorder');
    assert.match(textAfter(response,'I.java'),/blend\(int second, int first\)/);assert.match(textAfter(response,'Uses.java'),/a\.blend\(5, 4\)/);assert.ok(response.before.length>=3);
    assert.match(changed,/@param first first amount with \{@code first\} detail/);assert.match(changed,/@param second second amount/);assert.match(changed,/@param <T> preserved type parameter/);assert.match(changed,/@return combined amount/);
    const renamed=await execute('ncforge.signatureWorkbench',{...position,name:'blend',parameters:[{...info.parameters[1],name:'right'},{...info.parameters[0],name:'left'}]});
    assert.match(textAfter(renamed),/@param left first amount with \{@code first\} detail/);assert.match(textAfter(renamed),/@param right second amount/);assert.match(textAfter(renamed),/return left \+ right/);
  });
  await check('signature rename and added parameter reject field capture',async()=>{
    await assert.rejects(signature('SignatureCases.java','field(int',info=>({parameters:[{...info.parameters[0],name:'value'}]})),/捕获|冲突/);
    await assert.rejects(signature('SignatureCases.java','field(int',info=>({parameters:[...info.parameters,{index:-1,name:'value',type:'int',value:'0'}]})),/捕获|冲突/);
  });
  await check('signature rename and added parameter reject package qualifier capture',async()=>{
    for(const [method,name] of [['platformPackage','java'],['ownPackage','root']]){
      await assert.rejects(signature('SignatureCases.java',`${method}(int`,info=>({parameters:[{...info.parameters[0],name}]})),/捕获|冲突/);
      await assert.rejects(signature('SignatureCases.java',`${method}(int`,info=>({parameters:[...info.parameters,{index:-1,name,type:'int',value:'0'}]})),/捕获|冲突/);
    }
    const safe=await signature('SignatureCases.java','platformPackage(int',info=>({parameters:[{...info.parameters[0],name:'amount'}]}));assert.match(textAfter(safe,'SignatureCases.java'),/platformPackage\(int amount\)\s*\{ return java\.lang\.Math\.abs\(amount\);/);
  });
  await check('signature rejects local, lambda and nested declaration collisions',async()=>{
    for(const method of ['local','lambda','nestedField','nestedLocal','nestedParameter','nestedInherited','anonymousInherited'])await assert.rejects(signature('SignatureCases.java',`${method}(int`,info=>({parameters:[{...info.parameters[0],name:'next'}]})),/捕获|冲突/);
  });
  await check('signature keeps qualified fields and simultaneous parameter renames safe',async()=>{
    const qualified=await signature('SignatureCases.java','qualified(int',info=>({parameters:[{...info.parameters[0],name:'value'}]}));assert.match(textAfter(qualified,'SignatureCases.java'),/qualified\(int value\)\s*\{ return this\.value \+ value;/);
    const swapped=await signature('SignatureCases.java','swapped(int',info=>({parameters:[{...info.parameters[0],name:'b'},{...info.parameters[1],name:'a'}]}));assert.match(textAfter(swapped,'SignatureCases.java'),/swapped\(int b, int a\)\s*\{ return b - a;/);
    await assert.rejects(signature('SignatureCases.java','removed(int',()=>({parameters:[]})),/移除的参数仍/);
  });
  await check('signature preserves specialized generic types from either declaration',async()=>{
    for(const file of ['GenericI.java','GenericImpl.java']){
      const response=await signature(file,'put(',info=>({parameters:[info.parameters[1],info.parameters[0]]}));
      assert.match(textAfter(response,'GenericI.java'),/put\(int n, T value\)/);assert.match(textAfter(response,'GenericImpl.java'),/put\(int n, String value\)/);assert.match(textAfter(response,'GenericUse.java'),/target\.put\(1, "value"\)/);
    }
    const array=await signature('GenericI.java','array(',info=>({parameters:[info.parameters[1],info.parameters[0]]}));
    assert.match(textAfter(array,'GenericI.java'),/array\(int n, T value\[\]\)/);assert.match(textAfter(array,'GenericImpl.java'),/array\(int n, String value\[\]\)/);assert.match(textAfter(array,'GenericUse.java'),/target\.array\(2, new String\[\]\s*\{\s*"value"\s*\}\)/);
  });
  await check('signature rejects varargs overrides selected through an array interface',async()=>{
    await assert.rejects(signature('VarargsI.java','vary(',info=>({parameters:[info.parameters[1],info.parameters[0]]})),/可变参数/);
  });
  await check('signature rejects unsafe generic type edits but applies ordinary explicit edits',async()=>{
    await assert.rejects(signature('GenericI.java','put(',info=>({parameters:[{...info.parameters[0],type:'Object'},info.parameters[1]]})),/泛型.*类型/);
    await assert.rejects(signature('GenericImpl.java','put(',info=>({parameters:[{...info.parameters[0],type:'Object'},info.parameters[1]]})),/泛型.*类型/);
    await assert.rejects(signature('GenericI.java','put(',info=>({parameters:[...info.parameters,{index:-1,name:'added',type:'T',value:'null'}]})),/泛型.*类型/);
    const widened=await signature('SignatureCases.java','widen(int',info=>({parameters:[{...info.parameters[0],type:'long'}]}));assert.match(textAfter(widened,'SignatureCases.java'),/widen\(long x\)/);
    const inferred=await execute('ncforge.signatureWorkbench',{...at('target.put','GenericUse.java'),character:at('target.put','GenericUse.java').character+7,mode:'info'},'GenericUse.java');assert.equal(inferred.parameters[0].type,'T');
  });
  await check('structural null rewrite and repeated capture',async()=>{
    const response=await execute('ncforge.structuralSearch',{scope:'file',pattern:'$value$ == null',replacement:'java.util.Objects.isNull($value$)'});assert.equal(response.matches.length,1);assert.match(textAfter(response),/Objects\.isNull\(value\)/);
    const repeated=await execute('ncforge.structuralSearch',{scope:'file',pattern:'$same$ == $same$'});assert.equal(repeated.matches.length,1);assert.match(repeated.matches[0].text,/a\s*==\s*a/);
  });
  await check('inline local variable',async()=>{const response=await execute('ncforge.refactorWorkbench',{...at('number ='),length:6,kind:'inlineVariable'});assert.match(textAfter(response),/return 4 \+ 1/);assert.doesNotMatch(textAfter(response),/int number/);});
  await check('inline method',async()=>{const response=await execute('ncforge.refactorWorkbench',{...at('plus(1'),length:4,kind:'inlineMethod'});assert.doesNotMatch(textAfter(response),/return plus\(1, 2\)/);});
  await check('visibility plan',async()=>{const response=await execute('ncforge.refactorWorkbench',{...at('count;'),kind:'visibility',target:'public'});assert.match(textAfter(response),/public int count/);assert.ok(response.warnings.length);});
  await check('class rename resource operation and source snapshots',async()=>{const response=await execute('ncforge.refactorWorkbench',{...at('A implements'),kind:'rename',target:'RenamedA'});assert.ok(response.edit.documentChanges.some(change=>change.kind==='rename'&&change.newUri.endsWith('RenamedA.java')));assert.ok(response.before.some(item=>item.uri===uri));});
  await check('package rename expands Java and XML file moves',async()=>{const response=await execute('ncforge.refactorWorkbench',{...at('A implements'),kind:'renamePackage',target:'renamed'});const moves=response.edit.documentChanges.filter(change=>change.kind==='rename');assert.ok(moves.some(move=>move.oldUri.endsWith('A.java')));assert.ok(moves.some(move=>move.oldUri.endsWith('note.xml')));assert.ok(response.before.some(item=>item.uri.endsWith('note.xml')));});
  await check('move type updates semantic package and references',async()=>{const response=await execute('ncforge.refactorWorkbench',{...at('A implements'),kind:'moveType',target:'q'});assert.ok(response.edit.documentChanges.some(change=>change.kind==='rename'&&change.newUri.includes('/q/A.java')));assert.ok(response.before.some(item=>item.uri===uri));});
  await check('field reads/writes and array element access',async()=>{
    const count=await execute('ncforge.fieldAccesses',{...at('count;')});const kinds=count.references.map(item=>item.access);assert.ok(kinds.filter(kind=>kind==='write').length>=2);assert.ok(kinds.filter(kind=>kind==='readWrite').length>=3);assert.ok(kinds.filter(kind=>kind==='read').length>=2);assert.ok(count.references.every(item=>item.accurate));
    const values=await execute('ncforge.fieldAccesses',{...at('values =')});assert.equal(values.references[0].access,'read','writing an array element only reads the field that holds the array');
  });
  await check('batch inspect and organize-import plan',async()=>{const response=await execute('ncforge.batchInspect',{scope:'module',mode:'inspect'});assert.ok(response.filesScanned>=3);assert.equal(response.issues.filter(issue=>issue.severity==='error').length,0);const fix=await execute('ncforge.batchInspect',{scope:'module',mode:'organizeImports'});assert.ok(fix.edit);});
  await check('actual classpath report',async()=>{const response=await execute('ncforge.projectClasspath',{mode:'read'});assert.equal(response.project,'nc-forge-shadow');assert.ok(response.entries.length>=2);});
  for(const[file,text]of Object.entries(sources))assert.equal(readFileSync(join(src,file),'utf8'),text,'probes must not write fixture source files');
  assert.equal(readFileSync(rootType,'utf8'),rootTypeText,'probes must not write the package qualifier fixture');
  console.log(`JDT live probe: ${checks.length} checks passed; fixture source files unchanged.`);
  assert.equal(failures.length,0,`failed checks: ${failures.join(', ')}`);
}catch(error){console.error(error);console.error(stderr.slice(-5000));const log=join(fixture,'data/.metadata/.log');if(existsSync(log))console.error(readFileSync(log,'utf8').slice(-12000));process.exitCode=1;}
finally{
  try{await request('shutdown',null,5000);notify('exit',null);}catch{child.kill();}
  if(child.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  for(const item of pending.values())clearTimeout(item.timer);assert.ok(fixture.startsWith(base+sep));rmSync(fixture,{recursive:true,force:true});
}
