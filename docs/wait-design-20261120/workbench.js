// Offline review fixture. Each frame represents a simulated backend event.
const byId = id => document.getElementById(id);
const frame = (title, detail, metric, unit, left, right, percent, event, state = "进行中") =>
  ({ title, detail, metric, unit, left, right, percent, event, state });
const scenes = {
  export: {
    name: "结果导出", subject: "销售订单.csv", head: "查询结果", first: "销售订单.sql",
    frames: [
      frame("正在写入销售订单", "文件将保存到导出目录，当前结果仍可浏览。", "20–30 秒", "预计剩余写入时间", "64,000 / 100,000 行", "近段写入速度 1,500 行/秒", 64, "写入批次已确认，共 64,000 行"),
      frame("写入速度已变化", "收到最近一批写入回执，正在重新估算。", "76,000 行", "已确认写入", "76,000 / 100,000 行", "速率波动，暂缓估时", 76, "最新批次写入变慢，撤下时间预测"),
      frame("正在完成文件", "全部行已写入，等待文件关闭确认。", "100,000 行", "写入阶段完成", "正在封装 CSV", "等待文件系统确认", null, "最后一批已写入，开始封装"),
      frame("导出完成", "销售订单.csv 已保存到导出目录。", "100,000 行", "已保存", "销售订单.csv", "总耗时 58 秒", null, "文件关闭成功，已确认保存位置", "已完成")
    ],
    error: frame("文件写入失败", "磁盘空间不足。释放空间或更换目录后可重新导出。", "", "", "当前文件不可作为完整结果", "", null, "文件系统返回磁盘空间不足", "失败")
  },
  sql: {
    name: "单条查询", subject: "开发库 / 销售订单.sql", head: "查询结果", first: "销售订单.sql",
    frames: [
      frame("查询已发出", "下方保留上次结果。数据库返回后在原位更新。", "14 秒", "已等待", "最近回执 · 请求已发送", "可继续编辑", null, "数据库连接已接受查询请求"),
      frame("仍在等待查询结果", "尚未收到首批数据。可收起任务，或请求数据库停止执行。", "36 秒", "已等待", "最近回执 · 请求已发送", "剩余时间未知", null, "等待满 36 秒，未收到新的数据库事件"),
      frame("查询完成", "新结果已就绪，下方显示本次返回的数据。", "3 行", "本次结果", "开发库 · 查询已结束", "总耗时 39 秒", null, "首批数据返回，结果集读取完成", "已完成")
    ],
    error: frame("连接已中断", "本次 SELECT 未取得结果。重新连接后可再次执行。", "", "", "上次结果仍可查看", "", null, "驱动报告连接中断", "失败")
  },
  build: {
    name: "模块编译", subject: "newar / 增量编译", head: "构建输出", first: "SendRedArriveForHR.java",
    frames: [
      frame("正在编译 uapbd", "当前模块正在生成类文件。", "8 / 12", "已完成模块", "已完成 8 个模块", "模块规模不同，暂无法估时", 66.7, "模块 uapbd 开始编译"),
      frame("正在编译 hrpub", "uapbd 已完成，当前构建产生 1 条警告。", "9 / 12", "已完成模块", "已完成 9 个模块", "当前模块 hrpub", 75, "模块 uapbd 已完成，有 1 条警告"),
      frame("构建完成", "12 个模块已生成产物，有 1 条警告待查看。", "42 秒", "总耗时", "12 个成功 · 0 个失败", "1 条警告", null, "构建完成并收集诊断", "已完成")
    ],
    error: frame("模块编译失败", "uapbd 中有未解析的类型。打开构建记录查看诊断位置。", "1 个错误", "需要处理", "已完成的模块产物保留", "", null, "SendRedArriveForHR.java:53 无法解析类型", "失败")
  },
  import: {
    name: "批量导入", subject: "开发库 / 销售订单.csv", head: "导入预览", first: "销售订单.sql",
    frames: [
      frame("正在导入销售订单", "每批单独提交。请求停止后，已经提交的数据会保留。", "12,000 行", "已提交", "12,000 / 30,000 行", "当前批尚未提交", 40, "第 6 批已提交"),
      frame("正在提交下一批", "已提交的行可在本次导入记录中核对。", "14,000 行", "已提交", "14,000 / 30,000 行", "等待事务回执", 46.7, "第 7 批已提交"),
      frame("导入完成", "共 30,000 行已提交。", "30,000 行", "已提交", "失败 0 行", "耗时 46 秒", null, "最后一批已提交", "已完成")
    ],
    error: frame("导入部分完成", "当前批违反唯一约束。核对失败批次后再处理剩余行。", "", "按回执核对", "当前批未提交", "", null, "当前批回滚，之前的提交已保留", "部分完成")
  }
};
const initialSQL = "SELECT vbillcode, dbilldate, ntotalmny\n  FROM so_saleorder\n WHERE dr = 0;";
const initialJava = "public void sendRedArrive(ArriveVO vo) {\n    arrivalService.apply(vo);\n}";
const editor = document.querySelector("textarea");
const drafts = new Map();
const drawer = byId("drawer");
let key, page, step, active, history, opener, stopping, retained, tableKey;

