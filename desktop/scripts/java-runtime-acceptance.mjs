import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const java = process.env.NCFORGE_TEST_JAVA || "D:/ncc/1909home/ufjdk/bin/java.exe";
const javac = path.join(path.dirname(java), process.platform === "win32" ? "javac.exe" : "javac");
const tools = path.join(desktop, ".cache/java-run-tools");
const scratchBase = path.join(desktop, "src-tauri/target/test-tmp");
await mkdir(scratchBase, { recursive: true });
const scratch = await mkdtemp(path.join(scratchBase, "java-runtime-"));
const classes = path.join(scratch, "classes"), sources = path.join(scratch, "sources");
await mkdir(classes); await mkdir(sources);
async function execute(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, env: { ...process.env, TEMP: scratch, TMP: scratch } });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Java fixture exceeded 60 seconds")); }, 60_000);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { if (output.length < 2 * 1024 * 1024) output += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
}
try {
  const junit = path.join(tools, "junit-console.jar"), agent = path.join(tools, "jacoco-agent.jar"), cli = path.join(tools, "jacoco-cli.jar");
  for (const [file, expected] of [[junit, "a1de557821293ce903c213c694165fff532cf92081bac4238b9e05b35f04f43f"], [agent, "115e8e6e6593ca3a9892dfef695df4d487c706e59e71e64dc0ab95716ee02622"], [cli, "594c01125b84864a7fc5a9efab19b71b7de36b27346863f6d7cd0cd45400ceb0"]]) {
    assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), expected);
  }
  await writeFile(path.join(sources, "MainDemo.java"), 'public class MainDemo { public static void main(String[] a) { System.out.println("LITERAL=" + a[0]); } }\n');
  await writeFile(path.join(sources, "PassingTest.java"), 'public class PassingTest { @org.junit.Test public void passes() { org.junit.Assert.assertEquals(4, 2 + 2); } @org.junit.Ignore @org.junit.Test public void ignored() {} }\n');
  await writeFile(path.join(sources, "FailingTest.java"), 'public class FailingTest { @org.junit.Test public void fails() { org.junit.Assert.assertEquals("expected", "actual"); } }\n');
  await writeFile(path.join(sources, "JupiterTest.java"), 'public class JupiterTest { @org.junit.jupiter.api.Test public void passesJupiter() { org.junit.jupiter.api.Assertions.assertTrue(true); } @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"one", "two"}) public void parameterized(String value) { org.junit.jupiter.api.Assertions.assertTrue(value.length() > 0); } }\n');
  await writeFile(path.join(sources, "NcJavaTestRunner.java"), await readFile(path.join(desktop, "src-tauri/java-runner/NcJavaTestRunner.java")));
  const compiled = await execute(javac, ["-J-Xmx256m", "-encoding", "UTF-8", "-source", "8", "-target", "8", "-cp", junit, "-d", classes, ...["MainDemo", "PassingTest", "FailingTest", "JupiterTest", "NcJavaTestRunner"].map(name => path.join(sources, `${name}.java`))]);
  assert.equal(compiled.code, 0, compiled.output);
  const main = await execute(java, ["-Xmx256m", "-cp", classes, "MainDemo", "two words;literal"]);
  assert.equal(main.code, 0, main.output); assert.match(main.output, /LITERAL=two words;literal/);
  const targets = path.join(scratch, "test-targets.txt");
  await writeFile(targets, "PassingTest\nFailingTest\nJupiterTest\n");
  const classpath = [classes, junit].join(path.delimiter);
  const failed = await execute(java, ["-Xmx256m", "-cp", classpath, "NcJavaTestRunner", "--targets-file", targets]);
  assert.equal(failed.code, 1, failed.output);
  const summaries = failed.output.split(/\r?\n/).filter(line => line.startsWith("NCFORGE_TEST_SUMMARY\t")).map(line => { const parts = line.split("\t"); return { name: Buffer.from(parts[1], "base64").toString(), count: Number(parts[2]), failures: Number(parts[3]), ignored: Number(parts[4]) }; });
  assert.deepEqual(summaries.find(test => test.name === "PassingTest"), { name: "PassingTest", count: 1, failures: 0, ignored: 1 });
  assert.deepEqual(summaries.find(test => test.name === "FailingTest"), { name: "FailingTest", count: 1, failures: 1, ignored: 0 });
  assert.deepEqual(summaries.find(test => test.name === "JupiterTest"), { name: "JupiterTest", count: 3, failures: 0, ignored: 0 });
  assert.match(failed.output, /NCFORGE_TEST_FAILURE\t/);
  await writeFile(targets, "PassingTest#passes\nJupiterTest#parameterized\n");
  const coverage = path.join(scratch, "coverage.exec");
  const passed = await execute(java, ["-Xmx256m", `-javaagent:${agent}=destfile=${coverage},append=false`, "-cp", classpath, "NcJavaTestRunner", "--targets-file", targets]);
  assert.equal(passed.code, 0, passed.output);
  assert.match(passed.output, /NCFORGE_TEST_SUMMARY\tSnVwaXRlclRlc3Q=\t2\t0\t0/);
  const report = path.join(scratch, "report");
  const generated = await execute(java, ["-Xmx256m", "-jar", cli, "report", coverage, "--classfiles", classes, "--sourcefiles", sources, "--html", report]);
  assert.equal(generated.code, 0, generated.output);
  assert.match(await readFile(path.join(report, "index.html"), "utf8"), /JaCoCo/);
  console.log("PASS: Java main literal args, JUnit4/5 results, ignored/failed counts, method selection and real JaCoCo HTML report");
} finally {
  // Only this fixture-owned directory is removed; never clean the shared test directory.
  assert.ok(scratch.startsWith(scratchBase + path.sep));
  await rm(scratch, { recursive: true, force: true });
}
