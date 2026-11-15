import { readFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const roots = [process.argv.find(arg => arg.startsWith("--jdk="))?.slice(6), "D:/ncc/1909home/ufjdk", process.env.JAVA_HOME].filter(Boolean);
const jdk = roots.find(root => {
  const tool = join(root, "bin", process.platform === "win32" ? "javac.exe" : "javac");
  if (!existsSync(tool)) return false;
  const result = spawnSync(tool, ["-version"], { encoding: "utf8", windowsHide: true });
  const version = /javac\s+(?:1\.)?(\d+)/.exec(result.stdout + result.stderr);
  return version && Number(version[1]) >= 8;
});
if (!jdk) throw new Error("需要 JDK 8 或以上；可传 --jdk=<JDK目录>");

async function moduleOf(file) {
  const source = await readFile(resolve("src/lib", file), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2021 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}
const { parseJava } = await moduleOf("javaModel.ts");
const { generate } = await moduleOf("javaCodeGen.ts");
const tempParent = resolve("src-tauri/target/test-tmp");
await mkdir(tempParent, { recursive: true });
const folder = await mkdtemp(join(tempParent, "java-editing-smoke-"));
if (dirname(folder) !== tempParent) throw new Error("临时目录边界异常");
try {
  const inputs = [
    ["ArrayBean", "private int[] values;"],
    ["BooleanBean", "private Boolean ready; private boolean isReady;"],
    ["FinalBean", "private final int fixed = 1; private String name; public String getName() { return name; }"],
    ["GenericBean", "private java.util.List<String> values; public java.util.List<String> getValues() { return values; }"],
  ];
  const paths = [];
  for (const [name, body] of inputs) {
    const input = `package smoke;\npublic class ${name} {\n${body}\n}`;
    const parsed = parseJava(input);
    if (!parsed) throw new Error(`无法解析 ${name}`);
    const options = { fields: parsed.fields, methods: parsed.methods, className: name, indent: "\t" };
    const generated = ["constructor", "getters", "setters", "toString", "equals", "hashCode"].map(kind => generate(kind, options)).join("\n");
    const path = join(folder, `${name}.java`);
    await writeFile(path, input.slice(0, -1) + generated + "}\n", "utf8"); paths.push(path);
  }
  const main = join(folder, "GeneratorSmoke.java");
  await writeFile(main, `package smoke;
public class GeneratorSmoke {
  public static void main(String[] args) {
    ArrayBean first = new ArrayBean(new int[] {1, 2});
    ArrayBean second = new ArrayBean(new int[] {1, 2});
    if (!first.equals(second) || first.hashCode() != second.hashCode()) throw new AssertionError("array equality contract");
    if (!first.toString().contains("[1, 2]")) throw new AssertionError("array string");
    BooleanBean flags = new BooleanBean(Boolean.TRUE, true);
    if (!flags.getReady() || !flags.isReady()) throw new AssertionError("JavaBeans accessors");
    if (!new FinalBean("ok").getName().equals("ok")) throw new AssertionError("existing getter");
    if (new GenericBean(new java.util.ArrayList<String>()).getValues() == null) throw new AssertionError("generic getter");
  }
}
`, "utf8"); paths.push(main);
  const output = join(folder, "classes"); await mkdir(output, { recursive: true });
  const compile = spawnSync(join(jdk, "bin", process.platform === "win32" ? "javac.exe" : "javac"), ["-encoding", "UTF-8", "-source", "8", "-target", "8", "-d", output, ...paths], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  if (compile.status !== 0) throw new Error(compile.stderr || String(compile.error));
  const run = spawnSync(join(jdk, "bin", process.platform === "win32" ? "java.exe" : "java"), ["-cp", output, "smoke.GeneratorSmoke"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (run.status !== 0) throw new Error(run.stderr || String(run.error));
  console.log("Java 8 真实生成物编译和运行通过：数组等值/哈希、访问器、final初始化、泛型和已有成员。");
} finally {
  // 边界不对就**不删**：但也不能在这里 throw —— finally 里的异常会吞掉 try 里真正失败的原因。
  if (dirname(folder) === tempParent) await rm(folder, { recursive: true, force: true });
  else console.error(`临时目录边界异常，已跳过清理：${folder}`);
}
