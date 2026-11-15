import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const java = process.env.NCFORGE_TEST_JAVA || "D:/ncc/1909home/ufjdk/bin/java.exe";
const tool = name => path.join(path.dirname(java), process.platform === "win32" ? `${name}.exe` : name);
// Separate from rust-gate's scratch root, so the two acceptance jobs do not delete each other.
const base = path.join(desktop, ".cache/java-diagnostics-acceptance");
await mkdir(base, { recursive: true });
const scratch = await mkdtemp(path.join(base, "run-"));
let target;
async function execute(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TEMP: scratch, TMP: scratch } });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("JVM diagnostics fixture exceeded 45 seconds")); }, 45_000);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { if (output.length < 4 * 1024 * 1024) output += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
}
try {
  const source = path.join(scratch, "DiagnosticsDemo.java");
  await writeFile(source, 'public class DiagnosticsDemo { public static void main(String[] args) throws Exception { System.out.println("READY"); Thread.sleep(60000); } }\n');
  const compiled = await execute(tool("javac"), ["-J-Xmx256m", "-g", "-d", scratch, source]);
  assert.equal(compiled.code, 0, compiled.output);
  target = spawn(java, ["-Xmx256m", "-cp", scratch, "DiagnosticsDemo"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TEMP: scratch, TMP: scratch } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Diagnostic Java target did not become ready")), 10_000);
    target.on("error", error => { clearTimeout(timer); reject(error); });
    target.stdout.on("data", chunk => { if (String(chunk).includes("READY")) { clearTimeout(timer); resolve(); } });
    target.on("exit", code => { clearTimeout(timer); reject(new Error(`Diagnostic Java target exited early: ${code}`)); });
  });
  const pid = String(target.pid);
  const threads = await execute(tool("jstack"), [pid]);
  assert.equal(threads.code, 0, threads.output);
  assert.match(threads.output, /"main"/); assert.match(threads.output, /DiagnosticsDemo\.main/);
  const histogram = await execute(tool("jcmd"), [pid, "GC.class_histogram"]);
  assert.equal(histogram.code, 0, histogram.output); assert.match(histogram.output, /#instances/); assert.match(histogram.output, /java\.lang\.String/);
  const vm = await execute(tool("jcmd"), [pid, "VM.version"]);
  assert.equal(vm.code, 0, vm.output); assert.match(vm.output, /JVM version|HotSpot|OpenJDK|Java/);
  const started = await execute(tool("jcmd"), [pid, "JFR.start", "name=NCForge", "settings=profile"]);
  if (started.code === 0 && /Started recording/.test(started.output)) {
    const recording = path.join(scratch, "profile.jfr");
    const stopped = await execute(tool("jcmd"), [pid, "JFR.stop", "name=NCForge", `filename=${recording}`]);
    assert.equal(stopped.code, 0, stopped.output); assert.ok((await stat(recording)).size > 0);
    console.log("PASS: actual jstack, GC.class_histogram, VM.version and non-empty JFR recording");
  } else {
    assert.match(started.output, /not enabled|not available|not supported|unknown diagnostic|commercial|Flight Recorder|FlightRecorder/i);
    console.log("PASS: actual jstack, GC.class_histogram and VM.version; JFR unavailable with explicit JDK output:");
    console.log(started.output.trim());
  }
} finally {
  if (target && target.exitCode === null) {
    if (process.platform === "win32") await execute("taskkill", ["/T", "/F", "/PID", String(target.pid)]);
    else target.kill("SIGKILL");
    if (target.exitCode === null) await new Promise(resolve => target.once("exit", resolve));
  }
  assert.ok(scratch.startsWith(base + path.sep));
  await rm(scratch, { recursive: true, force: true });
}
