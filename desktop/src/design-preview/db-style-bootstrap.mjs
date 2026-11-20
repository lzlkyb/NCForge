// SQL 编辑页 P0–P3 视觉基线走查：复用真实外壳/Monaco/工具条/结果网格，IPC 全模拟不连库。
// 提案已落进应用源码，本入口不再加 override——自检量的就是应用实现本身（?clean 隐藏说明面板）。
/* global URLSearchParams, location, document, getComputedStyle, requestAnimationFrame, MutationObserver, setInterval, clearInterval */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import "./db-style-preview.css";

const params = new URLSearchParams(location.search);
const clean = params.has("clean");
const conn = { id: "style-conn", name: "NC测试库", env: "test", source: "manual", url: "jdbc:oracle:thin:@preview.invalid:1521/nc", user: "NC_TEST", autoCommit: false, engine: "rust", hasPassword: true };
const tables = [
  { name: "PO_ARRIVEORDER", kind: "TABLE" }, { name: "PO_ARRIVEORDER_B", kind: "TABLE" },
  { name: "ORG_ORGS", kind: "TABLE" }, { name: "BD_PSNDOC", kind: "TABLE" },
];
const names = { po_arriveorder: "到货单", po_arriveorder_b: "到货单明细", org_orgs: "组织", bd_psndoc: "人员基本档案" };
const rootCols = [
  { name: "PK_ARRIVEORDER", type: "VARCHAR2", full: "VARCHAR2(20)", pk: true, nullable: false, zh: "主键" },
  { name: "VBILLCODE", type: "VARCHAR2", full: "VARCHAR2(40)", pk: false, nullable: true, zh: "单据号" },
  { name: "DBILLDATE", type: "VARCHAR2", full: "VARCHAR2(10)", pk: false, nullable: true, zh: "单据日期" },
  { name: "NMONEY", type: "NUMBER", full: "NUMBER(28,8)", pk: false, nullable: true, zh: "金额" },
  { name: "DR", type: "NUMBER", full: "NUMBER(1)", pk: false, nullable: true, zh: "删除标记" },
];
const bodyCols = [...rootCols, { name: "PK_ARRIVEORDER_B", type: "VARCHAR2", full: "VARCHAR2(20)", pk: true, nullable: false, zh: "明细主键" }];
const idle = () => ({ autoCommit: false, statements: 0, rows: 0, since: 0 });
const DEMO_SQL = "SELECT a.vbillcode, a.dbilldate, b.nmoney\nFROM po_arriveorder a\nJOIN po_arriveorder_b b ON b.pk_arriveorder = a.pk_arriveorder\nWHERE a.dr = 0 AND a.dbilldate >= '2026-01-01'\nORDER BY a.dbilldate DESC;";

mockWindows("main");
mockIPC((cmd, args) => {
  switch (cmd) {
    case "get_config": return { workspace_root: null, nc_home: null, autostart_enabled: false, lang_enabled: false, lang_auto_start: false, lang_xmx_mb: null, linked_overrides: [], auto_compile: false, deploy_on_start: false };
    case "get_app_info": return { version: "0.6.0", platform: "windows", running: false };
    case "workspace_recent": case "resources_status": return [];
    case "get_autostart": return false;
    case "server_status": case "client_status": return { state: "stopped" };
    case "db_conn_list": return [conn];
    case "db_connect": return { url: conn.url, user: conn.user, autoCommit: false };
    case "db_schema_cache": return null;
    case "db_cached_tables": return { tables: [], fetchedAt: 0 };
    case "db_caps": return { engine: "rust", connected: true, cancel: true, stats: true };
    case "db_slot_acquire": return { slot: "style-slot", tx: idle() };
    case "db_slot_release": return null;
    case "db_read_only": return { readOnly: false, tx: idle() };
    case "db_tx": return { tx: idle() };
    case "db_meta":
      if (args.kind === "tables") return { tables };
      if (args.kind === "columns") return { columns: /_b$/i.test(args.arg ?? args.table ?? "") ? bodyCols : rootCols };
      if (args.kind === "ncNames") return { names };
      if (args.kind === "indexes") return { indexes: [] };
      return { names: {} };
    case "db_relations": return { foreign: { kind: "rows", columns: [], rows: [], hasMore: false }, references: { kind: "rows", columns: [], rows: [] }, notes: [], sharedSession: false };
    case "nc_md_dict": return { tables: [], missing: [], tableCount: 0, columnCount: 0 };
    case "db_exec_bound": case "db_exec": case "db_exec_result": {
      const cols = [rootCols[1], rootCols[2], rootCols[3]];
      return {
        kind: "rows", columns: cols, hasMore: false, ms: 42, output: [], tx: idle(),
        rows: Array.from({ length: 12 }, (_, i) => ["DH2026" + (1000 + i), "2026-0" + (1 + i % 9) + "-1" + (i % 9), String(1200.5 + i * 37)]),
      };
    }
    case "db_more_result": return { kind: "rows", columns: [], rows: [], hasMore: false };
    case "db_result_close": return null;
    case "plugin:window|is_visible": return true;
    case "plugin:window|is_maximized": return false;
    default: return null;
  }
}, { shouldMockEvents: true });

