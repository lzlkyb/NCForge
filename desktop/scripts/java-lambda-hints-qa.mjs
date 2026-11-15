// A real Java 8 JDT hover probe. Run after the other Rust / JDT checks, never in parallel.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ls = process.env.NCFORGE_JDTLS_DIR ?? join(desktop, "src-tauri/resources/jdtls");
const runtime = process.env.NCFORGE_JAVA_HOME ?? "D:/ncc/1909home/ufjdk";
const java = join(runtime, "bin", process.platform === "win32" ? "java.exe" : "java");
const base = join(desktop, "src-tauri/target/test-tmp"); mkdirSync(base, { recursive: true });
const fixture = mkdtempSync(join(base, "java-lambda-hints-")); assert.equal(dirname(fixture), base);
const project = join(fixture, "project"), src = join(project, "src/demo"), config = join(fixture, "config");
mkdirSync(src, { recursive: true }); mkdirSync(config); mkdirSync(join(project, ".settings"));
const source = `package demo;
import java.util.List;
import java.util.function.Function;
import java.util.function.BiFunction;
public class LambdaDemo {
    Function<String, Integer> one = value -> value.length();
    BiFunction<String, Integer, String> two = (text, count) -> text.substring(count);
    Function<List<String>, Integer> generic = words -> words.size();
}
`;
const file = join(src, "LambdaDemo.java"), uri = pathToFileURL(file).href, rootUri = pathToFileURL(project).href;
writeFileSync(file, source);
writeFileSync(join(project, ".project"), '<projectDescription><name>lambda-live</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>');
writeFileSync(join(project, ".classpath"), '<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="bin"/></classpath>');
writeFileSync(join(project, ".settings/org.eclipse.jdt.core.prefs"), "eclipse.preferences.version=1\norg.eclipse.jdt.core.compiler.compliance=1.8\norg.eclipse.jdt.core.compiler.source=1.8\norg.eclipse.jdt.core.compiler.codegen.targetPlatform=1.8\n");
copyFileSync(join(ls, process.platform === "win32" ? "config_win" : process.platform === "darwin" ? "config_mac" : "config_linux", "config.ini"), join(config, "config.ini"));
const launcher = readdirSync(join(ls, "plugins")).find(name => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(name)); assert.ok(launcher);
const settings = { java: { configuration: { runtimes: [{ name: "JavaSE-1.8", path: runtime, default: true }] }, autobuild: { enabled: false } } };
const child = spawn(java, ["-Declipse.application=org.eclipse.jdt.ls.core.id1", "-Dosgi.bundles.defaultStartLevel=4", "-Declipse.product=org.eclipse.jdt.ls.core.product", "-noverify", "-Xmx512m", "-jar", join(ls, "plugins", launcher), "-configuration", config, "-data", join(fixture, "data")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
let buffer = Buffer.alloc(0), sequence = 0, stderr = "";
const pending = new Map();
const send = message => { const bytes = Buffer.from(JSON.stringify(message)); child.stdin.write(`Content-Length: ${bytes.length}\r\n\r\n`); child.stdin.write(bytes); };
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const request = (method, params, timeout = 20000) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr.slice(-1000)}`)); }, timeout);
  pending.set(id, { resolve, reject, timer }); send({ jsonrpc: "2.0", id, method, params });
});
child.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
child.stdout.on("data", data => {
  buffer = Buffer.concat([buffer, data]);
  while (true) {
    const head = buffer.indexOf("\r\n\r\n"); if (head < 0) return;
    const length = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, head).toString());
    if (!length) { buffer = buffer.subarray(head + 4); continue; }
    const size = Number(length[1]); if (buffer.length < head + 4 + size) return;
    const message = JSON.parse(buffer.subarray(head + 4, head + 4 + size).toString()); buffer = buffer.subarray(head + 4 + size);
    if (message.id !== undefined && message.method) {
      let result = null;
      if (message.method === "workspace/configuration") result = message.params.items.map(() => settings);
      if (message.method === "workspace/workspaceFolders") result = [{ uri: rootUri, name: "lambda-live" }];
      if (message.method === "workspace/applyEdit") result = { applied: false };
      send({ jsonrpc: "2.0", id: message.id, result });
    } else if (message.id !== undefined) {
      const entry = pending.get(message.id); if (!entry) continue;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
    }
  }
});
child.on("error", error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
child.on("exit", code => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`JDT exited ${code}: ${stderr}`)); } pending.clear(); });
const dataModule = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const transpile = path => ts.transpileModule(readFileSync(join(desktop, "src/lib", path), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2021 } }).outputText;
let helper = transpile("javaLambdaHints.ts");
helper = helper.replace('"./javaModel"', JSON.stringify(dataModule(transpile("javaModel.ts")))).replace('"./langConvert"', JSON.stringify(dataModule(transpile("langConvert.ts"))));
try {
  const { javaHoverParameterType } = await import(dataModule(helper));
  await request("initialize", { processId: process.pid, rootUri, rootPath: project, workspaceFolders: [{ uri: rootUri, name: "lambda-live" }], capabilities: { workspace: { configuration: true, workspaceFolders: true, applyEdit: false }, textDocument: { hover: { contentFormat: ["markdown", "plaintext"] } } }, initializationOptions: { settings } }, 90000);
  notify("initialized", {});
  const deadline = Date.now() + 90000;
  while (true) {
    const symbols = await request("workspace/symbol", { query: "LambdaDemo" });
    if (symbols?.some(symbol => symbol.name === "LambdaDemo")) break;
    assert.ok(Date.now() < deadline, "JDT did not index fixture"); await new Promise(resolve => setTimeout(resolve, 1000));
  }
  notify("textDocument/didOpen", { textDocument: { uri, version: 1, languageId: "java", text: source } });
  for (const [name, expected] of [["value", /^(?:java\.lang\.)?String$/], ["text", /^(?:java\.lang\.)?String$/], ["count", /^(?:java\.lang\.)?Integer$/], ["words", /^(?:java\.util\.)?List<(?:java\.lang\.)?String>$/]]) {
    const before = source.slice(0, source.indexOf(name + (name === "text" ? ", count" : name === "count" ? ") ->" : " ->"))), rows = before.split("\n");
    const hover = await request("textDocument/hover", { textDocument: { uri }, position: { line: rows.length - 1, character: rows.at(-1).length } });
    const inferred = javaHoverParameterType(hover?.contents, name);
    assert.match(inferred ?? "", expected, `${name}: ${JSON.stringify(hover)}`);
    console.log(`PASS real lambda hover ${name}: ${inferred}\n${JSON.stringify(hover)}`);
  }
} finally {
  try { await request("shutdown", null, 3000); notify("exit", null); } catch { /* Kill below on failed shutdown. */ }
  if (child.exitCode === null) {
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once("exit", resolve)); }
  }
  assert.equal(dirname(fixture), base); rmSync(fixture, { recursive: true, force: true });
}