function text(id, value) {
  const node = byId(id);
  if (node.textContent !== value) node.textContent = value;
}

function origin() {
  return key === "build" ? "code" : "db";
}

function switchPage(target) {
  if (page === target) return;
  if (page) drafts.set(page, editor.value);
  page = target;
  editor.value = drafts.get(page) ?? (page === "code" ? initialJava : initialSQL);
  render();
}

function start(id) {
  key = id;
  step = 0;
  stopping = false;
  active = scenes[key].frames[0];
  history = [active.event];
  closeDrawer(false);
  byId("records").open = false;
  switchPage(origin());
  render();
  text("announce", active.title);
}

function accept(event) {
  const significant = event.title !== active.title || event.state !== active.state;
  active = event;
  history.push(event.event);
  render();
  if (significant) text("announce", event.title);
}

function closeDrawer(restoreFocus = true) {
  if (drawer.hidden) return;
  drawer.hidden = true;
  opener.setAttribute("aria-expanded", "false");
  if (restoreFocus) (opener.hidden ? byId("tasks") : opener).focus();
}

function openDrawer(trigger) {
  if (!drawer.hidden && opener === trigger) {
    closeDrawer();
    return;
  }
  closeDrawer(false);
  opener = trigger;
  trigger.setAttribute("aria-expanded", "true");
  drawer.hidden = false;
  byId("close").focus();
}

function compactLabel(f) {
  if (f.state === "正在停止") return "停止请求已发出";
  if (f.state === "已停止" && key === "import") return "已停止 · 保留 " + f.metric;
  if (f.state !== "进行中") return f.title;
  if (key === "sql") return "等待开发库 · 已用 " + f.metric;
  if (key === "build") return f.title + " · " + f.metric;
  if (key === "import") return "已提交 " + f.left;
  if (step === 2) return "正在完成文件";
  const progress = "导出 " + Math.round(f.percent) + "%";
  return f.unit === "预计剩余写入时间" ? progress + " · 约 " + f.metric : progress;
}

function render() {
  const scene = scenes[key];
  const f = active;
  const running = f.state === "进行中";
  const bad = ["失败", "部分完成"].includes(f.state);
  const atOrigin = page === origin();
  const build = page === "code";
  const estimate = f.unit === "预计剩余写入时间" ? "约 " + f.metric : f.right;
  const tableLabel = build ? "" : !atOrigin ? "" : key === "import" ? "源文件预览" :
    key === "sql" && f.state !== "已完成" ? "上次结果" : "当前结果";

  text("tab", build ? scenes.build.first : scenes.sql.first);
  text("head", build ? "构建输出" : atOrigin ? scene.head : "查询结果");
  text("tablelabel", tableLabel);
  text("compact", compactLabel(f));
  text("context", build ? "newar · Java" : "开发库 · SQL");
  text("tasks", running || stopping ? "任务 · 1 进行中" : bad ? "任务 · 1 待查看" : "任务 · 最近结果");
  text("subject", scene.subject);
  text("title", f.title);
  text("left", key === "sql" && running ? "已等待 " + f.metric : (f.metric && f.state === "已完成" ? f.metric + " · " + f.unit : f.left));
  text("estimate", estimate);
  text("detail", f.detail);

  byId("inline").hidden = !atOrigin;
  byId("inline").title = compactLabel(f);
  byId("inline").dataset.tone = bad ? "bad" : "";
  byId("tasks").dataset.tone = bad ? "bad" : "";
  byId("title").classList.toggle("bad", bad);
  const signal = document.querySelector(".signal");
  signal.hidden = !running && !stopping;
  signal.dataset.wait = String(key === "sql" && atOrigin && running);
  byId("track").hidden = f.percent == null;
  if (f.percent != null) byId("track").value = f.percent;
  byId("railcode").setAttribute("aria-pressed", String(build));
  byId("raildb").setAttribute("aria-pressed", String(!build));
  const stop = byId("stop");
  const canStop = running && key !== "build" && !(key === "export" && step === 2);
  if (!canStop && document.activeElement === stop) byId("close").focus();
  stop.hidden = !canStop;
  byId("fault").disabled = !running;
  byId("next").disabled = !running && !stopping;
  byId("table").hidden = !atOrigin;
  byId("away").hidden = atOrigin;

  const log = byId("log");
  if (log.children.length !== history.length || log.lastElementChild?.textContent !== history.at(-1)) {
    log.replaceChildren(...history.map(event => {
      const entry = document.createElement("li");
      entry.textContent = event;
      return entry;
    }));
  }
  if (atOrigin) renderTable(bad);
}