localStorage.setItem("ncforge-rail-expanded", "1");
localStorage.setItem("ncforge-db-tabs", JSON.stringify({
  tabs: [
    { kind: "sql", id: "style-sql", title: "SQL 1", connId: conn.id, sql: DEMO_SQL, maxRows: 500, timeoutSec: 60, results: [], view: null },
    { kind: "sql", id: "style-sql2", title: "SQL 2", connId: conn.id, sql: "select * from org_orgs;", maxRows: 500, timeoutSec: 60, results: [], view: null },
  ], active: "style-sql",
}));
await import("../main.tsx");
const store = await import("../lib/dbStore.ts");
await store.loadConns();
await store.connect(conn.id);

// 逐项自检 + 几何申报：rAF 里量，读数进说明面板。量的全是应用源码的实现，不是预览补丁。
function checks() {
  const cs = el => el ? getComputedStyle(el) : null;
  // Monaco 把语义 token 编译成 mtkN 类（颜色进样式表），按文本取样才量得到真色。
  const spanWith = txt => [...document.querySelectorAll(".monaco-editor .view-lines span span")].find(s => s.textContent === txt);
  const col = cs(spanWith("vbillcode"));
  const tbl = cs(spanWith("po_arriveorder"));
  const kw = cs(spanWith("SELECT"));
  const expectCol = document.documentElement.classList.contains("dark") ? "rgb(224, 139, 176)" : "rgb(166, 61, 116)";
  const link = cs(document.querySelector(".dbx-editor .monaco-editor .detected-link"));
  const gh = document.querySelector(".dbx-gh:not(.rn)");
  const t = cs(gh?.querySelector(".t"));
  const menu = cs(document.querySelector(".dbx-header-menu"));
  // 容器查询两档都要量：窄列类型进 tooltip（none），≥150px 宽列 inline 补显。
  const dataGhs = [...document.querySelectorAll(".dbx-gh:not(.rn)")];
  const containerOk = dataGhs.length > 0 && dataGhs.every(g => {
    const wide = g.getBoundingClientRect().width >= 150;
    return cs(g.querySelector(".t")).display === (wide ? "inline" : "none");
  });
  // 环境点是真实元素（选中页签 ::before 被选中标线占用）：逐页签量尺寸与同环境同色。
  const dots = [...document.querySelectorAll(".dbx-tab-env")].map(el => getComputedStyle(el));
  const dotsOk = dots.length > 1
    && dots.every(d => d.display !== "none" && d.width === "8px" && d.height === "8px" && d.backgroundColor !== "rgba(0, 0, 0, 0)")
    && dots.every(d => d.backgroundColor === dots[0].backgroundColor);
  const connName = cs(document.querySelector(".dbx-context-connection .dbx-connpick b")) ?? cs(document.querySelector(".dbx-context-connection strong"));
  const status = document.querySelector(".dbx-edit-status-action");
  // ruler 是 canvas（类名 decorationsOverviewRuler，挂在滚动容器里）：像素里找得到 primary 实色才算标记真画上了。
  const rulerCanvas = document.querySelector(".monaco-editor canvas.decorationsOverviewRuler");
  let rulerOk = false;
  const ref = cs(document.querySelector(".dbx-run-action"))?.backgroundColor.match(/\d+/g)?.map(Number);
  if (rulerCanvas && ref && rulerCanvas.width && rulerCanvas.height) {
    const { width, height } = rulerCanvas;
    const px = rulerCanvas.getContext("2d").getImageData(0, 0, width, height).data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] > 200 && Math.abs(px[i] - ref[0]) <= 2 && Math.abs(px[i + 1] - ref[1]) <= 2 && Math.abs(px[i + 2] - ref[2]) <= 2) { rulerOk = true; break; }
    }
  }
  const h = sel => Math.round(document.querySelector(sel)?.getBoundingClientRect().height ?? 0);
  return {
    geometry: `工具栏 ${h(".dbx-sqlbar")}px · 页签 ${h(".wb-tabs")}px · 表头 ${h(".dbx-ghead")}px（外框高度零改动）`,
    items: [
      ["P0 列名独立色相", !!col && col.color === expectCol && !!tbl && tbl.color !== col.color && !!kw && kw.color !== col.color],
      ["P0 表名去常驻下划线", !!link && link.textDecorationLine === "none"],
      ["P1 区域标签移除", !document.querySelector(".dbx-editor-label")],
      ["P1 页签收为短名+环境点", !document.querySelector(".dbx-doctab .dbx-muted") && dotsOk],
      ["P1 只读句收为两字+tooltip", !!status && status.textContent.trim().length <= 4 && status.title.length > 8],
      ["P1 连接名去 bold", !!connName && connName.fontWeight === "500"],
      ["P2 表头单行（类型窄列进tooltip）", !!t && t.display !== "block" && !!gh && getComputedStyle(gh).containerType === "inline-size" && gh.title.includes("VARCHAR2") && containerOk],
      ["P2 列菜单常驻可见", !!menu && menu.opacity !== "0"],
      ["P3 执行语句行痕+ruler", !!document.querySelector(".dbx-runline") && rulerOk],
    ],
  };
}
const legend = document.createElement("section");
legend.className = "db-style-legend";
legend.setAttribute("aria-label", "视觉基线说明与自检");
function renderLegend() {
  const { geometry, items } = checks();
  legend.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = "P0–P3 已实现 · 基线自检";
  const geo = document.createElement("p");
  geo.className = "db-style-geo";
  geo.textContent = geometry;
  legend.append(title, geo);
  const ul = document.createElement("ul");
  for (const [label, ok] of items) {
    const li = document.createElement("li");
    li.dataset.ok = String(ok);
    li.textContent = `${ok ? "✓" : "✗"} ${label}`;
    ul.append(li);
  }
  legend.append(ul);
  const bar = document.createElement("div");
  bar.className = "db-style-legend-bar";
  const b = document.createElement("button");
  b.type = "button"; b.className = "dbx-btn ghost"; b.textContent = "隐藏说明";
  b.onclick = () => { location.search = "?clean"; };
  bar.append(b);
  const hint = document.createElement("p");
  hint.className = "db-style-geo";
  hint.textContent = "浅/深用顶栏真实主题切换；网格排序/筛选/列宽均为真组件交互。";
  legend.append(bar, hint);
}
if (!clean) document.body.append(legend);

let scheduled = false;
const observer = new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; renderLegend(); });
});
observer.observe(document.getElementById("root"), { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "aria-selected"] });

const start = setInterval(() => {
  const nav = [...document.querySelectorAll(".app-side button")].find(el => (el.getAttribute("aria-label") || el.textContent.trim()).startsWith("数据库"));
  if (!nav) return;
  clearInterval(start);
  nav.click();
  const run = setInterval(() => {
    const btn = document.querySelector(".dbx-run-action");
    const line = document.querySelector(".monaco-editor .view-line");
    if (!btn || !line) return;
    clearInterval(run);
    line.click();
    setTimeout(() => {
      btn.click();
      setTimeout(renderLegend, 900);
    }, 400);
  }, 80);
}, 80);