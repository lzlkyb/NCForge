/* global URLSearchParams, location, document, HTMLInputElement, Event, requestAnimationFrame, Node, MutationObserver, setInterval, clearInterval */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import "./database-review.css";

const params = new URLSearchParams(location.search);
const original = params.has("original");
const clean = params.has("clean");
const production = params.has("prod");
const conn = { id: "db-review", name: production ? "NC 生产示例" : "NC 测试库", env: production ? "prod" : "test", source: "manual", url: "jdbc:oracle:thin:@preview.invalid:1521/nc", user: "NC_TEST", autoCommit: false, engine: "rust", hasPassword: true };
const tables = [
  { name: "ORG_ORGS", kind: "TABLE", zh: "组织" },
  { name: "ORG_DEPT", kind: "TABLE", zh: "部门" },
  { name: "BD_SUPPLIER", kind: "TABLE", zh: "供应商" },
  { name: "BD_MATERIAL", kind: "TABLE", zh: "物料" },
];
const names = Object.fromEntries(tables.map(t => [t.name.toLowerCase(), t.zh]));
const columns = [
  { name: "ID", type: "NUMBER", full: "NUMBER", pk: true, nullable: false, zh: "主键" },
  { name: "CODE", type: "VARCHAR2", full: "VARCHAR2(20)", nullable: false, zh: "编码" },
  { name: "NAME", type: "VARCHAR2", full: "VARCHAR2(100)", nullable: false, zh: "名称" },
  { name: "REGION", type: "VARCHAR2", full: "VARCHAR2(20)", zh: "区域" },
  { name: "DR", type: "NUMBER", full: "NUMBER(1)", zh: "删除标记" },
  { name: "TS", type: "TIMESTAMP", full: "TIMESTAMP", zh: "更新时间" },
];
const fixture = {
  ORG_ORGS: ["总部","华东分公司","上海门店","杭州门店","华南分公司","广州门店","深圳门店","西南分公司","成都门店","测试组织","历史组织","临时仓库"],
  ORG_DEPT: ["财务部","采购部","信息部","审计部","运营部","供应链部"],
  BD_SUPPLIER: ["华东供应商","华南供应商","华北供应商","西南供应商"],
  BD_MATERIAL: ["医用耗材","样品","检验试剂","标签纸","外包装","备用配件"],
};
const records = Object.fromEntries(tables.map(({name}) => [name, fixture[name].map((label, i) => [i+1, String(1001+i), label, ["华东","华南","西南"][Math.floor(i/3)%3], i === 9 ? 1 : 0, "2026-11-"+String(i+1).padStart(2,"0")+" 09:30:00"])]));
const idle = () => ({ autoCommit: false, statements: 0, rows: 0, since: 0 });
let tx = idle();
const pending = [];
let readOnly = false;

