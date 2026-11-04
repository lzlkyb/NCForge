import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const jdk=[process.env.JAVA_HOME,"D:/ncc/1909home/ufjdk","C:/ncc/1909home/ufjdk"].filter(Boolean).find(p=>existsSync(join(p,"bin/javac.exe")));
test("JDBC read-only and bound parameter contracts without a real database",()=>{
 const dir=mkdtempSync(join(tmpdir(),"ncforge-db-contract-"));
 try {
  const jar=join(root,"src-tauri/resources/ncdb/ncdb.jar");
  execFileSync(jdk?join(jdk,"bin/javac.exe"):"javac",["-encoding","UTF-8","-cp",jar,"-d",dir,join(root,"src-tauri/db-bridge/NcDbBridgeContractTest.java")],{stdio:"pipe"});
  const out=execFileSync(jdk?join(jdk,"bin/java.exe"):"java",["-cp",jar+(process.platform==="win32"?";":":")+dir,"NcDbBridgeContractTest"],{encoding:"utf8"});
  assert.match(out,/JDBC contracts passed/);
 }finally {const absolute=resolve(dir);assert.ok(absolute.startsWith(resolve(tmpdir())+sep) && absolute.split(sep).at(-1).startsWith("ncforge-db-contract-"));rmSync(absolute,{recursive:true});}
});
