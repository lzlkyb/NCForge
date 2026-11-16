# NCForge v0.5.0 之后改动全面 Bug 审查（终版）

- **范围**：`v0.5.0..HEAD`（50 笔提交、1072 文件、+126845/-4316）+ 工作区未提交改动
- **方式**：6 个分区并行只读审查 → **lead 对每一条疑似 bug 亲自读源码、追到消费端再定级**
- **日期**：2026-11-16
- **结论**：**28 条确认（7 中 + 21 低）、4 条误报、1 条待外部契约、若干打磨项不立案**
- **修复进度（2026-11-16 收口）**：**28 条确认项全部已修**（7 条中级 + 21 条低级），逐条红灯验证；**无剩余待修**。
  > **L20、L21 复核后判定为误报**（详见第四节）：L20 改动已完整回滚；L21 产品行为零改动，只把判据写进注释。
  > 确认数由 30 → 29 → **28**，误报由 2 → 3 → **4**。
  > 审查阶段未改产品代码；修复阶段经用户「请继续执行任务」授权后开工。**所有修复未提交、未推送、未发布上传。**
- **门禁（28 条全部修完后的全量复核）**：`tsc --noEmit` exit 0 · `eslint .` exit 0 · `check-component-size` / `check-source-size` exit 0 · vitest **563 文件 / 4112 测试全绿** · `cargo test` **1265 passed / 2 failed**（既有，与基线一致：`file_template` 注释转义、`shadow` 真实 jdt.ls）· `cargo clippy --all-targets -D warnings` exit 0 · `cargo fmt --check` exit 0 · `node --test db-bridge-contract` 2/2

---

## 一、定级方法（本次最重要的判据）

> 🔴 **agent 报的严重度必须自己追到消费端再定级。「代码里有这个模式」≠「用户可见 bug」。**

本轮复核带来的定级修正：

| 方向 | 条目 | 依据 |
|---|---|---|
| 下调 | `NcSvnBridge.java:389` 中→低 | 下游三层重排（`by_module` BTreeMap → `flatten` → `sort_by_key`）把顺序问题吃掉 |
| 下调 | `library_cmds.rs:57` 中→低 | 单飞 + 全局 Mutex 750ms + 失败是 `continue` 不是 `Err`，三层保护 |
| 上调 | `NcDbBridge.java:961` 低→中偏低 | 找不到闭合符就 `end=n`，**吞掉整条 SQL 剩余部分** |
| 上调 | `content_pack.rs:134` 存疑→确认 | release **无 `overflow-checks`** ⇒ wrapping 让校验层被绕过 |
| 上调 | `watcher.rs:101-121` 存疑→确认 | 「只支持 format 10」的前提**已被本次 SVNKit 1.10.11 双格式升级推翻** |
| 提前 | `tabPersistence.ts:47` | `saveTabSnapshot` 也调同一函数 ⇒ **写盘那刻就丢，不必等重启** |
| 扩大 | `useFileSave.ts:85` | `encodingIssue` 连关标签都不清（生命周期全文无该字段） |
| 收窄 | `navHistory` 连点 | `openFile` 对非 deferred 标签同步命中 ⇒ **只有 deferred 标签稳定复现** |
| **撤销** | `sqlPredicateContext.ts:25` L20 **确认→误报** | 修复时全量 vitest 跑出 `sqlProviders.test.ts` 两条失败，读原文确认「显式分组时可以选」是**两处独立测试钉住的有意设计** ⇒ 改动已完整回滚 |
| **撤销** | `reviewMarks.ts:22/55` L21 **确认→误报** | 后端 `svn_review::is_valid` 只比 `revision + mtime_ms + size`，**mtime 是毫秒精度**：同毫秒写回 / 等长替换 / 编辑器「写临时文件再 rename 回来」时后端仍判有效 ⇒ 前端黑名单是**更保守的兜底**，按报告建议清掉反而会把「可能没审过的内容」标成已审 |

**共同根因**：真问题集中在**新写路径没复用既有真源**（归一化 `keyOf`、`quote_ident`、`isImeComposing`、`missing_tables`、已解析的 `analysis`）。

> 🔴 **本轮最重要的方法论判据：既有测试是设计契约，不是障碍。**
> L20 我判成真 bug 并改成 `negated: frame.negated`，局部 6 条测试全绿、红灯也精确命中——**但全量门禁才暴露它违背了既有设计**。
> 改产品代码前先读既有测试钉的是什么语义；**局部绿 ≠ 全量绿**，测试红了先怀疑自己改错，别急着让测试迎合自己。
> L21 是同一判据的第二次命中：报告建议与 `reviewMarks.test.ts:65-76`「文件被外部改动后需要重审，旧扫描不会恢复角标」直接冲突 ⇒ **先读后端真源 + 既有契约，再决定要不要动手**。两条误报都没有改坏产品，靠的都是这一步。

---

## 二、中级（7 条，建议优先修）

### M1 【已修 2026-11-16】`lib/tabPersistence.ts:47-49` — 两个 keep 互相覆盖，前台标签写坏 【探针实证】

```ts
for (const want of keep) {
  if (want && all.includes(want) && !head.includes(want)) head[head.length - 1] = want;
}
```

两个 keep（activePath、splitPath）都写**同一个末位**，第二个覆盖第一个。

