import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const jdk='D:/ncc/1909home/ufjdk';
const resources=join(desktop,'src-tauri/resources/svnkit');
test('SVNKit file repository: fixed history, blame and preserved conflict merge',()=>{
  assert.ok(existsSync(join(jdk,'bin/javac.exe')),'Java 8 JDK is required for offline SVN contract');
  const cache=join(desktop,'.cache');mkdirSync(cache,{recursive:true});
  const temporary=mkdtempSync(join(cache,'svn-history-contract-'));
  assert.ok(resolve(temporary).startsWith(resolve(cache)+sep));
  const cp=['ncsvn.jar','svnkit.jar','antlr-runtime-3.1.3.jar','trilead.jar','sqljet.1.0.4.jar'].map(file=>join(resources,file)).join(sep==='\\'?';':':');
  try {
    execFileSync(join(jdk,'bin/javac.exe'),['-encoding','UTF-8','-cp',cp,'-d',temporary,join(desktop,'src-tauri/svn-bridge/NcSvnHistoryContractTest.java')],{encoding:'utf8'});
    const output=execFileSync(join(jdk,'bin/java.exe'),['-Dfile.encoding=UTF-8','-cp',cp+(sep==='\\'?';':':')+temporary,'NcSvnHistoryContractTest',temporary],{encoding:'utf8',timeout:60000});
    assert.match(output,/SVN history contract passed: 25 checks/);
  } finally { if(resolve(temporary).startsWith(resolve(cache)+sep))rmSync(temporary,{recursive:true,force:true}); }
});
