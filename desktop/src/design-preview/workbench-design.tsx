import { useEffect, useId, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Icon, type IconName } from "../components/ui/icon";
import { Menu, MenuItem } from "../components/ui/Menu";
import { Modal } from "../components/ui/Modal";
import { Switch } from "../components/ui/switch";
import { formatSql } from "../lib/sqlFormat";
import "../index.css";
import "../interaction-refinements.css";
import "./workbench-design.css";

type Page = "sql" | "code" | "settings";
const pages: { id: Page; name: string; icon: IconName }[] = [
  { id: "sql", name: "SQL 控制台", icon: "database" },
  { id: "code", name: "代码工作台", icon: "code" },
  { id: "settings", name: "设置与更新", icon: "settings" },
];

function Tool({ icon, label, onClick, disabled, pressed, primary }: {
  icon: IconName; label: string; onClick?: () => void; disabled?: boolean; pressed?: boolean; primary?: boolean;
}) {
  return <button type="button" className={`wd-tool${primary ? " wd-tool-primary" : ""}`} title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}><Icon name={icon} size={16} /></button>;
}
function Action({ children, onClick, primary, disabled }: { children: ReactNode; onClick: () => void; primary?: boolean; disabled?: boolean }) {
  return <button type="button" className={`wd-action${primary ? " wd-primary" : ""}`} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Pill({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "ok" | "warn" }) {
  return <span className="wd-pill" data-tone={tone}>{children}</span>;
}
const sqlDefault = "SELECT\n    order_no, customer_name, amount, status, created_at\nFROM po_order\nWHERE created_at >= DATE '2026-11-01'\nORDER BY created_at DESC;";
const javaDefault = [
  "package nc.impl.po;",
  "",
  "import nc.vo.po.OrderVO;",
  "import nc.vo.pub.BusinessException;",
  "",
  "public class OrderServiceImpl {",
  "    private final OrderRepository repository;",
  "",
  "    public OrderServiceImpl(OrderRepository repository) {",
  "        this.repository = repository;",
  "    }",
  "",
  "    public OrderVO findByCode(String orderCode) throws BusinessException {",
  "        if (orderCode == null || orderCode.isBlank()) {",
  '            throw new BusinessException("订单编码不能为空");',
  "        }",
  "        return repository.findByCode(orderCode);",
  "    }",
  "}",
].join("\n");

function SourceEditor({ value, change, label }: { value: string; change?: (value: string) => void; label: string }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  return <div className="wd-source">
    <div className="wd-lines" aria-hidden="true">{value.split("\n").map((_, i) => <div key={i}>{i + 1}</div>)}</div>
    {editing && change ? <textarea id={id} aria-label={label} autoFocus spellCheck={false} value={value} onBlur={() => setEditing(false)} onChange={e => change(e.target.value)} /> :
      <pre tabIndex={change ? 0 : undefined} aria-label={label} onFocus={change ? () => setEditing(true) : undefined} onClick={change ? () => setEditing(true) : undefined}>{value.split(/('.*?'|".*?"|\b(?:SELECT|FROM|WHERE|DATE|ORDER BY|DESC|package|import|class|public|private|final|this|return|if|throw|throws|new|null|interface)\b)/g).map((token, i) => <span key={i} className={i % 2 ? (/^['"]/.test(token) ? "wd-string" : "wd-keyword") : undefined}>{token}</span>)}</pre>}
  </div>;
}

const orders = [
  ["PO-261109-028", "长沙瑞科", "48,600.00", "已审批", "2026-11-09 16:48"],
  ["PO-261109-024", "湖南启航", "12,380.00", "已审批", "2026-11-09 15:31"],
  ["PO-261109-021", "广州永联", "8,760.00", "待审批", "2026-11-09 14:25"],
  ["PO-261109-016", "长沙瑞科", "28,400.00", "已审批", "2026-11-09 13:09"],
  ["PO-261109-012", "武汉恒信", "6,200.00", "待审批", "2026-11-09 11:42"],
  ["PO-261109-009", "湖南启航", "19,850.00", "已审批", "2026-11-09 10:18"],
];

function Sql() {
  const [sql, setSql] = useState(sqlDefault);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("查询完成 · 86 ms");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(orders[0][0]);
  const [connectionOpen, setConnectionOpen] = useState(true);
  const [queryKind, setQueryKind] = useState("结果");
  const shown = orders.filter(row => row.join(" ").includes(filter.trim()));
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => { setRunning(false); setStatus("查询完成 · 92 ms"); }, 950);
    return () => clearTimeout(timer);
  }, [running]);
  function run(kind = "结果") { setQueryKind(kind); setStatus("正在执行查询…"); setRunning(true); }
  return <div className="wd-layout">
    <aside className="wd-sidebar">
      <div className="wd-side-title"><strong>数据库连接</strong><span className="wd-quiet"><Icon name="plug" size={16} /></span></div>
      <button type="button" className="wd-connection" aria-expanded={connectionOpen} onClick={() => setConnectionOpen(v => !v)}>
        <Icon name="database" size={18} /><span><strong>NC 测试库</strong><small>Oracle · AIEDEV</small></span><Pill tone="ok">已连接</Pill>
      </button>
      {connectionOpen && <div className="wd-tree">
        <div><Icon name="chevronDown" size={13} /><Icon name="folder" size={15} />表 <span className="wd-tree-count">3</span></div>
        <div className="wd-tree-child wd-selected"><Icon name="layoutRows" size={15} />PO_ORDER</div>
        <div className="wd-tree-child"><Icon name="layoutRows" size={15} />PO_ORDER_B</div>
        <div className="wd-tree-child"><Icon name="layoutRows" size={15} />BD_SUPPLIER</div>
      </div>}
      <div className="wd-side-foot"><Icon name="lock" size={14} />只读查询</div>
    </aside>
    <section className="wd-document" aria-label="SQL 工作区">
      <div className="wd-tabs"><span className="wd-tab current"><Icon name="terminal" size={15} />采购订单.sql</span><span className="wd-tab-context">NC 测试库 / AIEDEV</span></div>
      <div className="wd-toolbar" role="group" aria-label="SQL 工具栏">
        <div className="wd-split">
          <Tool icon="play" label="执行查询 · Ctrl+Enter" primary disabled={running} onClick={() => run()} />
          <Menu align="left" trigger={(open, toggle) => <button type="button" className="wd-tool wd-split-menu" aria-label="执行方式" aria-haspopup="menu" aria-expanded={open} disabled={running} onClick={toggle}><Icon name="chevronDown" size={14} /></button>}>
            {close => <><MenuItem icon="play" label="执行当前 SQL" onClick={() => { close(); run(); }} /><MenuItem icon="queryPlan" label="查看执行计划" onClick={() => { close(); run("执行计划"); }} /></>}
          </Menu>
        </div>
        <Tool icon="stop" label="停止查询" disabled={!running} onClick={() => { setRunning(false); setStatus("已停止查询"); }} />
        <span className="wd-rule" />
        <Tool icon="sqlFormat" label="SQL 美化" disabled={running} onClick={() => {
          void formatSql(sql, "plsql", { keywordCase: "upper", tabWidth: 4 }).then(
            formatted => { setSql(formatted); setStatus("SQL 已美化"); },
            () => setStatus("无法美化当前 SQL，请检查语法"),
          );
        }} />
        <Tool icon="filter" label="筛选结果" pressed={filterOpen} onClick={() => setFilterOpen(v => !v)} />
        <span className="wd-toolbar-end"><Pill>只读</Pill></span>
      </div>
      <div className="wd-sql-editor" onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !running) { e.preventDefault(); run(); } }}>
        <SourceEditor value={sql} change={setSql} label="编辑 SQL" />
      </div>
      <section className="wd-results" aria-label="查询结果">
        <header className="wd-result-head"><strong>{queryKind}</strong><span role="status"><Icon name={running ? "clock" : "check"} size={14} />{status}</span></header>
        {filterOpen && <div className="wd-result-filter"><label><Icon name="search" size={15} /><input placeholder="搜索结果" aria-label="搜索结果" value={filter} onChange={e => setFilter(e.target.value)} /></label></div>}
        <div className="wd-result-body" aria-busy={running}>
          {running ? <div className="wd-running"><span /><span /><span /><span /><p>正在读取结果</p></div> : queryKind === "执行计划" ? <div className="wd-plan"><strong>SELECT STATEMENT</strong><p>TABLE ACCESS BY INDEX ROWID · PO_ORDER</p><p>INDEX RANGE SCAN · IDX_PO_ORDER_DATE</p></div> :
          <table className="wd-grid"><thead><tr>{["#", "ORDER_NO", "CUSTOMER_NAME", "AMOUNT", "STATUS", "CREATED_AT"].map(name => <th key={name}>{name}</th>)}</tr></thead>
            <tbody>{shown.map((row, i) => <tr key={row[0]} data-selected={selected === row[0] || undefined}><td><button type="button" aria-label={`选择第 ${i + 1} 行`} aria-pressed={selected === row[0]} onClick={() => setSelected(row[0])}>{i + 1}</button></td>{row.map((cell, j) => <td key={j}>{j === 3 ? <Pill tone={cell === "已审批" ? "ok" : "warn"}>{cell}</Pill> : cell}</td>)}</tr>)}</tbody></table>}
        </div>
        <footer className="wd-document-foot">{running ? "等待结果" : queryKind === "执行计划" ? "3 个步骤" : `${shown.length} 行`} <span>{queryKind === "执行计划" ? "示例执行计划" : "按创建时间降序"}</span></footer>
      </section>
    </section>
  </div>;
}

function Code() {
  const [file, setFile] = useState("OrderServiceImpl.java");
  const [java, setJava] = useState(javaDefault);
  const [build, setBuild] = useState("就绪");
  const [panel, setPanel] = useState(true);
  const files = ["OrderServiceImpl.java", "OrderRepository.java", "OrderVO.java"];
  const sources: Record<string, string> = {
    [files[0]]: java,
    [files[1]]: "package nc.impl.po;\n\nimport nc.vo.po.OrderVO;\n\npublic interface OrderRepository {\n    OrderVO findByCode(String orderCode);\n}",
    [files[2]]: "package nc.vo.po;\n\npublic class OrderVO {\n    private String orderCode;\n    private String customerName;\n}",
  };
  useEffect(() => {
    if (build !== "编译中…") return;
    const id = setTimeout(() => setBuild("编译成功 · 1.24 s"), 850);
    return () => clearTimeout(id);
  }, [build]);
  return <div className="wd-layout">
    <aside className="wd-sidebar"><div className="wd-side-title"><strong>项目资源</strong><Icon name="folder" size={16} /></div>
      <div className="wd-project"><Icon name="project" size={18} /><span><strong>采购管理</strong><small>nc-purchase</small></span></div>
      <div className="wd-tree"><div><Icon name="chevronDown" size={13} /><Icon name="folder" size={15} />src / nc / impl / po</div>
        {files.map(name => <button key={name} type="button" className={`wd-tree-child${file === name ? " wd-selected" : ""}`} aria-current={file === name || undefined} onClick={() => setFile(name)}><Icon name="javaClass" size={15} />{name}</button>)}</div>
      <div className="wd-side-foot"><Icon name="gitBranch" size={15} />main <Pill>工作区</Pill></div>
    </aside>
    <section className="wd-document" aria-label="代码工作区">
      <div className="wd-tabs">{files.map(name => <button key={name} type="button" className={`wd-tab${file === name ? " current" : ""}`} aria-pressed={file === name} onClick={() => setFile(name)}><Icon name="javaClass" size={15} />{name}</button>)}</div>
      <div className="wd-toolbar"><span className="wd-breadcrumb">src / nc / {file === files[2] ? "vo" : "impl"} / po</span><span className="wd-toolbar-end" />
        <Tool icon="panel" label="显示或隐藏构建面板" pressed={panel} onClick={() => setPanel(v => !v)} />
        <Action onClick={() => { setPanel(true); setBuild("编译中…"); }} primary disabled={build === "编译中…"}><Icon name="hammer" size={15} />{build === "编译中…" ? "编译中…" : "编译模块"}</Action>
      </div>
      <div className="wd-code-editor"><SourceEditor key={file} value={sources[file]} change={file === files[0] ? setJava : undefined} label={file} /></div>
      {panel && <section className="wd-build"><header className="wd-result-head"><strong>构建</strong><span role="status">{build}</span></header><pre>{build === "编译中…" ? "正在编译 nc-purchase…" : build.startsWith("编译成功") ? "✓ nc-purchase 编译完成\n  3 个文件 · 0 个错误" : "模块 nc-purchase 已就绪"}</pre></section>}
    </section>
  </div>;
}

function Settings({ dark, setDark, comfort, setComfort }: { dark: boolean; setDark: (value: boolean) => void; comfort: boolean; setComfort: (value: boolean) => void }) {
  const [section, setSection] = useState("外观与常规");
  const [open, setOpen] = useState(false);
  const [automatic, setAutomatic] = useState(true);
  const [updated, setUpdated] = useState(false);
  return <div className="wd-layout">
    <aside className="wd-sidebar"><div className="wd-side-title"><strong>设置</strong><Icon name="settings" size={16} /></div>
      <nav className="wd-settings-nav" aria-label="设置分类">{["外观与常规", "组件与更新"].map((name, i) => <button type="button" key={name} className={section === name ? "wd-selected" : undefined} aria-current={section === name ? "page" : undefined} onClick={() => setSection(name)}><Icon name={i ? "download" : "palette"} size={16} />{name}</button>)}</nav>
    </aside>
    <section className="wd-document wd-settings">
      <div className="wd-settings-inner"><h1>{section}</h1>
        {section === "外观与常规" ? <div className="wd-card">
          <h2>工作台外观</h2>
          <div className="wd-setting-row"><div><strong>颜色主题</strong><p>调整编辑区、控件和浮层的明暗。</p></div><div className="wd-segments" role="group" aria-label="颜色主题"><button type="button" aria-pressed={!dark} onClick={() => setDark(false)}><Icon name="sun" size={15} />浅色</button><button type="button" aria-pressed={dark} onClick={() => setDark(true)}><Icon name="moon" size={15} />深色</button></div></div>
          <div className="wd-setting-row"><div><strong>界面密度</strong><p>舒适模式增加控件间距和点击面积。</p></div><div className="wd-segments" role="group" aria-label="界面密度"><button type="button" aria-pressed={!comfort} onClick={() => setComfort(false)}>标准</button><button type="button" aria-pressed={comfort} onClick={() => setComfort(true)}>舒适</button></div></div>
        </div> : <div className="wd-card">
          <h2>软件更新</h2><div className="wd-setting-row"><div><strong>后台下载更新</strong><p>更新准备好后，由你选择安装时间。</p></div><Switch checked={automatic} onChange={setAutomatic} ariaLabel="后台下载更新" /></div>
        </div>}
        <div className="wd-card wd-release-card"><img src="/icon.png" width="40" height="40" alt="" /><div><h2>NCForge <Pill>{updated ? "v0.4.0" : "v0.3.0"}</Pill></h2><p>{updated ? "已体验安装完成状态" : "新版本已准备好"}</p></div><Action primary={!updated} onClick={() => setOpen(true)}><Icon name="download" size={16} />查看更新</Action></div>
      </div>
    </section>
    <Modal open={open} onClose={() => setOpen(false)} className="modal-surface wd-modal" ariaLabel="软件更新">
      <header><img src="/icon.png" width="42" height="42" alt="" /><div><h2>NCForge v0.4.0</h2><p>{updated ? "当前已是最新版本" : "更新包已验证，可以安装"}</p></div><Tool icon="close" label="关闭更新" onClick={() => setOpen(false)} /></header>
      <div className="wd-modal-body"><h3>这一版的变化</h3><ul>
        <li><strong>工具栏更好点</strong><p>执行、停止和 SQL 美化集中在一行，常用动作更容易辨认。</p></li>
        <li><strong>控件更整齐</strong><p>按钮、输入框和菜单的大小与圆角统一，键盘焦点更清楚。</p></li>
        <li><strong>弹窗层次更清楚</strong><p>用柔和阴影区分浮层，表格和编辑区保持清晰。</p></li>
      </ul></div>
      <footer><Action onClick={() => setOpen(false)}>{updated ? "关闭" : "稍后"}</Action>{!updated && <Action primary onClick={() => { setUpdated(true); setOpen(false); }}><Icon name="refresh" size={16} />模拟重启更新</Action>}</footer>
    </Modal>
  </div>;
}

function Preview() {
  const initial = new URLSearchParams(location.search).get("page");
  const [page, setPage] = useState<Page>(initial === "code" || initial === "settings" ? initial : "sql");
  const [dark, setDark] = useState(new URLSearchParams(location.search).get("theme") === "dark");
  const [comfort, setComfort] = useState(false);
  const [targets, setTargets] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.add("wd-theme");
  }, [dark]);
  return <main className="wd-shell" data-comfort={comfort || undefined} data-targets={targets || undefined}>
    <header className="wd-topbar">
      <div className="wd-brand"><img src="/icon.png" width="22" height="22" alt="" /><strong>NCForge</strong></div>
      <nav className="wd-page-switch" aria-label="设计稿页面">{pages.map(item => <button type="button" key={item.id} aria-current={page === item.id ? "page" : undefined} onClick={() => setPage(item.id)}><Icon name={item.icon} size={15} />{item.name}</button>)}</nav>
      <div className="wd-preview-tools"><span>交互设计稿</span><Tool icon="target" label="显示点击区域" pressed={targets} onClick={() => setTargets(v => !v)} /><Tool icon={dark ? "sun" : "moon"} label={dark ? "切换浅色" : "切换深色"} onClick={() => setDark(v => !v)} /></div>
    </header>
    <div className="wd-main">
      <nav className="wd-rail" aria-label="工作区导航">{pages.map(item => <button type="button" key={item.id} title={item.name} aria-label={item.name} aria-current={page === item.id ? "page" : undefined} onClick={() => setPage(item.id)}><Icon name={item.icon} size={20} /><span>{item.id === "sql" ? "数据库" : item.id === "code" ? "代码" : "设置"}</span></button>)}</nav>
      <div className="wd-view">{page === "sql" ? <Sql /> : page === "code" ? <Code /> : <Settings dark={dark} setDark={setDark} comfort={comfort} setComfort={setComfort} />}</div>
    </div>
    <footer className="wd-status"><span><Icon name="folder" size={14} />采购管理</span><span>示例工作区</span><span className="wd-status-end"><Icon name="server" size={14} />本地设计预览</span></footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Preview />);