- 探针（25 标签、active=f23、split=f24）：`activePath 保住? false`、`实际落在 f0.java`
- **写盘即丢**：`saveTabSnapshot:69`/`:75` 同样调用 ⇒ 切/关标签就把 localStorage 里的 activePath 写坏
- 触发条件：active 与 split **同时**排在第 20 名之后
- 单测 `tabPersistence.test.ts:34-42` 只测单 keep 回落，未覆盖双 keep 超限 ⇒ 门禁绿

**修复**：给每个 keep 分配不同槽位（从末位往前找第一个不属于 keep 集合的位置），或先收集全部 keep 再一次性替换末 N 位；补双 keep 超限单测。

### M2 【已修 2026-11-16】`lib/dbActions.ts:399` — 确认丢弃后清零，执行仍可中止 ⇒ 脏标记永久消失 【数据丢失】

`dbDirtyEdits.ts:10` 白纸黑字：**「只存计数，不存改动本身：真正的改动仍在组件里」**，`clearEditsForTab:47-53` 只 `counts.delete`。

`:399` 清零之后仍有 **8 条 return 中止路径**：`:422` 危险语句二次确认取消 / `:428` operationActive 或事务 lost / `:440` beginOperation 返回 null / `:459` ensureConnected false / `:460` catch / `:461` stopRequested / `:462` 连接已切 / `:463` targetCurrent 失效。

**不会自愈**：重报 effect `RowsEntryView.tsx:47-49` deps `[tab.id, entry.id, dirtyCount]`、`useTableTabSync.ts:19-21` deps `[tabId, dirtyCount]` —— 中止时这些值全没变，effect 不重跑。

后果：改动仍在网格 state 里，但小圆点消失、`pendingForTab` 恒 0 ⇒ `confirmDiscardEdits:62` / `requestActivateTab:82` / `requestRestoreClosedTab:92` 全部不再询问，**切标签即静默丢失**。

**修复**：把 `clearEditsForTab(tabId)` 挪到「结果集确定被替换」那一刻（`:447` patchTab 之前，或首次 execOne 成功后）。语义就是「结果真被替换了才清」。
**单测缺口**：`dbMultiResult.test.ts:104-112` 只测「取消保留计数」，没测「确认后中止」。

### M3 【已修 2026-11-16】`review_blocks.rs:39-41` + `req_cmds.rs:263-266` — 块级已审标记跨工作区误删 【数据丢失】

- `BlockStore::path` 是 **config_dir 全局单文件**，key 为绝对路径（设计上跨工作区共存）
- `req_prune` 拿**当前工作区**的 changed 调 `prune`，而 `prune:92-96` 是纯集合差集 `marks.retain(|k,_| changed.contains(path_part(k)))`
- ⇒ **切到工作区 B 后，B 的任意一次成功扫描就删光 A 的块级标记**，切回 A 审查进度归零
- 对照：`req_store.rs:147-150` ReqStore **按根 sha256 前 16 位分文件**，所以没事——BlockStore 漏了这层作用域
- 触发链：`useSvnStatus.ts:66` → `requirements.ts:108-116` → `req_prune`
- `:258 changed.is_empty()` 只挡空结果，挡不住「B 有改动但 A 的路径不在其中」

**修复**：BlockStore 按根分文件（与 ReqStore 对齐，推荐）；或 prune 时按当前根前缀过滤 key。

### M4 【已修 2026-11-16】`watcher.rs:124` — 绝对路径误入相对路径忽略规则 ⇒ SVN 脏跟踪全失效

`svn_relevant` 末行传的是**绝对路径**，而 `svn_view.rs:95-96` 头注释明写「判断只看相对路径」，`:112-117` 对**任意非末段**匹配 `IGNORED_DIRS`（classes/out/target/.nc-compile/.ncforge-tmp/bin）。

⇒ 工作区位于 `D:\out\newar`、`C:\dev\target\ws` 这类路径下时，**所有文件 `svn_relevant` 恒 false** ⇒ 脏集永远空 ⇒ 首次全量后所有增量走 Cached。

**加重**：两个手动刷新入口（`SvnReview.tsx:108` / `ReqReview.tsx:70`）都是 `refresh()` 默认 `force=false`，**用户无自助脱困手段**。

**修复**：先 `strip_prefix(root)` 再传相对路径。

### M5 【已修 2026-11-16】`watcher.rs:101-121` — 只认 `.svn/entries`，本次 SVNKit 升级的配套缺口

`:121` 只认 `entries`。但 **SVNKit 1.10.11 双格式通吃**后，用户副本可以是 1.7+（单一 `.svn/wc.db`）：

- 1.7+ 副本里 `entries` 是占位内容（`12`），**不随 add/delete 变**，真正的纳管变更只写 `wc.db`
- ⇒ 外部 `svn add`/`delete` 已存在文件时，文件本身没被写、脏集为空 ⇒ 增量走 Cached ⇒ **新增/删除在版本页不可见**
- 单测 `:740-747` 注释还写着「format 10 每个目录一份」，判据已过期

**修复**：`:121` 增加认 `wc.db`，同步更新注释与单测。**这是升级 SVNKit 时漏改的配套点，与本次未提交改动直接相关。**

### M6 【已修 2026-11-16】`vo_map_cmds.rs:110-122` — B3 反查假报「查不到表」

```rust
let table = row.text("tname").trim().to_lowercase();   // :63 收集小写
let found: Vec<&str> = built.iter().map(|t| t.name.as_str()).collect();  // :111 原样大写
let missing = table_names.iter().filter(|n| !found.contains(n))          // :115 小写比大写
```

