// Same sources and dependencies, installed Eclipse core engine, disposable workspace.
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout, clearTimeout } from "node:timers";

const eclipse = process.env.NCFORGE_ECLIPSE_HOME;
const java = process.env.NCFORGE_JAVA_HOME;
if (!eclipse || !java) throw new Error("Set NCFORGE_ECLIPSE_HOME and NCFORGE_JAVA_HOME");
const cache = resolve(".cache");
const temp = join(cache, "eclipse-completion-" + process.pid);
const input = JSON.parse(await readFile(resolve(process.argv[2] ?? ".cache/java-completion-after.json"), "utf8"));
await mkdir(join(temp, "classes"), { recursive: true });
await mkdir(join(temp, "cfg"), { recursive: true });
const pluginFiles = await readdir(join(eclipse, "plugins"));
const find = prefix => {
  const name = pluginFiles.find(n => n.startsWith(prefix) && n.endsWith(".jar"));
  if (!name) throw new Error("Missing Eclipse bundle " + prefix);
  return join(eclipse, "plugins", name);
};
async function run(command, args, timeout = 120_000) {
  return await new Promise((ok, fail) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); fail(new Error("Timed out: " + command + "\n" + output.slice(-4000))); }, timeout);
    child.stdout.on("data", b => { output += b; });
    child.stderr.on("data", b => { output += b; });
    child.on("error", e => { clearTimeout(timer); fail(e); });
    child.on("exit", code => {
      clearTimeout(timer);
      if (code === 0) ok(output);
      else fail(new Error("Exit " + code + ": " + output.slice(-8000)));
    });
  });
}
try {
  await run(join(java, "bin", "javac.exe"), ["-encoding", "UTF-8", "-cp", join(eclipse, "plugins", "*"), "-d", join(temp, "classes"), resolve("scripts/java/EclipseCompletionProbe.java")]);
  await writeFile(join(temp, "MANIFEST.MF"), "Manifest-Version: 1.0\nBundle-ManifestVersion: 2\nBundle-Name: NCForge completion baseline\nBundle-SymbolicName: ncforge.completion.probe;singleton:=true\nBundle-Version: 1.0.0\nRequire-Bundle: org.eclipse.core.runtime,org.eclipse.core.resources,\n org.eclipse.jdt.core,org.eclipse.equinox.app\nBundle-RequiredExecutionEnvironment: JavaSE-1.8\n\n");
  await writeFile(join(temp, "classes", "plugin.xml"), '<plugin><extension point="org.eclipse.core.runtime.applications" id="check"><application><run class="ncforge.probe.EclipseCompletionProbe"/></application></extension></plugin>');
  const bundle = join(temp, "probe.jar");
  await run(join(java, "bin", "jar.exe"), ["cfm", bundle, join(temp, "MANIFEST.MF"), "-C", join(temp, "classes"), "."]);
  const bundles = await readFile(join(eclipse, "configuration", "org.eclipse.equinox.simpleconfigurator", "bundles.info"), "utf8");
  const locations = bundles.split(/\r?\n/).filter(Boolean).map(line => {
    if (line.startsWith("#")) return line;
    const parts = line.split(",");
    parts[2] = pathToFileURL(resolve(eclipse, parts[2])).href;
    // Only required JDT bundles activate lazily; do not start installed third-party
    // updaters, dropin reconcilers or assistants during a core-engine measurement.
    parts[4] = parts[0] === "org.eclipse.core.runtime" ? "true" : "false";
    return parts.join(",");
  });
  locations.push("ncforge.completion.probe,1.0.0," + pathToFileURL(bundle).href + ",4,false");
  await writeFile(join(temp, "cfg", "bundles.info"), locations.join("\n") + "\n");
  await writeFile(join(temp, "cfg", "config.ini"), [
    "osgi.bundles=reference:" + pathToFileURL(find("org.eclipse.equinox.simpleconfigurator_")).href + "@1:start",
    "osgi.bundles.defaultStartLevel=4",
    "osgi.framework=" + pathToFileURL(find("org.eclipse.osgi_")).href,
    "org.eclipse.equinox.simpleconfigurator.configUrl=" + pathToFileURL(join(temp, "cfg", "bundles.info")).href,
    "eclipse.application=ncforge.completion.probe.check",
    "osgi.noShutdown=false", ""
  ].join("\n"));
  await writeFile(join(temp, "jars.txt"), input.classpathJars.join("\n"));
  await writeFile(join(temp, "cases.tsv"), input.cases.map((c, i) => i + "\t" + c.expected + "\t" + Buffer.from(c.source).toString("base64")).join("\n"));
  const output = await run(join(java, "bin", "java.exe"), ["-Xmx768m", "-jar", find("org.eclipse.equinox.launcher_"), "-install", temp, "-configuration", join(temp, "cfg"), "-data", join(temp, "workspace"), "-application", "ncforge.completion.probe.check", "-consoleLog", java, join(temp, "jars.txt"), join(temp, "cases.tsv")]);
  const cases = output.split(/\r?\n/).filter(l => l.startsWith("NCFORGE_RESULT\t")).map(line => {
    const [, index, ms, count, found] = line.split("\t");
    const c = input.cases[Number(index)];
    return { case: c.case, eclipseMs: Number(ms), eclipseCount: Number(count), eclipseFound: found === "true",
      jdtCompletionMs: c.completionMs, jdtResolveMs: c.resolveMs, jdtWarmMs: c.warmMs, jdtCount: c.count, jdtFound: c.found };
  });
  if (cases.length !== input.cases.length) throw new Error("Missing results:\n" + output.slice(-8000));
  const report = { eclipseHome: eclipse, jdkHome: java, classpathJars: input.classpathJars, scope: "Installed Eclipse core codeComplete, same disposable source and dependencies; UI ranking excluded", cases };
  await writeFile(join(cache, "eclipse-completion-baseline.json"), JSON.stringify(report, null, 2) + "\n");
  console.table(cases);
} finally {
  if (temp.startsWith(cache + sep)) await rm(temp, { recursive: true, force: true });
  else console.error("Skipped unsafe temporary path");
}