function renderTable(failed) {
  const variant = key === "build" ? "build:" + step + ":" + failed :
    key === "sql" && active.state === "已完成" ? "new" : "old";
  if (variant === tableKey) return;
  tableKey = variant;
  const columns = key === "build" ? ["模块", "状态", "诊断"] : ["单据号", "业务日期", "订单金额"];
  const data = key === "build" ? [
    ["pub", "已完成", "—"],
    ["uapbd", failed ? "失败" : step === 0 ? "编译中" : "已完成", failed ? "1 个错误" : step ? "1 条警告" : "—"]
  ] : variant === "new" ? [
    ["SO-0811", "11-20", "24,680.00"], ["SO-0812", "11-20", "15,400.00"], ["SO-0813", "11-20", "8,250.00"]
  ] : [
    ["SO-0807", "11-19", "18,400.00"], ["SO-0808", "11-19", "6,280.00"], ["SO-0809", "11-19", "12,900.00"]
  ];
  function row(cells, tag) {
    const tr = document.createElement("tr");
    for (const value of cells) {
      const cell = document.createElement(tag);
      cell.textContent = value;
      tr.append(cell);
    }
    return tr;
  }
  byId("thead").replaceChildren(row(columns, "th"));
  byId("tbody").replaceChildren(...data.map(cells => row(cells, "td")));
}

byId("scenario").onchange = event => start(event.target.value);
byId("reset").onclick = () => start(key);
byId("inline").onclick = event => openDrawer(event.currentTarget);
byId("tasks").onclick = event => openDrawer(event.currentTarget);
byId("close").onclick = () => closeDrawer();
byId("source").onclick = () => {
  switchPage(origin());
  closeDrawer(false);
  byId("inline").focus();
};
byId("railcode").onclick = () => switchPage("code");
byId("raildb").onclick = () => switchPage("db");
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !drawer.hidden) {
    const handlesEscape = drawer.contains(document.activeElement) || document.activeElement === opener;
    closeDrawer(handlesEscape);
    if (handlesEscape) event.preventDefault();
  }
});
document.addEventListener("pointerdown", event => {
  if (!drawer.hidden && !drawer.contains(event.target) && !event.target.closest("[aria-controls=drawer], .review")) {
    closeDrawer(false);
  }
});
byId("reduce").onchange = event => document.body.classList.toggle("reduce", event.target.checked);
document.addEventListener("visibilitychange", () => document.body.classList.toggle("off", document.hidden));
byId("fault").onclick = () => {
  const failure = { ...scenes[key].error };
  if (key === "import") failure.left = "已提交并保留 " + active.metric;
  accept(failure);
};
byId("stop").onclick = () => {
  retained = active.metric;
  stopping = true;
  const detail = key === "import" ? "等待当前批结束，已提交的数据会保留。" : "等待执行方确认停止。";
  accept(frame("已请求停止", detail, "", "", "等待确认", "", null, "用户请求停止", "正在停止"));
};
byId("next").onclick = () => {
  if (stopping) {
    stopping = false;
    const outcome = key === "import" ? "当前批已回滚，之前提交的行仍然保留。" :
      key === "sql" ? "数据库已确认停止，可继续使用上次结果。" : "临时文件已清除。";
    const preserved = key === "import" ? retained : "";
    accept(frame("已停止", outcome, preserved, "", preserved ? "已提交并保留 " + preserved : "停止已确认",
      "", null, "收到执行方停止确认", "已停止"));
  } else if (step + 1 < scenes[key].frames.length) {
    accept(scenes[key].frames[++step]);
  }
};
start("export");