链路：`md_dict_sql.rs:116 lower(t.name) in (...)` 能查到 → `md_dict.rs:181/272` 原样保留大写。
⇒ **只要有一张表真缺失，就把全部表报成查不到**。

**修复**：复用 `md_dict.rs:721 missing_tables()`（两边 lowercase 的既有真源）。

### M7 【已修 2026-11-16】`SettingsLayout.tsx:104-125` — 侧栏滚轮劫持，分类多了滚不动

- `:106 event.preventDefault()` **无条件**执行（只在 ctrl/meta/shift/横向滚动时早退）
- `settings-center.css:10` `.wb-settings-menu { overflow:auto }` **自身可滚**
- ⇒ 分类超出侧栏高度时**滚轮永远在切分类、侧栏自身滚不动**
- `:119 if (!next) return` 到首/末分类后**滚轮完全无响应**（preventDefault 已执行，原生滚动也被吞）

**修复**：`preventDefault` 前先判 `scrollHeight > clientHeight`，需要滚时让原生滚动优先。

---

## 三、低级（21 条确认，L20/L21 已剔除为误报；**全部已修**）

### Rust / Java（10 条）

| # | 位置 | 问题 | 修复（实际落地） |
|---|---|---|---|
| L1 ✅已修 | `NcDbBridge.java:961` + **另 3 份实现** | q-quote 判据四份不一致（详见下方「L1 定级更正」） | 四处共用一套三守卫判据 + 12 条回归测试，全部红灯验证 |
| L2 ✅已修 | `content_pack.rs:134` | `c.off + c.len as u64` u64 溢出，索引是**不可信输入**，release 无 overflow-checks ⇒ `u64::MAX+1=0` **通过校验**（`chunk()` 兜底故非内存不安全，但防线只剩一道） | 抽纯函数 `chunk_in_range(off,len,bin_len)` 用 `checked_add`；2 条测试（坏包整份拒绝 + 纯判据不依赖 profile）。**dev 默认开 overflow-checks，裸 `+` 在测试里是 panic 不是 wrapping** ⇒ 端到端断言写成 `matches!(catch_unwind(..), Ok(false))`，另用纯函数钉 release 语义 |
| L3 ✅已修 | `db_rust.rs:2800-2808` + `ddl()` | 拼索引 DDL 时 `it.name`/`table`/`owner` 直塞双引号**不翻倍**；`ddl()` 不拆 owner 前缀（`pk_columns` 已拆）⇒ `aier633.gl_docfree2` 整串当对象名传永远 ORA-31603 | 统一走 `quote_ident` 同一套翻倍转义；`split_qualified` 拆 owner，`get_ddl` 带 owner 时用**三参重载**显式指定 schema（抽 `get_ddl_sql`/`table_or_view_ddl`/`object_ddl`/`index_ddl` 便于脱库单测）；`ddl_text` 兼容 VARCHAR2 与 CLOB |
| L4 ✅已修 | `java_run.rs:208-226` | `take(64KB).read_until` 切断多字节字符 ⇒ UTF-8 Err ⇒ `workspace.rs:567-569` **整块 64KB 回退 GBK**（不只丢一个字符） | `complete_prefix_len` 只截「尾部残缺」，`carry` 拼到下一轮；**中间就有非法字节时整块交出去**（那本就是 GBK/二进制，不能在这里截）；EOF 的半截原样发出不静默吞。5 条测试：64KB 边界中文 / 4 字节字符切在 1~3 字节 / 纯判据 / GBK 不被改坏 / EOF 残留不丢 |
| L5 ✅已修 | `db_relations_cmds.rs:130` | maxRows=800 截断 7 张元数据表全列，无 hasMore 检查 ⇒ `ormap_attribute` 认不出 ⇒ **静默降级**「不提供业务补全」 | `META_MAX_ROWS=5000`；`metadata_columns` 返回 `(cols, Option<截断说明>)`，说明一路带到 `notes` 并**置 `partial=true`**（即使后面几块都读成功）；认不出属性列时把截断原因拼进错误文案 |
| L6 ✅已修 | `lang-index-bench.mjs:214` | 5min guard 直接 resolve ready，**~300000ms 被当实测索引耗时落盘** —— 违反「没数就是未测，不填 0」红线 | `timedOut` 标志 + `totalMs=null`，全部经 `indexMs()` 取值；差值只在两侧非 null 时才算；表格/结论打印「未测（超时 300000ms）」并列出 `timedOutRounds`，不计入任何耗时结论 |
| L7 ✅已修 | `java_diagnostics_cmds.rs:87` | jfr-stop 复用 45s，落盘数百 MB profile 超时 ⇒ 杀进程 ⇒ **jfr 文件半截**且目标 JVM 录制仍在跑 | `diagnostic_timeout(action)`：jfr-stop **180s**，其余只读快照仍 45s；测试同时钉「其余动作不许跟着放宽」 |
| L8 ✅已修 | `NcSvnBridge.java:389` | 遍历 LPT 重排后的 todo，违反注释承诺（下游三层重排已消化，残留仅 `seen.add` 去重胜者漂移） | 抽静态纯函数 `mergeOrder(scheduled)` 返回**原始升序副本**（不改入参，调度顺序留给并发派发）；调度用 LPT、合并用原始序，两件事分开 |
| L9 ✅已修 | `library_cmds.rs:57-58` | 建包失败无退避（单飞 + 全局锁 + `continue` 已压住危害，是浪费 IO 非功能损坏） | `Slot.failed_at` + `RETRY_BACKOFF=30s`，抽纯函数 `should_launch(building,has_catalog,stale,failed_at)`；成功清 `failed_at`。2 条测试（退避窗口 / 不改坏单飞与刷新） |
| L10 ✅已修 | `change_shelf.rs:74-86` | 一份坏 json 拖垮 `list()`/`create()`，无「损坏按空处理」自愈（同仓其它 store 都有） | 单个 load 失败 `eprintln` + `continue`，**坏文件不删**（删了就是静默丢数据）；1 条测试同时钉「好副本还在 / 坏文件仍在磁盘 / create 不被挡 / 单独 read 坏副本仍报错」 |

