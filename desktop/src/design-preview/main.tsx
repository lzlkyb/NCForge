import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Icon, type IconName } from "../components/ui/icon";
import "./preview.css";

// 设计预览：壳子自身的设计语言走查（侧栏/顶栏/首页/设置 的视觉规范）。
// 与 motion-preview.html（交互动效回归）分工：这份看"长什么样"，那份看"怎么动"。
// 刻意不接任何业务模块——壳子没有业务，预览里的内容就是「复制即用五步」本身。

const steps: { key: string; icon: IconName; label: string; cmd: string; note: string }[] = [
  { key: "copy", icon: "copy", label: "复制", cmd: "cp -r nc-forge my-app && cd my-app/desktop", note: "整目录拷贝，git 历史可选保留。" },
  { key: "rename", icon: "terminal", label: "改名", cmd: 'node scripts/rename-app.mjs my-tool --repo your-name/my-tool --display "我的工具"', note: "十余处产品标识一次改齐：包名/exe 名、Rust crate 名、tauri.conf、branding.rs、CI 产物名。" },
  { key: "icon", icon: "plug", label: "换图标", cmd: "npx tauri icon your-logo.png", note: "从一张图生成 icons/ 全套（ico/icns/png），托盘与 NSIS 位图需另行替换。" },
  { key: "key", icon: "key", label: "签名密钥", cmd: "npx tauri signer generate -w ~/.tauri/my-tool.key", note: "公钥进 tauri.conf.json 的 updater.pubkey，私钥进 GitHub secret。复制壳子的密钥发不了版。" },
  { key: "run", icon: "play", label: "运行", cmd: "npm install && npm run tauri dev", note: "10 分钟内得到能跑、能自动更新、UI 成体系的 Hello World。" },
];

// 发版链路各步骤耗时（分钟，量级参考）：tag 之后全自动，人不用管。
const releaseSteps: [string, number][] = [
  ["bump", 1],
  ["CI·mac", 11],
  ["CI·win", 12],
  ["合并", 1],
  ["attach", 1],
];