mockWindows("main");
mockIPC((cmd, args) => {
  switch (cmd) {
    case "get_config": return { workspace_root: null, nc_home: null, autostart_enabled: false, lang_enabled: false, linked_overrides: [] };
    case "get_app_info": return { version: "0.5.0", platform: "windows", running: false };
    case "workspace_recent": case "resources_status": case "db_pending_tx": return [];
    case "get_autostart": return false;
    case "server_status": case "client_status": return { state: "stopped" };
    case "db_conn_list": return [conn];
    case "db_connect": return { url: conn.url, user: conn.user, schema: "NC_TEST", autoCommit: false };
    case "db_schema_cache": return null;
    case "db_cached_tables": return { tables, fetchedAt: Date.now() };
    case "db_caps": return { engine: "rust", connected: true, cancel: true, stats: true };
    case "db_transfer_file": {
      const req = args.req;
      return { fileName: req.fileName, path: "示例导出/" + req.fileName, rows: req.data?.rows.length ?? records.ORG_ORGS.length,
        bytes: 128, ms: 10, truncated: false, canceled: false, warnings: [], destinationToken: "preview" };
    }
    case "db_slot_acquire": return { slot: "db-review-slot", tx };
    case "db_read_only":
      if (args.enabled != null) readOnly = args.enabled;
      return { readOnly, tx };
    case "db_tx":
      if (args.action === "commit") for (const edit of pending) records[edit.table][edit.index][edit.column] = edit.value;
      if (["commit","rollback"].includes(args.action)) { pending.length = 0; tx = idle(); }
      return { tx };
    case "db_meta":
      if (args.kind === "tables") return { tables };
      if (args.kind === "columns") return { columns };
      if (args.kind === "schemas") return { schemas: ["NC_TEST","PUBLIC"], current: "NC_TEST", user: "NC_TEST" };
      if (args.kind === "ncNames") return { names };
      if (args.kind === "ddl") return { ddl: "CREATE TABLE "+(args.name ?? args.table ?? "ORG_ORGS")+" (ID NUMBER PRIMARY KEY, CODE VARCHAR2(20), NAME VARCHAR2(100), REGION VARCHAR2(20), DR NUMBER(1), TS TIMESTAMP)" };
      return { objects: [], indexes: [], names: {} };
    case "db_exec_bound": case "db_exec": case "db_exec_result": {
      const sql = args.sql;
      const table = tables.find(t => new RegExp("\\b"+t.name+"\\b","i").test(sql))?.name ?? "ORG_ORGS";
      if (/^\s*update/i.test(sql)) {
        const colName = /\bset\s+"?(\w+)"?/i.exec(sql)?.[1]?.toUpperCase();
        const column = columns.findIndex(c => c.name === colName);
        const params = (args.params ?? []).map(value => value?.number ?? value);
        const index = records[table].findIndex(row => String(row[0]) === String(params[1]));
        if (column < 0 || index < 0) return {kind:"update",updateCount:0,ms:8,tx};
        pending.push({table,index,column,value:params[0]});
        tx = { ...tx, statements: tx.statements+1, rows: tx.rows+1, since: Date.now() };
        return { kind: "update", updateCount: 1, ms: 8, tx };
      }
      const conditions = [...sql.matchAll(/\b(CODE|NAME|REGION|DR)\s*=\s*(?::(\d+)|(\d+))/gi)];
      const rows = records[table].map((row,index) => row.map((value,column) => pending.filter(e=>e.table===table&&e.index===index&&e.column===column).at(-1)?.value ?? value))
        .filter(row => conditions.every(([,col,bind,literal]) => {
          const param = bind ? args.params?.[Number(bind)-1] : literal;
          return String(row[columns.findIndex(c=>c.name===col.toUpperCase())]) === String(param?.number ?? param);
        }));
      return { kind: "rows", columns, rows, hasMore: false, rowCount: rows.length, output: [], ms: 18, tx };
    }
    case "plugin:window|is_visible": return true;
    case "plugin:window|is_maximized": return false;
    default: return null;
  }
}, { shouldMockEvents: true });

// Each review version starts with the same unfiltered fixture.
for (const table of tables) {
  const name = table.name.toLowerCase();
  localStorage.removeItem("ncforge.db.tableView:"+conn.id+":nc_test."+name);
  localStorage.removeItem("ncforge.db.filterView:"+conn.id+":"+name);
  localStorage.removeItem("ncforge-db-filter:"+conn.id+":"+name);
}
localStorage.setItem("ncforge-rail-expanded","1");
localStorage.setItem("ncforge-db-tabs", JSON.stringify({
  tabs: [
    { kind: "table", id: "review-table", connId: conn.id, table: "ORG_ORGS", sub: "data", schema: "NC_TEST" },
    { kind: "sql", id: "review-sql", title: "SQL 1", connId: conn.id, sql: "SELECT *\nFROM org_orgs\nWHERE dr = 0;", maxRows: 500, timeoutSec: 60 },
  ], active: "review-table",
}));
await import("../main.tsx");
const store = await import("../lib/dbStore.ts");
await store.loadConns();
await store.connect(conn.id);