#### L1 定级更正（2026-11-16 修复时用探针实测，推翻原描述）

> 🔴 **原文举的例子 `freq'[x]'` 不成立**：探针实测它的 `:1` **正常转成了 `?`**——因为 `[x]` 的闭合符 `]'` 恰好找得到。
> 原描述「找不到闭合就吞 SQL」方向对，但触发条件写错了。**判据：结论必须跑出来，不能推出来。**

实测真正的破口有四条，**根因是 q-quote 判据在仓库里有四份实现、彼此不一致**：

| 实现 | 原状态 | 实测后果 |
|---|---|---|
| `NcDbBridge.toQuestionMarks:961` | 有 q-quote，缺前字符守卫 | `freq'abc'` / `freq'2024-01-01'`（定界符**非括号**时才触发）⇒ `end=n` 吞掉后续 ⇒ `:1` 不转 `?` ⇒ ORA-01008 |
| `NcDbBridge.stripLiterals:2566` | **完全不认 q-quote** | `q'[it's open :7 for select 1]'` 被切成 `q''s open :7 for …]''` ⇒ `cursorOutBinds` 返回 `[7]` ⇒ **普通 SELECT 被当游标调用**去 `registerOutParameter(7, CURSOR)` |
| `db_rust::strip_literals:2559` | **完全不认** | `q'[it's for update]'` ⇒ `has_for_update` 命中 ⇒ **只读查询被记成持锁事务** |
| `db_engine::strip_literals:1050` | **完全不认** | 字面量里的 `update` ⇒ `readonly_query` 拦下只读 SELECT；`open :N for` ⇒ `refcursor_need` 返回 `OutBind`，**把查询路由去另一个引擎** |

**修复**：四处共用一套**三守卫**判据（`qQuoteEnd` / `q_quote_end` / `q_quote_end_bytes`）：

1. 前一字符不能是标识符字符（`freq` 的 `q` 是列名尾巴）
2. **例外：NCHAR 前缀 `n`/`N` 放行** —— `nq'[it's :99]'` 是合法写法。**这条是修复过程中探针抓到的新 bug**：只加守卫 1 会把串内 `:99` 转成 `?`、串外 `:1` 反而漏掉，**比不修更糟**
3. 找不到闭合符**就不认**，交回普通字符串分支（未闭合本就是非法字面量，该让 Oracle 报 ORA-01756，不能改写成另一条语句）

**验证**：Java 契约 + Rust 两侧共 12 条回归用例，**逐条红灯验证**（去掉任一守卫都有对应用例精确变红；`db_engine` 红灯实测 `left: Some(OutBind)`，与探针预言一致）。合法基线（四种括号 + 自定义定界符 + 大写 Q + 真游标 + 真 FOR UPDATE）一字未变。

### 前端（13 条：11 条已修 + 2 条误报）