function App() {
  const [light, setLight] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [scenario, setScenario] = useState("running");
  const [step, setStep] = useState(1);
  const [guideOpen, setGuideOpen] = useState(true);
  const [notice, setNotice] = useState("");
  // running=正常运行 / first=首次运行（空态）/ updateFailed=更新检查失败 / stopped=已停止
  const running = scenario !== "stopped";
  const empty = scenario === "first";
  const updateFailed = scenario === "updateFailed";
  const current = steps[step];
  const showInfo = (text: string) => setNotice(text);
  const copy = async () => {
    try { await navigator.clipboard.writeText(current.cmd); showInfo(`已复制第 ${step + 1} 步命令：${current.label}`); }
    catch { showInfo("浏览器未允许复制，请选中命令手动复制。"); }
  };
  const toolButton = (icon: IconName, label: string, action: () => void) => <button className="icon-button" title={label} aria-label={label} onClick={action}><Icon name={icon}/></button>;
  const chain = [
    { key: "app", name: "应用进程", detail: running ? "nc-forge.exe · 运行中" : "未启动", icon: "monitor" as IconName, tone: running ? "ok" : "bad" },
    { key: "tray", name: "系统托盘", detail: running ? "常驻 · 单实例锁" : "随进程退出", icon: "plug" as IconName, tone: running ? "ok" : "bad" },
    { key: "update", name: "自动更新", detail: updateFailed ? "检查失败 · 已分类报错" : running ? "GitHub + Gitee 双源" : "未检查", icon: "refresh" as IconName, tone: updateFailed ? "bad" : running ? "ok" : "" },
  ];
  return <div className="preview" data-theme={light ? "light" : "dark"}>
    <div className="preview-bar"><span><b>设计预览</b><span className="preview-caption">A 工作台气质 · B 字体与布局</span></span><label>示例状态 <select aria-label="示例状态" value={scenario} onChange={e => setScenario(e.target.value)}><option value="running">正常运行</option><option value="first">首次运行</option><option value="updateFailed">更新检查失败</option><option value="stopped">应用已停止</option></select></label></div>
    <div className="shell" data-collapsed={collapsed}>
      <aside className="sidebar">
        <div className="brand"><img src="/icon.png" alt=""/><div><strong>NCForge</strong><span>NC65 / NCC 二开工作台</span></div></div>
        <nav aria-label="工作区"><button className="nav-item selected" aria-label="首页" aria-current="page"><Icon name="monitor"/><span>首页</span><kbd>1</kbd></button>{([["activity", "监控"], ["log", "日志"]] as [IconName,string][]).map(([icon,label],i)=><button key={label} className="nav-item" title={label} onClick={()=>showInfo(`${label}页由你的业务决定；壳子只提供布局壳与导航骨架。`)}><Icon name={icon}/><span>{label}</span><kbd>{i+2}</kbd></button>)}</nav>
        <div className="sidebar-bottom"><div className="workspace-note"><Icon name="monitor"/><div>本机工作区<span>Windows · 托盘常驻</span></div></div><button className="nav-item" title="设置" onClick={()=>showInfo("设置页已随壳子提供：自动开机、更新历史、关于卡片。")}><Icon name="settings"/><span>设置</span></button><div className="sidebar-status"><i className={running ? "dot" : "dot muted"}/><span>{running ? "应用运行中" : "应用已停止"}</span></div></div>
      </aside>
      <div className="main-shell">
        <header className="topbar"><div className="topbar-left">{toolButton("chevronLeft", collapsed ? "展开导航" : "收起导航", ()=>setCollapsed(!collapsed))}<span>工作区</span><span className="slash">/</span><strong>首页</strong></div><div className="topbar-right"><button className="search-button" aria-label="搜索命令" onClick={()=>showInfo("命令面板由你的业务决定是否提供；壳子已内置 Ctrl+1~N 页面快捷键。")}><Icon name="search" size={14}/><span>搜索命令</span><kbd>Ctrl K</kbd></button>{toolButton(light ? "moon" : "sun", light ? "切换深色主题" : "切换浅色主题", ()=>setLight(!light))}<span className="topbar-divider"/><span className="window-marks" aria-hidden="true"><Icon name="minimize" size={14}/><Icon name="maximize" size={12}/><Icon name="close" size={14}/></span></div></header>
        <main>
          <div className="page-heading"><div><h1>复制即用五步</h1><p>从壳子到一个能跑的桌面应用。</p></div><span className="demo-label"><i/>示例数据 · 未运行真实应用</span></div>
          <section className="service-panel" aria-label="应用与更新状态">
            <div className="service-summary"><span className={`service-symbol ${!running ? "offline" : updateFailed ? "warning" : ""}`}><Icon name={updateFailed ? "alertTriangle" : "monitor"} size={22}/></span><div><div className="service-title"><h2>{!running ? "应用已停止" : updateFailed ? "更新检查失败" : empty ? "等待首次运行" : "应用运行正常"}</h2><span className="badge neutral">SHELL</span></div><p>{running ? "已运行 2 小时 34 分钟" : "启动应用后，托盘常驻 + 单实例锁生效"}</p></div><div className="service-actions"><button className="button" disabled={!running} onClick={()=>showInfo("重启效果仅供设计演示，未执行实际操作。")}><Icon name="refresh" size={14}/>重启</button><button className={`button ${running ? "" : "primary"}`} onClick={()=>setScenario(running ? "stopped" : "running")}><Icon name={running ? "pause" : "play"} size={14}/>{running ? "停止应用" : "启动应用"}</button></div></div>
            <div className="chain">{chain.map((segment,i)=><div className="chain-step" key={segment.key}><span className={`chain-icon ${segment.tone}`}><Icon name={segment.icon} size={17}/></span><div><strong>{segment.name}</strong><span>{segment.detail}</span></div>{i<chain.length-1 && <span className="chain-line"><Icon name="arrowRight" size={13}/></span>}</div>)}</div>
            {(updateFailed || empty) && <div className="state-message"><Icon name={empty ? "info" : "alertTriangle"} size={15}/>{empty ? "尚无运行数据。完成下方五步后，启动应用即可看到实时状态。" : "更新检查失败：错误已按网络/验签/版本分类，前端展示可操作提示，不静默。"}</div>}
          </section>
          <section className="connect-panel panel"><div className="section-heading"><div className="section-title"><Icon name="terminal" size={18}/><h2>快速开始</h2></div><button className="text-button" aria-expanded={guideOpen} onClick={()=>setGuideOpen(!guideOpen)}>{guideOpen ? "收起命令" : "展开命令"}<Icon name="chevronDown" size={14} className={guideOpen ? "rotate" : ""}/></button></div>
            <div className="client-tabs" role="group" aria-label="复制即用步骤">{steps.map((s,i)=><button key={s.key} aria-pressed={i===step} className={i===step ? "active" : ""} onClick={()=>setStep(i)}><Icon name={s.icon} size={15}/>{i+1}. {s.label}</button>)}</div>
            {guideOpen && <div className="guide-content"><div className="config-meta"><label>当前步骤<select aria-label="当前步骤" value={step} onChange={e=>setStep(Number(e.target.value))}>{steps.map((s,i)=><option key={s.key} value={i}>{i+1}. {s.label}</option>)}</select></label><span className="auth-label"><Icon name="key" size={13}/>自动更新命脉</span></div><div className="code-block"><div className="code-heading"><span>{current.label}</span><button className="copy-button" onClick={copy}><Icon name="copy" size={13}/>复制命令</button></div><pre><code>{current.cmd}</code></pre></div><div className="guide-foot"><span><Icon name="info" size={14}/>{current.note}</span><button className="text-button" onClick={()=>showInfo(current.note)}>查看说明<Icon name="arrowRight" size={14}/></button></div></div>}
          </section>
          <div className="section-heading metrics-heading"><h2>壳子体质</h2><span>实测口径<span className="small-separator">·</span>Windows · release</span></div>
          <section className="metrics" aria-label="壳子指标">{[
            ["安装包体积", "6", "MB", "NSIS · 红线 ≤ 15MB", "plug"],
            ["关窗省内存", "80", "MB", "销毁 webview · 托盘重生", "minimize"],
            ["本地门禁", "7", "项", "pre-push 全量执行", "shield"],
            ["发版链路", "5", "步", "npm run release 一把梭", "refresh"],
          ].map(([label,value,unit,sub,icon])=><div className="metric" key={label as string}><div className="metric-label">{label}<Icon name={icon as IconName} size={15}/></div><div className="metric-value">{!running ? "—" : empty ? "0" : value}<small>{unit}</small></div><p>{!running ? "应用停止，指标暂停" : empty ? "暂无运行数据" : sub}</p></div>)}</section>
          <div className="bottom-grid"><section className="panel safety-panel"><div className="section-heading"><div className="section-title"><Icon name="shield" size={17}/><h2>工程纪律</h2></div><span className="badge good">机器强制执行</span></div><div className="health-summary"><strong>{!running || empty ? "—" : "7"}<small>{!running || empty ? "" : " 项"}</small></strong><span>本地门禁<small>{empty ? "等待首次运行" : "体量 · fmt · eslint · tsc · vitest · clippy · test"}</small></span></div><div className="protection-grid">{["路径白名单校验", "更新验签（.sig）", "单实例锁", "关窗销毁 webview"].map(s=><span key={s}><Icon name="check" size={13}/>{s}</span>)}</div></section><section className="panel usage-panel"><div className="section-heading"><div className="section-title"><Icon name="refresh" size={17}/><h2>发版链路</h2></div><span>npm run release</span></div><div className="usage-content"><div className="usage-number"><strong>{empty ? "0" : "5"}</strong><span>步 · tag 后全自动</span><p>{empty ? "暂无发版记录" : "版本真源 Cargo.toml，updater.json 跨平台合并防互覆"}</p></div><div className="bars" aria-label="发版各步骤耗时示例（分钟）">{releaseSteps.map(([name,mins],i)=><div className="bar-column" key={name}><div className={i === releaseSteps.length-1 ? "bar today" : "bar"} style={{height: empty ? 2 : Math.round(mins/12*100)}} title={`${name}：约 ${mins} 分钟（示例）`}/><span>{name}</span></div>)}</div></div></section></div>
          <section className="panel activity-panel"><div className="section-heading"><div className="section-title"><Icon name="log" size={17}/><h2>最近动态</h2></div><span>壳子仓库</span></div>{empty ? <p className="empty-activity">尚无动态。复制壳子、跑一次改名，这里就会出现你的第一条记录。</p> : <div className="activity-list">{[
            ["抽离三层架构", "docs / 桌面应用壳子抽离方案", "refactor", "1 轮", "23:06"],
            ["一键改名脚本", "desktop / scripts / rename-app.mjs", "feat", "十余处", "23:34"],
            ["示例页接线", "desktop / src / components / tabs", "feat", "2 页", "23:40"],
          ].map(([label,path,tool,latency,time])=><div className="activity-row" key={time}><span className="activity-check"><Icon name="check" size={13}/></span><span className="activity-name">{label}<small>{path}</small></span><code>{tool}</code><span>{latency}</span><time>{time}</time></div>)}</div>}</section>
          <footer className="page-footer">NCForge<span>复制即用 · 自动更新 · 设计体系</span></footer>
        </main>
      </div>
    </div>
    {notice && <div className="toast" role="status"><Icon name="info" size={17}/><span>{notice}</span>{toolButton("close", "关闭提示", ()=>setNotice(""))}</div>}
  </div>;
}

const root = createRoot(document.getElementById("root")!);
root.render(<App/>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