function find(selector) { return document.querySelector(selector); }
function setInput(input, value) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,value);
  input.dispatchEvent(new Event("input",{bubbles:true}));
}
function button(label, action, className = "dbx-btn ghost") {
  const el = document.createElement("button");
  el.type = "button"; el.className = className; el.textContent = label; el.onclick = action;
  return el;
}
function activeFilterBar() {
  return [...document.querySelectorAll(".dbx-filterbar")].find(el => el.getClientRects().length);
}
const applied = new Map();
function applyQuickFilter(bar, next) {
  const more = bar.querySelector(".dbx-filter-header button");
  if (more.getAttribute("aria-expanded") !== "true") more.click();
  requestAnimationFrame(() => {
    for (const existing of bar.querySelectorAll("[aria-label^='删除条件']")) existing.click();
    const add = [...bar.querySelectorAll("button")].find(el => el.textContent === "添加条件");
    if (!add) return;
    [...next].reduce((previous, [field, value], i) => previous.then(() => {
      add.click();
      return new Promise(resolve => requestAnimationFrame(() => {
        const select = bar.querySelector('[aria-label="条件 '+(i+1)+' 字段"]');
        const input = bar.querySelector('[aria-label="条件 '+(i+1)+' 值"]');
        if (select && input) {
          select.value = field; select.dispatchEvent(new Event("change",{bubbles:true}));
          setInput(input,value);
        }
        resolve();
      }));
    }), Promise.resolve()).then(() => {
      bar.querySelector(".dbx-filter-header .pri")?.click();
      applied.set(store.getDb().active,next);
      if (more.getAttribute("aria-expanded") === "true") more.click();
      sync();
    });
  });
}

function sync() {
  if (original) return;
  if (find(".dbx-table-filter-header")) return;
  const search = find(".dbx-side-filter");
  if (search && !search.dataset.review) {
    search.dataset.review = "true";
    search.placeholder = "搜索表名 / 中文名";
    search.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing || !search.value.trim()) return;
      const match = find(".dbx-tree .dbx-trow");
      if (!match) return;
      event.preventDefault(); match.click();
    });
  }
  const bar = activeFilterBar();
  const localFilter = find(".dbx-page .dbx-result-tools [aria-label='筛选结果']") ?? find(".dbx-page [aria-label='筛选结果']");
  if (localFilter && !localFilter.dataset.review) {
    localFilter.dataset.review = "true";
    localFilter.setAttribute("aria-label", "筛选已加载行");
    localFilter.title = "筛选已加载行";
    const label = localFilter.lastChild;
    if (label?.nodeType === Node.TEXT_NODE) label.data = "筛选已加载行";
    else if (label?.textContent?.trim() === "筛选") label.textContent = "筛选已加载行";
  }
  if (!bar) return;
  const head = bar.querySelector(".dbx-filter-header");
  const query = head.querySelector(".pri");
  const more = head.querySelector("button");
  const active = store.getDb().active;
  if (!head.querySelector(".review-filter-actions")) {
    const block = document.createElement("div"); block.className = "review-filter-actions";
    block.append(
      button("未删除", () => {
        const next = new Map(applied.get(active) ?? []);
        if (next.get("DR")==="0") next.delete("DR"); else next.set("DR","0");
        applyQuickFilter(bar,next);
      }),
      button("按此值查整表", () => {
        const cell = find(".dbx-gc[aria-selected='true']");
        if (!cell) return;
        const index = Number(cell.getAttribute("aria-colindex")) - 2;
        const field = columns[index]?.name;
        if (!["CODE","NAME","REGION","DR"].includes(field)) return;
        const next = new Map(applied.get(active) ?? []);
        next.set(field,cell.textContent.trim());
        applyQuickFilter(bar,next);
      }),
    );
    head.insertBefore(block,query);
    const chips = document.createElement("div"); chips.className = "review-chips"; chips.hidden = true;
    head.after(chips);
  }
  const block = head.querySelector(".review-filter-actions");
  const cell = find(".dbx-gc[aria-selected='true']");
  const field = columns[Number(cell?.getAttribute("aria-colindex")) - 2]?.name;
  block.children[1].hidden = !["CODE","NAME","REGION","DR"].includes(field);
  block.children[0].setAttribute("aria-pressed", String(applied.get(active)?.get("DR")==="0"));
  const chips = bar.querySelector(".review-chips");
  const filters = applied.get(active) ?? new Map();
  const signature = JSON.stringify([...filters]);
  if (chips.dataset.filters !== signature) {
    chips.dataset.filters = signature;
    chips.replaceChildren(...[...filters].map(([field,value]) => button(columns.find(c=>c.name===field).zh+" = "+value+" ×", () => {
      const next = new Map(filters); next.delete(field); applyQuickFilter(bar,next);
    }, "dbx-btn review-chip")));
    chips.hidden = !filters.size;
  }
  const moreLabel = more.lastChild;
  const queryLabel = query.lastChild;
  if (moreLabel?.nodeType === Node.TEXT_NODE && more.getAttribute("aria-expanded") !== "true" && moreLabel.data !== "更多筛选") moreLabel.data = "更多筛选";
  if (queryLabel?.nodeType === Node.TEXT_NODE && queryLabel.data === "查询") queryLabel.data = "查询整表";
}
document.documentElement.classList.toggle("db-review-proposed", !original);

