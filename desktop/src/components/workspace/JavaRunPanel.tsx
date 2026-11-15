import { useState } from "react";
import { Icon } from "../ui/icon";
import { invoke } from "../../lib/tauri";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { configureJavaRun, configureRunFromEditor, runJava, cancelJavaRun, rerunFailed, useJavaRunSnapshot } from "../../lib/javaRun";
import { inputLines } from "../../lib/javaRunConfig";
import { searchTypes } from "../../lib/typeSearch";
import { requestOpenFile } from "../../lib/openFileRequest";
import { errorToast } from "../../lib/errorToast";
import { JavaDiagnosticTools } from "./JavaDiagnosticTools";
import "../../java-runtime.css";

export function JavaRunPanel() {
  const snap = useJavaRunSnapshot();
  const root = useWorkspaceSelector(session => session.root ?? "");
  const activePath = useWorkspaceSelector(session => session.activePath);
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<{ file: string; line: number }[]>([]);
  const config = snap.config;
  const totals = snap.result?.tests.reduce((total, test) => ({ count: total.count + test.count, failures: total.failures + test.failures, ignored: total.ignored + test.ignored }), { count: 0, failures: 0, ignored: 0 });
  const update = (field: keyof typeof config, value: string) => configureJavaRun({ ...config, [field]: value });
  const discover = async () => {
    const path = config.path || activePath;
    if (!path) return;
    setBusy(true);
    try {
      const tests = await invoke<{ className: string; path: string; methods: string[] }[]>("java_run_discover", { path });
      configureJavaRun({ ...config, path, mode: "test", classes: tests.map(test => test.className).join("\n") });
      if (!tests.length) throw new Error("当前范围未发现 JUnit 注解或 TestCase 测试类，可手动填写完整类名");
    } catch (error) { errorToast("查找模块测试", error); } finally { setBusy(false); }
  };
  const jump = async (className: string, trace: string) => {
    try {
      const locations = [...trace.matchAll(/\bat\s+([\w.$]+)\.[\w$]+\(([^:\r\n]+\.java):(\d+)\)/g)];
      const frame = locations.find(match => match[1] === className || match[1].startsWith(`${className}$`));
      const line = Number(frame?.[3] ?? 1);
      // The source index stores nested types by simple name. The exact outer type
      // identifies their file; stack filenames protect against unrelated indexed hits.
      let enclosingType = className, matches: Awaited<ReturnType<typeof searchTypes>>["workspace"] = [];
      while (enclosingType) {
        matches = (await searchTypes(enclosingType, 100)).workspace.filter(hit => hit.name === enclosingType
          && (!frame || hit.file.replace(/\\/g, "/").split("/").pop() === frame[2]));
        if (matches.length || !enclosingType.includes("$")) break;
        enclosingType = enclosingType.slice(0, enclosingType.lastIndexOf("$"));
      }
      if (matches.length === 1) requestOpenFile({ path: matches[0].file, line });
      else if (matches.length > 1) setSources(matches.map(hit => ({ file: hit.file, line })));
      else throw new Error("当前工程索引没有找到该测试源码，请按完整类名在顶部搜索中定位");
    } catch (error) { errorToast("打开失败测试", error); }
  };
  return <div className="wb-panel-body jrun-body">
    <div className="jrun-toolbar">
      <button type="button" className="wb-status-btn" disabled={snap.running || busy} onClick={() => void configureRunFromEditor(config.mode)}>使用当前 Java 类</button>
      <button type="button" className="wb-status-btn" disabled={snap.running || busy} onClick={() => void configureRunFromEditor("test", true)}>使用光标所在测试方法</button>
      <button type="button" className="wb-status-btn" disabled={snap.running || busy || !(config.path || activePath)} onClick={() => void discover()}>{busy ? "查找中…" : "查找当前模块测试"}</button>
      <span className="wb-status-sp" />
      {snap.running ? <button type="button" className="wb-status-btn" onClick={() => void cancelJavaRun().catch(error => errorToast("停止运行", error))}><Icon name="stop" size={12} />停止运行</button> : <>
        <button type="button" className="wb-status-btn" disabled={busy || !config.classes.trim()} onClick={() => void runJava(config)}><Icon name="play" size={12} />{config.mode === "test" ? "运行测试" : "运行"}</button>
        <button type="button" className="wb-status-btn" disabled={busy || !config.classes.trim()} onClick={() => void runJava(config, true)}>调试</button>
        <button type="button" className="wb-status-btn" disabled={busy || !config.classes.trim()} onClick={() => void runJava(config, false, true)}>覆盖率</button>
      </>}
    </div>
    <div className="jrun-config" aria-label="Java 运行配置">
      <label>方式<select value={config.mode} disabled={snap.running} onChange={event => update("mode", event.target.value)}><option value="main">Java main</option><option value="test">JUnit 4 / 5</option></select></label>
      <label>源码或模块路径<input value={config.path} disabled={snap.running} onChange={event => update("path", event.target.value)} placeholder="使用当前 Java 类，或填写当前工程内的路径" /></label>
      <label className="jrun-targets">{config.mode === "test" ? "测试类 / 类名#方法名（每行一项）" : "完整 main 类名"}<textarea rows={2} value={config.classes} disabled={snap.running} onChange={event => update("classes", event.target.value)} placeholder="例如 nc.demo.PriceTest#testPrice" /></label>
      <label>程序参数（每行一个完整参数）<textarea rows={2} value={config.args} disabled={snap.running || config.mode === "test"} onChange={event => update("args", event.target.value)} /></label>
      <label>额外类路径（每行一个工程 / NC 目录内的 JAR 或目录）<textarea rows={2} value={config.extraClasspath} disabled={snap.running} onChange={event => update("extraClasspath", event.target.value)} /></label>
    </div>
    <div className="wb-panel-note">使用 NC 配置的 Java 8 和当前工程依赖；运行前请保存修改。编译产物写入工作台私有目录。JUnit / JaCoCo 首次使用按需下载校验，不影响 NC 服务进程。</div>
    {snap.error && <div className="dbg-error" role="alert">{snap.error}</div>}
    {snap.result?.resultsTruncated && <div className="dbg-error" role="alert">测试结果超过展示上限，仅显示前 1000 条汇总与失败；不能据此判断全部通过，完整结果保存在本次官方 XML 报告中。</div>}
    {snap.result && <div className="jrun-result" role="status" data-ok={snap.result.ok || undefined}>
      <strong>{snap.result.cancelled ? "已取消" : snap.result.ok ? "运行通过" : "运行失败"}</strong>
      {totals && <span>执行 {totals.count} · 失败 {totals.failures} · 跳过 {totals.ignored}</span>}
      <span>{snap.result.durationMs} ms · 退出码 {snap.result.exitCode ?? "未知"}</span>
      {!!snap.result.failures.length && <button type="button" className="wb-status-btn" disabled={snap.running || snap.root !== root} onClick={() => void rerunFailed()}>重跑失败项</button>}
      {snap.result.report && <button type="button" className="wb-status-btn" onClick={() => void invoke("java_run_open_report", { path: snap.result!.report }).catch(error => errorToast("打开覆盖率报告", error))}>打开覆盖率报告</button>}
    </div>}
    {!!snap.result?.tests.length && <table className="jrun-tests"><thead><tr><th>测试类</th><th>执行</th><th>失败</th><th>跳过</th></tr></thead><tbody>{snap.result.tests.map(test => <tr key={test.target}><td>{test.target}</td><td>{test.count}</td><td>{test.failures}</td><td>{test.ignored}</td></tr>)}</tbody></table>}
    {snap.result?.failures.map((failure, index) => <details className="jrun-failure" key={`${failure.className}:${failure.method}:${index}`}><summary>{failure.className} · {failure.method}<button type="button" className="wb-status-btn" onClick={event => { event.preventDefault(); void jump(failure.className, failure.trace); }}>打开失败位置</button></summary><pre>{failure.trace}</pre></details>)}
    {!!sources.length && <div className="jrun-source-options">有多个源码来源，请选择：{sources.map(source => <button key={source.file} type="button" className="wb-status-btn" onClick={() => { requestOpenFile({ path: source.file, line: source.line }); setSources([]); }}>{source.file}:{source.line}</button>)}</div>}
    <details className="jrun-output" open={snap.running}><summary>运行输出 · 保留最近 {snap.log.length} 行{snap.root && snap.root !== root ? ` · 来源工程 ${snap.root}` : ""}{snap.pid ? ` · PID ${snap.pid}` : ""}</summary><pre>{snap.log.join("\n") || "运行后显示编译、测试和程序输出。"}</pre></details>
    <JavaDiagnosticTools defaultPid={snap.pid} />
    {!inputLines(config.classes).length && <div className="wb-panel-note">先选择当前类、当前测试方法，或查找模块测试，再执行运行。</div>}
  </div>;
}
