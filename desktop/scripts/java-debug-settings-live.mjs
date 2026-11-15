// Read raw RPC replies from the installed JDT/java-debug pair before using its settings API.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ls = process.env.NCFORGE_JDTLS_DIR ?? join(desktop, "src-tauri/resources/jdtls");
const runtime = process.env.NCFORGE_JAVA_HOME ?? "D:/ncc/1909home/ufjdk";
const java = join(runtime, "bin", process.platform === "win32" ? "java.exe" : "java");
const base = join(desktop, ".cache/java-debug-settings-live"); mkdirSync(base, { recursive: true });
const fixture = mkdtempSync(join(base, "run-"));
const project = join(fixture, "project"), config = join(fixture, "config");
mkdirSync(join(project, "src"), { recursive: true }); mkdirSync(config);
writeFileSync(join(project, "src/Hello.java"), "public class Hello { public static void main(String[] args) {} }\n");
writeFileSync(join(project, ".project"), '<projectDescription><name>debug-settings-live</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>');
writeFileSync(join(project, ".classpath"), '<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="bin"/></classpath>');
copyFileSync(join(ls, process.platform === "win32" ? "config_win" : "config_linux", "config.ini"), join(config, "config.ini"));
const launcher = readdirSync(join(ls, "plugins")).find(name => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(name));
const rootUri = pathToFileURL(project).href;
const settings = { java: { configuration: { runtimes: [{ name: "JavaSE-1.8", path: runtime, default: true }] }, autobuild: { enabled: false } } };
const child = spawn(java, ["-Declipse.application=org.eclipse.jdt.ls.core.id1", "-Dosgi.bundles.defaultStartLevel=4", "-Declipse.product=org.eclipse.jdt.ls.core.product", "-noverify", "-Xmx512m", "-jar", join(ls, "plugins", launcher), "-configuration", config, "-data", join(fixture, "data")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
let buffer = Buffer.alloc(0), sequence = 0, stderr = "", readyResolve;
const ready = new Promise(resolve => { readyResolve = resolve; }), pending = new Map();
const send = message => { const bytes = Buffer.from(JSON.stringify(message)); child.stdin.write(`Content-Length: ${bytes.length}\r\n\r\n`); child.stdin.write(bytes); };
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const request = (method, params, timeout = 20000) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, timeout);
  pending.set(id, { resolve, reject, timer }); send({ jsonrpc: "2.0", id, method, params });
});
child.stderr.on("data", data => { stderr = (stderr + data).slice(-8000); });
child.stdout.on("data", data => {
  buffer = Buffer.concat([buffer, data]);
  while (true) {
    const head = buffer.indexOf("\r\n\r\n"); if (head < 0) return;
    const length = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, head).toString());
    if (!length) { buffer = buffer.subarray(head + 4); continue; }
    const size = Number(length[1]); if (buffer.length < head + 4 + size) return;
    const message = JSON.parse(buffer.subarray(head + 4, head + 4 + size).toString()); buffer = buffer.subarray(head + 4 + size);
    if (message.id !== undefined && message.method) {
      if (message.method === "client/registerCapability") console.log("Dynamic capability raw RPC:", JSON.stringify(message));
      let result = null;
      if (message.method === "workspace/configuration") result = message.params.items.map(() => settings);
      if (message.method === "workspace/workspaceFolders") result = [{ uri: rootUri, name: "debug-settings-live" }];
      if (message.method === "workspace/applyEdit") result = { applied: false };
      send({ jsonrpc: "2.0", id: message.id, result });
    } else if (message.id !== undefined) {
      const entry = pending.get(message.id); if (!entry) continue;
      pending.delete(message.id); clearTimeout(entry.timer);
      entry.resolve(message);
    } else if (message.method === "language/status" && message.params?.type === "ServiceReady") readyResolve();
  }
});
child.on("error", error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
child.on("exit", code => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`JDT exited ${code}`)); } pending.clear(); });
const execute = args => request("workspace/executeCommand", { command: "vscode.java.updateDebugSettings", arguments: args });
try {
  const initialized = await request("initialize", { processId: process.pid, rootUri, rootPath: project, workspaceFolders: [{ uri: rootUri, name: "debug-settings-live" }], capabilities: { workspace: { configuration: true, workspaceFolders: true } }, initializationOptions: { settings, bundles: [join(ls, "java-debug/com.microsoft.java.debug.plugin-0.32.0.jar")] } }, 90000);
  const commands = initialized.result?.capabilities?.executeCommandProvider?.commands ?? [];
  console.log("Registered debug commands:", JSON.stringify(commands.filter(command => command.includes("vscode.java"))));
  console.log("Initialize capability raw RPC:", JSON.stringify(initialized)); notify("initialized", {});
  let timer; try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("JDT ServiceReady timeout")), 90000); })]); } finally { clearTimeout(timer); }
  const currentReply = await execute([]); console.log("Current settings raw RPC:", JSON.stringify(currentReply));
  assert.equal(currentReply.error, undefined);
  const current = JSON.parse(currentReply.result);
  const stepFilters = { skipClasses: ["Helper", "java.*"], skipSynthetics: true, skipStaticInitializers: true, skipConstructors: false };
  const partial = await execute([JSON.stringify({ stepFilters })]); console.log("Partial settings raw RPC:", JSON.stringify(partial));
  const full = await execute([JSON.stringify({ ...current, logLevel: current.logLevel || "WARNING", stepFilters })]); console.log("Complete settings raw RPC:", JSON.stringify(full));
  assert.equal(full.error, undefined, JSON.stringify(full.error));
  assert.deepEqual(JSON.parse(full.result).stepFilters.skipClasses, ["Helper", "java.*"]);
  console.log("PASS: registered official LSP settings command and confirmed complete settings reply");
} catch (error) {
  console.error(error); console.error(stderr);
  const log = join(fixture, "data/.metadata/.log"); if (existsSync(log)) console.error(readFileSync(log, "utf8").slice(-10000));
  process.exitCode = 1;
} finally {
  try { await request("shutdown", null, 3000); notify("exit", null); } catch { /* Final kill below. */ }
  if (child.exitCode === null) { await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 2000))]); if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once("exit", resolve)); } }
  for (const entry of pending.values()) clearTimeout(entry.timer);
  assert.equal(dirname(fixture), base); rmSync(fixture, { recursive: true, force: true });
}