| # | 位置 | 问题 | 修复（实际落地） |
|---|---|---|---|
| L11 ✅已修 | `workspace_edit.rs:97-99` | `source != destination && destination.exists()` **拒绝纯大小写改名**（Windows `A.java→a.java`）；`rename_entry` 有特判，事务路径没有 | `case_only_rename`（canonicalize 相等 + 仅 Windows 认）；**三处连带**：① `resolve_safe_path` 的 canonicalize 会把名字还原成磁盘真实大小写 ⇒ 安全校验仍走 checked，只在同一文件时把用户拼写换回来；② 循环移动判定与「删源」步骤都要跳过 case_only（目标就是源自己，再删一次会把文件删没）；③ Windows 不能一步 rename 到同名异大小写 ⇒ `case_rename` 走中转名（新内容先落中转 → 删源 → 改名），`case_rollback` 写回原内容再改回原名，两步错误分开报 |
| L12 ✅已修 | `SearchResults.tsx:160` | **回归**（git 对照证实）：v0.5.0 有 `\|\| closest("[data-hit-key]")`，HEAD 删了。命中行是 button，`navigate` 不移焦点 ⇒ Enter 走原生 click **打开旧命中** | 恢复那半条 |
| L13 ✅已修 | `useFileSave.ts:85-88` | catch **无 epoch/root/标签守卫**（try `:58`/`:63` 都有）⇒ 保存中关标签后失败 ⇒ 僵尸「异地修改」横幅。另 `encodingIssue` 在 `useFileTabLifecycle.ts` **全文无清理** | catch 复用同组守卫（失败本身不丢，`trackOperation` 已记 failed）；生命周期**四条路径**都处理 encodingIssue：`closeTab`/`closeMany`/`handleDeleted` 清、`handleRenamed` remap（提示要留住）。新增 `useFileTabLifecycle.test.tsx` 5 条（含「关别的标签不误清」负向对照）+ `useFileSave.test.tsx` 3 条 |
| L14 ✅已修 | `useFileSession.ts:229` | jdt 分支 `openJdt(path, line, false)` **丢 column**（第 4 参就是 column，普通分支传了） | 补 `p.column` |
| L15 ✅已修 | `useHistoryEditorText.ts:5-9` | `getModel(path)` 未建好即空订阅，deps `[path, enabled]` ⇒ **model 后到位不重订阅**，历史对比静默退化成磁盘对比 | 订阅 `editorStore.onModelLifecycle`，**只对本路径**的 opened/closed 重挂 `onDidChangeContent` 并 `listener()`；连带补 `HistoryPanel.test.tsx` 的 mock 导出（否则全量 vitest 5 条红） |
| L16 ✅已修 | `useFileSession.ts:233` + `navHistory.ts:91` | 连点后退吃一格（抢号顶掉前次 ⇒ 不 navCommit）。**只有 deferred 恢复标签稳定复现** | 抽 `lib/navQueue.ts`（52 行纯逻辑 + 5 条单测）：**串行队列**而非丢弃，目标在**出队时**才 `navLook` 求值（`navLook` 不动游标，连点两次会拿到同一目标）；`{delta}` 与 `{index}` **判别式分开**（`goToHistory(1)` 的 1 是下标不是「前进一格」）；无目标时清空剩余队列；收尾期间进来的请求重新起链不丢。主文件 325→**291 行**回到门禁内 |
| L17 ✅已修 | `sqlStatementTitle.ts:73` | **【探针实证】** 空行检测测的是**注释之后全部剩余文本**，含语句体内部 ⇒ `-- 物料主档\nselect a,\n\n b from t` 返回 **null**，多行 SQL 丢标题 | 只测「注释结束到第一个非空白字符」之间的间隙 |
| L18 ✅已修 | `javaEditingPlan.ts:112` | **【探针实证】** `blankLiterals` 保留长度，`code.trimEnd().length` 偏短 ⇒ 切片把字符串尾段切进来 ⇒ `String url = "http://nc.com/a"` **补全分号失效**。`:103-109` 状态机已判对，`:112` 又用文本切片推翻 | `:112` 整条冗余可删（`:108` 已在真注释时 return null） |
| L19 ✅已修 | `sqlBillAssist.ts:77` | **【探针实证】** 全文 `text.includes(spec.table)` 判子表已 JOIN ⇒ `where note='po_order_b'` 误判为已 JOIN；注释/字符串/**前缀包含**（`po_order_b` vs `po_order_bak`）全误判；且判整个 model 而非当前 scope | 用已解析 `analysis` 的 scope sources 做**精确相等**比较 |
| ~~L20~~ **误报已回滚** | `sqlPredicateContext.ts:25` | 原描述「外层 NOT 不继承」**不成立**：显式分组后插入的复合范围自带括号、整体落在 NOT 内，语义正确，放行是有意设计。详见第四节 | 保持 `negated: false`，并把理由写进代码注释 |
| ~~L21~~ **误报** | `reviewMarks.ts:22/55` | 原描述「`invalidated` 只增不减 ⇒ 后端已标记成功但角标不亮」**方向反了**：后端只比 `revision + mtime_ms + size`（毫秒精度），证明不了内容没变 ⇒ 前端黑名单是**更保守的兜底**。详见第四节 | **产品行为零改动**，只把判据写进 `invalidated` 声明处的注释（防止后人按报告建议改坏） |
| L22 ✅已修 | `SvnReview.tsx:139` | toast 用 `reqItems.length` 而实际只标 `todo.length`（`:137` 已过滤）⇒ 计数虚高（仅文案） | 改用 `todo.length`；新建 `SvnReview.markAll.test.tsx` 2 条（5 个文件里只有 1 个可标 → 只调 1 次 mark + 文案「已标记 1 个」；全已审 → 0 次 + 「0 个」） |
| L23 ✅已修 | `useTreeKeyboard.ts:82` | 只判 `isComposing`，未用真源 `lib/utils.ts:161 isImeComposing`（含 `keyCode===229`）；`useFocusTrap`/`VersionHistoryDialog` 都用了 | 改用 `isImeComposing`；新建 `useTreeKeyboard.test.tsx` 3 条回归，红灯精确命中 `keyCode:229` |

---

## 四、误报（4 条，不修）

- **`commands/update.rs:614-622`**「installed 仍删包」：`CachedPackage::install:26-35` 成功时已清 bytes + installed=true，删的是磁盘缓存，**包已装完，删缓存正是意图**。单测 `:779`/`:797` 已钉住两条语义。
- **`db_transfer_rows_cmds.rs:54-58`**「same_table 大小写不一致」：`eq_ignore_ascii_case` 是**更宽**的拒绝面，Oracle 未加引号标识符本就大小写不敏感，**方向安全**。
- **L20 `sqlPredicateContext.ts:25`**「括号内 negated 硬置 false，外层 NOT 不继承」——修复阶段识别出的误报，改动已完整回滚。
- **L21 `reviewMarks.ts:22/55`**「invalidated 只增不减，后端认定有效就该清掉」——修复阶段识别出的误报，**产品行为零改动**，只补注释。

### L20 误报详情（2026-11-16 复核并回滚）

**原描述**：`NOT (create_time <cursor>)` 仍推荐复合时间快捷，认为应改成 `negated: frame.negated` 继承外层取反。

**为什么不成立**：产品插入的复合范围**自带括号**，落在用户已显式写出的分组里，整体仍在 NOT 作用域内：

```sql
NOT (a.created)            -- 用户已显式分组
NOT (a.created BETWEEN x AND y)   -- 插入后：语义正确，应当放行
NOT a.created BETWEEN x AND y     -- 不分组直接插：破坏 NOT 作用域，必须拦
```

**两处独立既有测试钉住这条语义**（不是巧合，是有意设计）：

| 位置 | 用例名 | 断言 |
|---|---|---|
| `sqlProviders.test.ts:417-422` | 直接NOT时隐藏四种复合时间快捷，**显式分组时可以选** | `NOT a.created` → 无 `CURRENT_DATE`；`NOT (a.created)` → **有** |
| `sqlProviders.test.ts:507-519` | 业务条件不进入函数参数，直接 NOT 后不插入**未分组**的复合范围 | `NOT (a.created)` 光标在括号内 → **有** `AND a.created <` |

**发现路径**：改成继承后局部 `sqlPredicateContext.test.ts` 6 条全绿、红灯也精确命中 ⇒ 一度以为修对了。**跑全量 vitest 才冒出上述 2 条失败**。

**处置**：
1. `sqlPredicateContext.ts:25` 回滚为 `negated: false`，并写入 5 行注释说明「为什么括号一律重置」+ 指向两处测试行号；
2. `sqlPredicateContext.test.ts:19` 断言回滚为 `negated: false` 并加理由注释；
3. 本轮新增测试改名为「显式分组重置 negated，分组内的直接 NOT 仍然算取反」，4 条断言全部符合原设计（`NOT (a.created)` → false、`NOT (NOT a.created)` → true 等），**把这条设计契约固化下来，防止后人再改错**。

> 🔴 **判据落盘：既有测试是设计契约。测试红了先怀疑自己改错，别急着让测试迎合自己；局部绿 ≠ 全量绿。**

### L21 误报详情（2026-11-16 复核，产品行为零改动）

**原描述**：`invalidated` 只增不减、`resetReviewMarks` 全仓只有单测调用 ⇒ 后端已标记成功但前端 `syncReviewMarks` 把它滤掉 ⇒ 角标不亮显示「需重审」。建议「对后端认定有效的 key 清出 invalidated；换工作区调 reset」。

**为什么不成立**：后端的「有效」判据**证明不了内容没变**。

| 真源 | 判据 |
|---|---|
| `svn_review.rs:47 is_valid` | `mark.revision == revision && mark.mtime_ms == mtime_ms && mark.size == size` |
| `svn_review.rs:56 mark_ok` | `revision < 0`（版本未知）时**更宽**，只比 `mtime_ms + size` |
| `svn_cmds.rs:520-535` | `reviewed = valid_marks(&store, &revisions)`；`review_outdated` = 在 revisions 里但不在 reviewed 里 |

`mtime_ms` 是**毫秒**精度。监听已经报了改动、而改动恰好没动 mtime/size 的情形是真实存在的：

- 同一毫秒内写回（脚本/格式化器连续两次写）
- **等长替换**（改一个字符，size 不变；若文件系统时间戳粒度粗于写入间隔，mtime 也可能不变）
- 编辑器「写临时文件 → rename 回原路径」，某些实现会保留原时间戳

这些情形下后端仍判标记有效。**此时相信后端，就等于把「可能没审过的内容」标成已审**——审查标记的全部价值就是「这段我看过」，方向上宁可多问一次。前端 `invalidated` 是**比后端更保守的兜底**，不是 bug。

**既有契约测试钉的就是它**：`reviewMarks.test.ts:65-76`「文件被外部改动后需要重审，旧扫描不会恢复角标」——`h.ext[0]([path])` 触发失效后再 `syncReviewMarks(status([path]))`，仍断言 `isReviewed(path) === false`。按报告建议改，这条必红。

**其余两点也不成立**：
- 「点一次标记即恢复」原报告已承认 ⇒ 有自助路径，不是死锁；
- 「换工作区要 reset」不需要：key 是**绝对路径小写**，换工作区天然隔离，不会误伤他工程同名文件，残留只是内存只增（同一进程内数量有限）。

**处置**：产品代码**一行未改**，只在 `invalidated` 声明处写入 12 行注释——说明为什么故意只增不减、后端判据的精度上限、以及指向那条契约测试，**防止后人照着报告建议改坏**。

> 🔴 **判据落盘：「后端是真相」这句话要先问后端的判据有多强。** 当后端只比时间戳 + 大小、而前端掌握「刚刚确实被写过」的事件时，**前端更保守的那一层不是冗余，是补后端判据的精度缺口**。撤销一条保守兜底之前，先证明它保护的场景不可能发生。

## 五、待外部契约（1 条，不立案）

**`cc_journal.rs:143-146` seq 回绕**：`e.seq <= cursor.seq && cursor.seq > 0` 即跳过，cursor 持久化只增。若 cc-bridge 重启后 seq 从 1 重数，新条目会被永久丢弃。契约在 cc-bridge 仓库 `docs/开放能力-变更日志.md`，**本仓库看不到**（已确认无此文件）。需确认 cc-bridge 侧 seq 语义；若确为每次重启重置，改用 (day, offset) 或文件身份 + seq 组合去重。

## 六、打磨项（不立案，可顺手改）

- `svnList.ts:74` 精确串比去重未用 `keyOf`：当前两条上屏路径同源不会漏，但同文件已 import 却不用，属一致性隐患，**一行成本**
- `ChangeTimelinePanel.tsx:77/186` 还原本轮未接 `historyRestoreGuard`（后端 mtime CONFLICT 兜底）
- `ReqReview.tsx:53` 只用 state 做重入锁（标记幂等无实害，与 SvnReview 的 ref 模式不一致）
- `useServiceLogVirtual.ts:16-21`、`useReqBlocks.ts:103` 渲染期写 ref/模块级缓存（StrictMode 下幂等）
- `HistoryPanel.tsx:113`、`HistoryDetail.tsx:126` 内联 callback ref 重挂重设 scrollTop

---

## 七、核对通过的既有判据（正面结论）

**前端 7 条项目判据逐条到实现处核对，全部合规**：openPath 不传 preview、applyWorkspace 单一副作用、useTabSession 判 epoch 不判 root + `bytes:0`、抢号三件套（openSplit seq / savingRef / openFileRequest 队列）、EditorPane `modelGeneration` 依赖、分隔条指针捕获三件套、更新提示口径（`countUnreadVersions` 传 currentVersion）。

**Rust 侧**：`svn_status(force)` 四处调用点全 true；`svn_status_cache` 的 session/lost_at/settle 推导保守不漏；Cached 报上一轮 generated_at；`boot_timing` 起点在 main 第一行；watcher Drop 无泄漏；`workspace_edit` 事务预检/回滚/外部改动保留；桥协议 TAB 转义往返正确；7 个新文件均 ≤600 行。

**db/contexts 域**未发现可确认 bug（导入唯一入口 + sticky、`isUnsaved` 同一实现、RefactorMenuHost 异步异常已内部 catch、ConnManualForm alive+version 双守卫等）。

---

## 八、建议修复顺序

| 批次 | 范围 | 状态 |
|---|---|---|
| 1. 数据丢失三条 | M2（脏标记）、M3（跨工作区标记）、M1（前台标签） | ✅ 全部已修 |
| 2. 本次 SVNKit 升级配套 | M5（wc.db）、M4（相对路径） | ✅ 全部已修 |
| 3. 功能错误 | M6（B3 反查）、L1（q-quote 吞 SQL）、L12（Enter 回归） | ✅ 全部已修（M7 一并补 2 条回归） |
| 4. 体验/一致性 | M7、L17~L23 | ✅ M7/L17/L18/L19/L22/L23 已修；**L20、L21 判误报**（L20 回滚、L21 零改动） |
| 5. 健壮性 | L2~L11、L13~L16 | ✅ 全部已修（14 条） |

**无剩余待修**：28 条确认项全部落地，4 条误报不修，1 条待外部契约（cc-bridge seq 语义），5 项打磨不立案。

### 第五批（健壮性 14 条）验证记录

**全部红灯于 2026-11-16 实跑复核**（注入旧行为 → 跑对应测试 → 还原 → 逐字节核实无残留）：

| 条目 | 回归测试 | 注入的旧行为 | 实测红灯 |
|---|---|---|---|
| L2 | `content_pack.rs` 2 条 | `off + len <= bin_len`（裸加） | `chunk_range_check_rejects_wraparound` FAILED |
| L3 | `db_rust.rs` owner 拆分 / 引号翻倍 | `split_qualified` 直接返回整串 | `qualified_table_is_split_before_get_ddl` FAILED |
| L4 | `java_run.rs` 5 条 | `complete_prefix_len` 尾部残缺也返回全长 | `utf8_char_split_at_64k_boundary…` FAILED |
| L5 | `db_relations_cmds.rs` 截断说明 | `META_MAX_ROWS = 800` | **编译期** `error[E0080]: 7 张元数据表全列轻易过千，800 行不够` |
| L6 | `perf-baseline.test.mjs` | 去掉 `indexMs` 的 `timedOut` 兜底 | `not ok 16 索引超时…` / **fail 1 · pass 22** |
| L7 | `java_diagnostics_cmds.rs` 1 条 | jfr-stop 复用 45s | `jfr_stop_gets_a_longer_budget…` FAILED |
| L8 | `NcSvnHistoryContractTest.mergeOrderContracts` | `mergeOrder` 直接返回调度顺序 | `AssertionError: merge order must be the original ascending unit order, got [3, 0, 2, 1]`；当前源码 **33 checks 全绿** |
| L9 | `library_cmds.rs` 2 条 | `Some(_at) => true`（不退避） | `assertion failed: !should_launch(false,false,false,Some(now))` |
| L10 | `change_shelf.rs` 1 条（4 断言） | `let shelf = load(&path)?;` | `one_corrupt_copy_does_not_break_list_or_create` FAILED |
| L11 | `workspace_edit.rs` Windows 用例 | 预检去掉 `!case_only` | `case_only_rename_is_allowed_on_windows` FAILED |
| L13 | `useFileTabLifecycle.test.tsx` 5 条 + `useFileSave.test.tsx` 3 条 | 生命周期不清 encodingIssue / catch 无守卫 | **4 failed / 1 passed**（负向对照本就该绿）；catch 组 **2 failed** |
| L14 | `useFileSession.test.tsx`「库文档后退保留列号」 | `openJdt(p.path, p.line, false)` | **1 failed / 13 passed** |
| L15 | `useHistoryEditorText.test.tsx` 4 条 | opened 回调不重挂 | **1 failed / 3 passed** |
| L16 | `navQueue.test.ts` 5 条 + `useFileSession.test.tsx` 1 条 | 恢复旧 goBack/goForward | **1 failed / 13 passed** |
| L22 | `SvnReview.markAll.test.tsx` 2 条 | 改回 `reqItems.length` | **2 failed** |

> 🔴 **红灯验证本身的两个坑（第一次跑就踩了）**：
> ① **不能一次注入多条**：L5 的 `const { assert!(META_MAX_ROWS >= 5000) }` 是**编译期**断言，改小会让整个 crate 编译失败 ⇒ 同批注入的其余 6 条**全都跑不到**，屏幕上却每条都打印「exit=101」，极易误读成「全部命中」。必须**逐条注入、逐条还原**。
> ② **行尾要自适应**：`content_pack.rs` 是 CRLF，多行 old 串用 `\n` 匹配会 0 命中而被静默 SKIP。
> ③ 🔴 **`svn-history-contract.test.mjs` 默认测的是 jar 里的类，不是源码**：它的 classpath 是 `ncsvn.jar;svnkit.jar;…`，只 javac 了 `NcSvnHistoryContractTest.java` ⇒ `NcSvnBridge` 从 **jar** 加载。改 `NcSvnBridge.java` 后跑这个脚本**红灯打不出来**（第一次实测 exit=0 / pass 1，看着像「测试没抓住 bug」，其实是根本没编译到改动的类）。
> 正确做法：把 `NcSvnBridge.java` 一起 javac，并把输出目录放在 classpath **最前**；临时目录名必须以 `svn-history-contract-` 开头（`main:81` 有校验）。
> **推论：改 `NcSvnBridge.java` 必须重打包 `ncsvn.jar`，否则产品跑的还是旧类**（`MEMORY-svn.md` 已有此判据，本轮再次印证）。本轮已核实 jar 与源码判据一致（33 checks 全绿）。
> 判据同「判成败的命令绝不接管道」——**退出码非 0 不等于你要的那条测试红了，exit=0 也不等于测试真跑到了你改的代码**，必须看具体测试名与断言原文。

**门禁自身暴露的 4 类问题（一并修掉）**：

1. **体量超限**：`useFileSession.ts` 325 行 > 300（基线 275）⇒ 抽 `lib/navQueue.ts` 纯函数 + 5 条单测，回到 291 行。**「搬进 hook 只为降行数不算拆分」**，所以抽的是可脱 React 单测的纯逻辑。
2. **mock 缺导出**：L15 新依赖 `onModelLifecycle`，`HistoryPanel.test.tsx` 的 `editorStore` mock 没有它 ⇒ **只有全量 vitest 才暴露**（5 条红）。补 `onModelLifecycle: () => () => {}` 后该文件 19 条全绿。
3. **clippy 3 处**：`int_plus_one`（`java_run.rs` 测试里 `64*1024-1+1`）、`useless_conversion`（`META_MAX_ROWS.to_string().into()`）、`assertions_on_constants`（改 `const { assert!(..) }`）。
4. **`cargo fmt --check` 2 处**：测试断言换行，`cargo fmt` 应用后复核 exit 0。

**本轮踩到的测试坑（都不是产品 bug，但会骗人）**：

- 🔴 **后端 `invoke` 拒绝的是字符串不是 `Error`**：`isConflictError = String(e).startsWith("CONFLICT")`。测试用 `new Error("CONFLICT:…")` 会得到 `"Error: CONFLICT:…"` ⇒ 分类失效，**红灯打不出来、负向对照先红**。改用字符串拒绝（与真实 invoke 一致）后精确命中。
- 🔴 **`mockReturnValue` 优先级高于 `mockRejectedValue`**：前两个用例留下的 pending promise 会污染第三个 ⇒ 统一 `mockImplementation`。
- 🔴 **`recordFileJump` 会连「跳转前的光标」一起记**：光标与上一个点重合才去重。测试不设 `setCursor` 会在栈里多出几个原点，**断言的格数算错**——我一度以为是队列没生效，探针证明队列正常后才发现是期望写错。
- 🔴 **相对量必须在出队时求值**：`navLook` 只看游标不动游标，连点两次拿到同一目标 ⇒ 必须队列 + 出队时才 `navLook`。
- 🔴 **绝对下标与相对量必须用判别式分开**：第一版 `navGo(delta: -1|1|number)` 把 `goToHistory(1)` 当成「前进一格」，既有测试立刻红。
- **vitest `test.include` 只扫 `src/**`**：临时探针放 `desktop/` 根目录会「No test files found」；新建 tsx 测试首行必须 `// @vitest-environment jsdom`。
- **python 写模板字符串会把 `\w` 转义吃掉**（`C:\w\A.java` → `C:wA.java`）⇒ 路径改用正斜杠拼接（`keyOf` 会归一化）。

> 约束提醒：SVNKit 1.10.11 升级的 11 个文件改动**仍未提交、未推送、未发布上传**（未获授权）。本报告不触碰这些状态。