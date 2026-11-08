import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const jdk=[process.env.JAVA_HOME,"D:/ncc/1909home/ufjdk","C:/ncc/1909home/ufjdk"].filter(Boolean).find(p=>existsSync(join(p,"bin/javac.exe")));
test("Rust / JVM 桥共用同一条事务真源 SQL 与同一套 LOB 截断文案",()=>{
 const rust=readFileSync(join(root,"src-tauri/src/db_rust.rs"),"utf8");
 const java=readFileSync(join(root,"src-tauri/db-bridge/NcDbBridge.java"),"utf8");
 const front=readFileSync(join(root,"src/lib/db.ts"),"utf8");
 const rs=rust.match(/pub\(crate\) const TX_ACTIVE_SQL: &str = "([^"]+)"/);
 const jv=java.match(/private static final String TX_ACTIVE_SQL = "([^"]+)"/);
 assert.ok(rs && jv,"两个引擎都要定义 TX_ACTIVE_SQL");
 assert.equal(rs[1],jv[1],"两个引擎必须问同一条字典视图");
 // 全量通道的 1M 截断尾巴：Rust 生成 / Rust 判定 / Java 生成 / 前端契约注释
 assert.match(rust,/只取前 1M/);
 assert.match(java,/只取前 1M/);
 assert.match(front,/只取前 1M/);
});
test("JDBC read-only and bound parameter contracts without a real database",()=>{
 const dir=mkdtempSync(join(tmpdir(),"ncforge-db-contract-"));
 try {
  const jar=join(root,"src-tauri/resources/ncdb/ncdb.jar");
  execFileSync(jdk?join(jdk,"bin/javac.exe"):"javac",["-encoding","UTF-8","-cp",jar,"-d",dir,join(root,"src-tauri/db-bridge/NcDbBridgeContractTest.java")],{stdio:"pipe"});
  const out=execFileSync(jdk?join(jdk,"bin/java.exe"):"java",["-cp",jar+(process.platform==="win32"?";":":")+dir,"NcDbBridgeContractTest"],{encoding:"utf8"});
  assert.match(out,/JDBC contracts passed/);
 }finally {const absolute=resolve(dir);assert.ok(absolute.startsWith(resolve(tmpdir())+sep) && absolute.split(sep).at(-1).startsWith("ncforge-db-contract-"));rmSync(absolute,{recursive:true});}
});