const review = document.createElement("div");
review.className = "review-mode";
const guide = document.createElement("section");
guide.className = "review-guide";
guide.id = "review-guide";
guide.setAttribute("aria-labelledby", "review-guide-title");
guide.hidden = original;
guide.innerHTML = `
  <div class="review-guide-header">
    <h2 id="review-guide-title">这次改了什么</h2>
  </div>
  <ul>
    <li><strong>找表少开一个窗口</strong><span>左栏搜「部门」，按 Enter 直接打开。</span></li>
    <li><strong>不用重填字段和值</strong><span>选中「华东」，点「按此值查整表」。条件出现后，点 × 清除。</span></li>
    <li><strong>一键查未删除记录</strong><span>查询栏直接点「未删除」，自动应用 dr = 0。</span></li>
    <li><strong>区分两种筛选范围</strong><span>「查询整表」查数据库，「筛选已加载行」只筛当前结果。</span></li>
    <li><strong>写回与提交</strong><span>双击修改，底部按顺序出现「写回」「提交」和「回滚」。</span></li>
    <li><strong>SQL 工具与导出</strong><span>辅助动作收在菜单里，导出前可查看范围与行数。</span></li>
  </ul>
`;
const toggleGuide = button("隐藏改动说明", () => {
  guide.hidden = !guide.hidden;
  toggleGuide.textContent = guide.hidden ? "查看改动" : "隐藏改动说明";
  toggleGuide.setAttribute("aria-expanded", String(!guide.hidden));
  document.documentElement.classList.toggle("db-review-markers", !guide.hidden && !original);
});
toggleGuide.textContent = original ? "查看改动" : "隐藏改动说明";
toggleGuide.setAttribute("aria-expanded", String(!guide.hidden));
toggleGuide.setAttribute("aria-controls", guide.id);
document.documentElement.classList.toggle("db-review-markers", !original && !clean);
review.append(
  button("隐藏标注预览", () => location.search = "?original"),
  button("带标注预览", () => location.search = ""),
  toggleGuide,
);
review.children[original ? 0 : 1].setAttribute("aria-pressed","true");
review.setAttribute("aria-label","切换评审版本");
if (!clean) document.body.append(guide, review);

let scheduled = false;
const observer = new MutationObserver(() => {
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(() => { scheduled=false; sync(); });
  }
});
observer.observe(document.getElementById("root"),{subtree:true,childList:true,attributes:true,attributeFilter:["aria-selected","aria-expanded","hidden"]});
const start = setInterval(() => {
  const nav = [...document.querySelectorAll(".app-side button")].find(el => (el.getAttribute("aria-label") || el.textContent.trim()).startsWith("数据库"));
  if (!nav) return;
  clearInterval(start);
  nav.click();
  const expand = setInterval(() => {
    const row = document.getElementById("dbx-conn-"+conn.id);
    if (!row) return;
    clearInterval(expand);
    if (row.getAttribute("aria-expanded") !== "true") row.click();
    sync();
  },80);
},80);
