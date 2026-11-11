import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardTitle } from "../components/ui/card";
import { Icon } from "../components/ui/icon";
import { Menu, MenuItem } from "../components/ui/Menu";
import { Switch } from "../components/ui/switch";
import "../index.css";
import "../interaction-refinements.css";
import "../appearance.css";
import "../workbench-layout.css";
import "../glass-material.css";
import "../interaction-density.css";
import "../native-workbench.css";
import "../selection-states.css";
import "../content-first.css";
import "../db-console.css";
import "../db-execution.css";
import "../forge-controls.css";
import "./controls-preview.css";

function Sample({ upgraded }: { upgraded: boolean }) {
  const [pending, setPending] = useState<"query" | "connection" | null>(null);
  const running = pending === "query";
  const [completed, setCompleted] = useState(false);
  const [filter, setFilter] = useState(false);
  const [name, setName] = useState("NC 测试库");
  const [connected, setConnected] = useState(false);
  const [readOnly, setReadOnly] = useState(true);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => {
      setPending(null);
      if (pending === "query") setCompleted(true);
      else setConnected(true);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [pending]);

  return <section className={upgraded ? "forge-controls controls-sample" : "controls-sample controls-baseline"}>
    <h2>{upgraded ? "升级后" : "升级前"}</h2>
    <div className="controls-frame">
      <header className="controls-frame-head"><Icon name="server" size={18} /><strong>数据库工作台</strong><Badge variant="secondary">测试</Badge></header>
      <div className="dbx-console controls-console">
        <div className="controls-toolbar dbx-execution-primary" aria-label="SQL 工具栏" role="toolbar">
          <div className="dbx-runsplit">
            <button type="button" className="dbx-btn dbx-run-action" title="执行查询" aria-label="执行查询" disabled={pending !== null} onClick={() => setPending("query")}><Icon name="play" size={16} /></button>
            <button type="button" className="dbx-btn dbx-run-menu" title="重新执行" aria-label="重新执行" disabled={!completed || pending !== null} onClick={() => setPending("query")}><Icon name="chevronDown" size={13} /></button>
          </div>
          <button type="button" className="dbx-ibtn dbx-stop-action" aria-label="停止查询" title="停止查询" data-running={running || undefined} disabled={!running} onClick={() => setPending(null)}><Icon name="stop" size={14} /></button>
          <button type="button" className="dbx-ibtn" aria-label="只看启用行" title="只看启用行" aria-pressed={filter} data-on={filter || undefined} onClick={() => setFilter(value => !value)}><Icon name="filter" size={16} /></button>
          <span className="controls-query-status" role="status">{running ? "执行中…" : completed ? "查询完成" : "待执行"}</span>
        </div>
        <table className="controls-grid">
          <thead><tr><th>编码</th><th>名称</th><th>状态</th></tr></thead>
          <tbody><tr><td>A001</td><td>采购订单</td><td><Badge variant="success">启用</Badge></td></tr>
            {!filter && <tr><td>A002</td><td>采购退货</td><td><Badge variant="secondary">停用</Badge></td></tr>}</tbody>
        </table>
      </div>
    </div>
    <Card className="controls-card">
      <CardTitle icon={<Icon name="plug" size={16} />}>连接设置</CardTitle>
      <label className="controls-field">连接名称<input className="input" value={name} onChange={event => setName(event.target.value)} /></label>
      <div className="controls-option"><span>只读连接</span><Switch checked={readOnly} onChange={setReadOnly} ariaLabel="只读连接" /></div>
      <div className="controls-actions">
        <Button type="button" disabled={!name.trim() || running} isLoading={pending === "connection"} loadingText="检查中…" onClick={() => setPending("connection")}><Icon name="plug" size={15} />测试连接</Button>
        <Menu trigger={(open, toggle) => <Button type="button" variant="outline" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>更多<Icon name="chevronDown" size={13} /></Button>}>
          {close => <MenuItem label="重置连接" icon="refresh" onClick={() => {
            setName("NC 测试库");
            setConnected(false);
            setReadOnly(true);
            if (pending === "connection") setPending(null);
            close();
          }} />}
        </Menu>
        <Button type="button" variant="destructive" size="sm" disabled={!connected || pending !== null} onClick={() => setConnected(false)}>断开</Button>
      </div>
      <p className="controls-message" role="status">{connected ? <Badge variant="success">测试通过</Badge> : "示例连接"}</p>
    </Card>
  </section>;
}

function Preview() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return <main className="controls-page">
    <header className="controls-page-head">
      <div><h1>NCForge 组件对照</h1><p>试运行查询、切换筛选或测试示例连接。</p></div>
      <Button type="button" variant="outline" aria-pressed={dark} onClick={() => setDark(value => !value)}><Icon name={dark ? "sun" : "moon"} size={16} />{dark ? "切换浅色" : "切换深色"}</Button>
    </header>
    <div className="controls-comparison"><Sample upgraded={false} /><Sample upgraded /></div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Preview />);
