# NCForge 数据库工作台 UI / UX / 稳定性审查

- 审查日期：2026-11-10
- 代码基线：`HEAD fd03438`（工作区未改动）
- 范围：`desktop/src/components/db/**`、`components/tabs/{DbTab,TablePage}.tsx`、`hooks/use{ResultSetEdit,TableSave,TableEdits,RowDrafts,Grid*}.ts`、`lib/db*.ts`、`lib/operations.ts`、`src-tauri/src/{db_rust.rs,db_engine.rs,commands/db_cmds.rs}`
- 方法：逐文件静态核对 + 调用链交叉验证。**未做运行时复现、未改任何代码**；只有明确标注「待运行验证」的条目需要真机确认，其余均为源码可直接判定的行为。
- 结论：编辑相关功能存在 5 个 S1（会静默丢改动、写坏数据或写错 schema），不建议带着这些项发下一个版本；流程一致性与性能问题可以在 S1 之后按批次清理。

## 分级口径

| 级别 | 含义 |
|---|---|
| S1 | 数据安全 / 正确性：静默丢失未保存修改、写入截断或错误数据、串 schema、整页崩溃 |
| S2 | 流程一致性：正常操作必然失败、状态显示与真实状态不符、按钮静默无反应 |
| S3 | UX / 设计：可恢复的困惑、状态不持久、提示缺失、无障碍 |
| S4 | 性能与持续查询：长任务卡顿、重复请求、渲染放大、轮询成本 |

---

## S1 数据安全与正确性

### S1-1 结果网格滚动到底自动续取，会静默清空未写回的编辑和新增草稿

- 证据
  - `desktop/src/hooks/useResultSetEdit.ts:49-54`：只要 `rows` 引用变化，就 `setChanged(new Map())`、`setApplied(new Map())`、`resetDrafts()`。
  - `desktop/src/components/db/ResultGrid.tsx:121-123`：滚动到距底部 `LOAD_MORE_MARGIN` 内且 `hasMore` 时自动调用 `onLoadMore()`。
  - `desktop/src/components/db/RowsEntryView.tsx:82` 把 `hasMore` 传给网格；`desktop/src/lib/dbStore.ts:1041-1052` 续取成功后 `appendResultRows` 产生新的 `rows` 数组。
- 触发：在可编辑的单表查询结果里改了几格（或「复制此行」加了草稿行），往下滚查看后面的行。没有点任何「丢弃」确认，改动/草稿就没了。
- 影响：这是最容易被日常操作触发的静默丢改动；用户会以为数据已经改好，实际连待写回标记都没了。
- 根因：续取是**纯追加**（旧行下标不变），但 reset 逻辑把「追加」和「换了一条 SQL / 重新执行」当成同一类。
- 修复方向
  1. 在 reset effect 里区分追加与替换：若新 `rows` 的前 `oldRows.length` 行逐引用相等（或 `rows.length >= 旧长度` 且前缀一致），保留 `changed` / `applied` / 草稿。
  2. `loadMore` 入口再加一道保险：`changed.size > 0 || drafts.pending > 0` 时，自动续取前给一次非阻塞提示或直接跳过自动续取，把「加载下 N 行」留给用户点。
  3. 加回归测试：改一格 + 加一条草稿 → 追加行 → `count` 仍为 2，写回 SQL 仍针对原行号。

### S1-2 「复制此行（新增）」会把 8K CLOB 预览连同尾部说明当成数据插入

- 证据
  - `desktop/src/hooks/useTableEdits.ts:64-70`：克隆行时把非空单元格原样放进草稿，包括 CLOB 预览字符串。
  - `desktop/src/hooks/useResultSetEdit.ts:138-145`：结果页的「复制这一行（新增）」同样只排除主键和 null。
  - `desktop/src/lib/dbOptimisticEdit.ts:57-69`：`insertChange` 对值直接 `bindRowValue`，CLOB 拼成 `to_clob(:n)`，**没有** `isLobPreview` 守卫。
  - 对比：UPDATE 路径在 `dbOptimisticEdit.ts:25-40` 明确拒绝预览值，说明预览不可写是既定契约，INSERT 路径漏了。
- 触发：查询含 >8K CLOB 的行 → 右键「复制此行」→ 写回；或把预览单元格复制后粘到新增行的 CLOB 列。
- 影响：新行 CLOB = 前 8192 字符 + `…（共 N 个字符，只显示前 8192…）` 的说明文字。数据被静默截断且混入中文说明，比报错更糟。
- 修复方向
  1. `insertChange` 对 `isLobPreview(after)` 直接拒绝，文案与 UPDATE 一致：「网格里只有前 8K，请用 SQL 新增」。
  2. 「复制此行」遇到预览 CLOB 不复制该列（留空），并在提示里说明为什么。
  3. 粘贴入口保留：用户自己粘进来的长文本不是预览标记，允许写入。
  4. 补测试：克隆含预览 CLOB 的行后，草稿里该列不存在 / 写回被拒。

### S1-3 表页编辑预览 CLOB：渲染期抛错，整个数据库页被错误边界替换

- 证据
  - `desktop/src/components/db/TableData.tsx:168-174` 在 **render 期间**直接 `planWriteBack([...])`，没有 try/catch。
  - `desktop/src/components/db/TableData.tsx:224-228` 的 `canEdit` 白名单包含 `CLOB`；`desktop/src/lib/sqlEditable.ts:79-82` 同样包含。
  - `desktop/src/lib/dbOptimisticEdit.ts:33-38` 一旦改动的原值是预览串就 `throw`。
  - `desktop/src/App.tsx:387` 每个工具页一个 `ErrorBoundary`。
- 触发：表页数据里某行 CLOB 超过 8K，双击该格改成任意文字（或 Shift+Enter 大文本编辑后提交）。
- 影响：React 渲染抛错 → 整个数据库工具页变成错误页；该页所有未写回编辑、筛选、页码、滚动位置一起丢失。
  - 同类问题在 SQL 结果页的表现不同：`useResultSetEdit.ts:189-195` 的 `count` 把异常 catch 成 0，于是**「写回」按钮直接消失**；如果有别的待写回修改，也会一起消失，用户只剩「撤销改动」。
- 修复方向
  1. 表页的 `planWriteBack` 用 `useMemo` + try/catch 包住，产出 `{plan, error}`，错误在状态条显示，不让异常穿过 render。
  2. `canEdit` 对 `isLobPreview(value)` 返回 false（或用统一 `editableCellType` 并排除预览），从入口避免用户改到不可写值。
  3. 结果页的 `count` 不要吞掉异常归零：单独暴露 `planError`，让工具条显示「有大文本改动无法写回」并给「定位该格」入口。
  4. 补组件测试：编辑预览 CLOB 后页面不崩、错误可见、其他改动仍能写回。

### S1-4 切换默认 schema 后，已打开的表页 / 结果集写回可能落到另一个 schema 的同名表

- 证据
  - `desktop/src/lib/dbStore.ts:586-595` 的 `changeSchema` 只 `forgetColumns` + `setRt` + `loadMeta`，**不关闭/不刷新已打开的表页**，也不拦截未写回编辑。
  - `desktop/src/lib/dbStore.ts:656-668` 的表页身份只有 `connId + table + otype`，**没有 schema**；切 schema 后再点同名表只会激活旧页。
  - `desktop/src/components/db/TableData.tsx:88-104` 的查询用 `pageSql(tab.table, ...)`，表名不带 schema；`TableData.tsx:168-174` 的写回同样用 `tab.table`。
  - `desktop/src/hooks/useResultSetEdit.ts:153-172` 的结果集写回也用 `source.table`（从不带 schema 的 SQL 文本推断）。
- 触发（NC 多账号 schema 下很常见，两个 schema 有同名同构表）：
  1. 打开 `A.IC_GENERAL_H` 表页，改两格；
  2. 顶部 schema 胶囊切到 `B`；
  3. 点「写回」——UPDATE 用未限定表名，在 B schema 里按同样的主键值命中 B 表的行。
  或切 schema 后点「下一页」，表格内容无缝变成 B schema 同名表的数据，用户没有任何提示。
- 影响：跨 schema 看到/改到别人的数据，属于最高危的数据正确性问题；而现有 UI 从视觉上看不出切换后旧页语义已经变了。
- 修复方向
  1. `TableTab` 增加 `schema`（打开时从 `rt.currentSchema` 固化），`pageSql` / 写回 / 结构读取全部用 `schema.table` 限定；`openTableTab` 的身份也带上 schema。
  2. 结果集写回用执行时捕获的 `context.schema` 限定表名，而不是事后当前 schema。
  3. `changeSchema` 在切换前检查：存在未写回编辑 / 已打开的表页时，明确提示「旧表页将按新 schema 重新打开」并关闭或重载它们；未提交事务已有后端拦截，前端要给出同等级提示。
  4. 补测试：schema 进入 SQL 文本；同名表在两个 schema 下能同时打开；切 schema 后旧页不静默写回。

### S1-5 先改后删会生成「幽灵 UPDATE」；自动提交模式下形成部分写入

- 证据
  - `desktop/src/hooks/useRowDrafts.ts:36-40`：`removeRow` 只把行号放进 `deleted`，**不清该行的 `changed`**；`restoreRow` 也不处理 `changed`。
  - `desktop/src/components/db/TableData.tsx:168-174` 同时把 deleted 和 optimisticChanges 交给 `planWriteBack`。
  - `desktop/src/lib/dbOptimisticEdit.ts:98-102` 排序为 delete(0) → update(1) → insert(2)，同一行会先 DELETE 再 UPDATE。
  - `desktop/src/hooks/useTableSave.ts:66-90` 逐条执行，UPDATE 0 行即抛错；`useTableSave.ts:100-112` 在自动提交模式下明确「前 N 条已自动提交，无法整体回滚」。
- 触发：改一行 → 再删除这行 → 写回。
- 影响
  - 手动提交：DELETE 先执行、UPDATE 未命中 → 整批停在冲突态，用户看到「记录已变化或被删除」；DELETE 还在未提交事务里，需要自己回滚。
  - 自动提交：DELETE 已经落库，UPDATE 失败 → 用户看到失败，但那一行实际已经被删掉；后续操作基于错误认知。
- 修复方向
  1. `planWriteBack` 统一去重：有 delete 的行不再生成 update（在排序后过滤），这样「改后删」只删；「删后恢复」时 `changed` 仍在，恢复为正常修改，语义正确。
  2. 或在 `removeRow` 时暂存并移出 `changed`，`restoreRow` 时放回；两种实现二选一，推荐前者（不依赖用户操作顺序）。
  3. 自动提交批量写回失败后，强制 `load()` 并从 `applied` 里移除失败批次，避免屏上状态与库不一致（和 S2-9 一起做）。
  4. 补测试：改 + 删同一行 → 计划里只有 DELETE；自动提交失败后网格回到库里的真实行。

---

## S2 流程一致性与静默失败

### S2-1 切子页 / 切文档 / 切结果标签 / 关标签 / 释放结果，都会静默丢弃未写回编辑

- 证据
  - `desktop/src/components/db/TablePage.tsx:79` 子页按钮直接 `patchTab({sub})`，没有 `confirmDiscard`；`TablePage.tsx:125-129` 在非 data 子页卸载 `TableData`，其 `changed` / 草稿都是组件本地 state。
  - `desktop/src/components/tabs/DbTab.tsx:35-39, 76-80`：整个数据库页只保留一个 `retained` 文档宿主，切换文档即卸载上一个 `SqlConsole` / `TablePage`。
  - `desktop/src/components/db/ResultPanel.tsx:59` `key={cur.id}`：切换结果标签会卸载 `RowsEntryView`，其中的编辑与本地筛选一起消失。
  - `desktop/src/components/db/ResultPanel.tsx:43`「释放查询结果」直接 `patchTab({results:[]})`，不检查未写回编辑。
  - `desktop/src/lib/dbActions.ts:103-126` `requestCloseTab` 只 `guardRunning` / `guardTx` / `guardSlotTx`，不知道网格里有未写回改动。
  - 切连接的路径在清结果前只问事务（`dbActions.ts` 98-101），同样不问编辑。
- 触发：改几格 → 去「结构」页看一眼 → 回来；或关标签；或点结果区的 ×。
- 影响：所有未写回改动静默消失，且关闭提示里的「撤销」只能找回文档，找不回本地编辑。
- 修复方向
  1. 建立一个最小的「脏编辑登记」：`RowsEntryView` / `TableData` 通过 context 或 store 上报 `pendingCount`，`DbDocTabs`、结果标签、子页切换、关闭、释放统一查询。
  2. 至少给 SQL 结果标签和文档标签加圆点标记；关闭时若有 pending，用 `ask()` 明确「有 N 处未写回改动」。
  3. 「释放查询结果」是低频动作，建议强制确认（有编辑时）。
  4. 如果只做一处：先修关闭标签与「释放结果」，这两个入口最像「用户以为只是清理视图」。

### S2-2 冷连接下「运行提取的 SQL」第一次必然不执行

- 证据
  - `desktop/src/components/db/ExtractSqlDialog.tsx:48-51`：`const tabId = await newConsole(connId, sql); ... void runStatements(...)`。
  - `desktop/src/lib/dbActions.ts:46-50`：`newConsole` 里 `void ensureConnected(connId)`，没有 await，但 `connect` 会同步把状态置为 `connecting`。
  - `desktop/src/lib/dbConfirm.ts:302-307`：`status === "connecting"` 时直接 toast「正在连接，稍等一下再执行」并返回 false。
  - `desktop/src/lib/dbActions.ts:277`：`runStatements` 自己又 `await ensureConnected`，于是撞上上一行刚触发的 connecting。
- 触发：应用启动后（或断开后）第一次从编辑器「提取 SQL」并直接运行/看执行计划。
- 影响：用户看到「正在连接」提示，语句一条没跑；执行计划同样走 `explain` 的 `ensureConnected`（`dbActions.ts:354-359`），同样失败。再点一次通常就好了，但第一次体验是「按钮没用」。
- 修复方向：`ExtractSqlDialog` 先 `await ensureConnected(connId)`，成功后再 `newConsole`；`newConsole` 去掉/收敛内部的 fire-and-forget connect，避免双重连接状态。补一条「冷连接运行提取 SQL」的交互测试。

### S2-3 纯 Rust 引擎下点「停止」被显示为执行失败

- 证据
  - `desktop/src-tauri/src/db_rust.rs:148-153`：取消与调用超时都映射为 `code = "timeout"`，文案是「语句已中断（点了停止，或等待超过超时时间）」。
  - `desktop/src-tauri/src/commands/db_cmds.rs:1166-1189` 的注释也写明「两条路都表现为原来那个请求返回一次错误，前端照常显示为一次失败的执行」。
  - `desktop/src/lib/dbOperations.ts:11`：`dbCancelled` 只匹配 `ORA-01013` 或 `cancel(led)`，不匹配 `timeout`。
  - `desktop/src/lib/dbActions.ts:249-349`：只有 `r.cancelled` 才把 `stoppedByUser` 置真，否则走失败分支。
- 触发：Rust 连接上跑长查询 → 点停止。
- 影响：JVM 桥显示「已停止」，Rust 引擎显示红色失败并计入失败结果；同样的按钮两种语义，用户无法判断是「我停了」还是「出错了」。
- 修复方向：`RustEngine::cancel` 设中断标志；`CallTimeoutExceeded` 时若中断标志为真，返回独立 `code = "cancelled"`（`dbCancelled` 已能匹配），超时才保留 `timeout`。补 Rust 单测与前端分类测试。

### S2-4 执行计划运行中，停止按钮取消的是另一个会话

- 证据
  - `desktop/src/components/db/SqlConsole.tsx:84-89`：`onStop` 只找 `db.sql:${tab.id}` 任务，找不到就 `dbApi.cancel(tab.connId, tab.slot)`。
  - `desktop/src/lib/dbStore.ts:1061-1071`：`explainInto` 用 `explain:${tabId}` 任务、直接在 **primary** 上 `dbApi.explain(connId, sql)`；没有 slot。
- 触发：点「执行计划」后，查询在 primary 上跑；用户点停止。
- 影响：如果该标签有独立槽，取消的是空闲槽；primary 上的 explain 继续跑。如果没有槽（或槽已满回退），取消的是 primary 上别的语句（可能是表页查询或另一个标签）。请求不返回，用户只能等。
- 修复方向：`explain` 走与执行一致的会话归属（带 slot），任务键统一为 `db.explain:${tabId}` 并支持 `cancel`；`onStop` 先找执行任务，再找执行计划任务，最后才回退到 `dbApi.cancel`。

### S2-5 「加载下 N 行」在游标被别人占用时静默无反应

- 证据
  - `desktop/src/lib/dbStore.ts:1031`：`... || !ownsCursor(tab.connId, tab.slot, resultId)) return;`，没有任何 UI 反馈。
  - `desktop/src/lib/dbStore.ts:891-896`：游标按 `connId#slot` 只记一个 owner；表页用 `claimCursor(connId, null, tab.id)`（`TableData.tsx:94`），超过 3 个 SQL 标签时第 4 个也回退到 primary。
  - `desktop/src/components/db/RowsEntryView.tsx:105-114` 仍显示按钮，只按 `hasMore`/`moreError` 判断。
- 触发：两个主会话使用者（表页 + 回退的 SQL 标签，或两个回退标签）先后执行；回到先前结果点「加载下 N 行」。
- 影响：按钮点了完全没反应，也没有「游标已失效」提示（`isLast` 只在重渲染时才会更新）。
- 修复方向：`loadMore` 返回结果/原因；非 owner 时写 `moreError = "游标已被其他查询占用，请重新执行"` 且 `moreRetryable = false`，或直接 toast。更彻底的是把表页也放进独立槽，从根上减少主会话争用（见 S4-3）。

### S2-6 Rust 引擎续取失败后游标已关闭，前端仍提供「重试加载」，形成永久失败按钮

- 证据
  - `desktop/src-tauri/src/db_rust.rs:909-958`：`self.cursor.take()` 后任何非 desync 错误直接返回，游标在作用域结束时关闭；注释明确「用户再点加载更多会收到游标已关闭」。
  - `desktop/src/lib/dbStore.ts:1054-1056`：只有 `session-lost` / `slot-gone` 视为不可重试，其他错误 `moreRetryable = !expired`，包括「游标已关闭」的 `sql` 错误。
- 触发：加载更多超时 / 网络抖动 / 服务端错误一次。
- 影响：按钮变成「重试加载」，每次点都返回「没有可以继续读取的结果」，直到用户重新执行查询；但界面一直暗示可以重试。
- 修复方向：Rust 对「游标已关闭」返回独立 code（如 `cursor-closed`），前端把它加入不可重试集合；或 `moreError` 文案里出现该语义时不显示重试。补 Rust 与前端各一条测试。

### S2-7 只读探测失败被吞掉，连接永久停在「待验证」，开关也点不了

- 证据
  - `desktop/src/lib/dbReadOnly.ts:5-13`：`dbApi.readOnly(id).then(..., () => {})`；失败时 `enabled` 保持 `null`，且只在 `[id,status]` 变化时重试。
  - `desktop/src/components/db/DbContextBar.tsx:34`：`readOnly === null` 时按钮禁用。
  - `desktop/src/hooks/useResultSetEdit.ts:84`：`usable` 要求 `readonly === false`；`blocked` 推导在 reason 为空时得到空串。
- 触发：连接建立后探测只读状态的那次请求失败（会话忙、字典临时锁、网络抖动）。
- 影响：所有网格编辑被禁用，连接条显示「只读：待验证」，无法切换，也没有重试入口；结果页可能只显示「只读 · 」后面没有原因。
- 修复方向：`useDbReadOnly` 暴露 `{value, error, retry}`；失败时显示「无法确认只读状态 · 重试」，允许重试探测（探测本身不修改数据）；`blocked` 文案补「只读状态未确认」。

### S2-8 空白的新增行会阻塞整批写回

- 证据
  - `desktop/src/hooks/useTableSave.ts:50-51`：对所有草稿行跑 `missingRequired(...)`，没有过滤空草稿。
  - `desktop/src/lib/tableRows.ts:36-48`：`values` 为空时 `filled` 为空集合，所有「非空且无默认值」的列都会被报成必填。
  - `desktop/src/components/db/TableData.tsx:240-252`：只要 `drafts.drafts` 里有任意空行，`added` 计数为 0，但保存校验仍会命中它。
- 触发：点「+ 新增行」后又不想加这条，直接去写回别的修改。
- 影响：提示「新增行还有必填列没填：A、B、C…」，用户找不到是哪一行（空行没有明显标记），只能点「撤销改动」把所有修改一起清掉。
- 修复方向：校验前过滤 `d.values.size > 0` 的草稿（与 `insertChange` 的口径一致）；完全空的行视为「未使用模板行」，不计数、不拦截。补单测。

### S2-9 回滚 / 部分失败后网格不刷新，屏上是「未提交」或「已删」的假象

- 证据
  - `desktop/src/components/db/TxBar.tsx:44-76`：commit/rollback 只调 `txAction` + `setTxNotice`，不通知表页/结果页刷新。
  - `desktop/src/hooks/useTableSave.ts:100-112`：失败分支不 `load()`；成功分支才 reload。
  - `desktop/src/hooks/useTableSave.ts:66-90`：自动提交模式下前面的 DELETE 已落库，后面的 UPDATE 失败时，已成功的删除通过 `restoreRow` 从待写回集合移除，但 `page.rows` 里那行还在——屏上重新变成一条普通行。
  - `desktop/src/components/db/TableData.tsx:181-188`：`onCommitted` 改了 `data.rows`，失败/回滚后用 `applied` 覆盖的值仍留在屏上。
- 触发：表页写回部分失败后回滚；或手工 SQL 写入后回滚；或在表页写回成功但尚未提交时点回滚。
- 影响：用户会基于屏幕判断「已经改好/已经删掉」，重复写、漏写或误以为回滚失败。
- 修复方向
  1. 事务条动作成功后广播一个 `txEpoch`（按连接+槽），`TableData` 订阅后自动重载当前页（有 pending 时先询问）。
  2. 结果网格显示「事务已回滚，结果可能过期 · 重新执行」提示条。
  3. 自动提交批量失败后强制 reload，并保留冲突面板。
  4. 回滚时清掉 `applied`。

### S2-10 连接配置「测试」与「保存」共用操作键，点保存会静默无反应

- 证据
  - `desktop/src/components/db/ConnManualForm.tsx:85, 102`：两处都用 `connection.form:${conn?.id || "new"}`。
  - 两处都有 `if (!task) return;`，且共享同一个 `lock` ref；测试进行中点保存直接返回。
- 触发：点「测试连接」后不等结果就点「保存」；或反过来。
- 影响：按钮看起来可用，点了什么都不发生（保存也不会排队/提示）。
- 修复方向：拆成 `connection.test:${id}` 与 `connection.save:${id}`；共享锁时给「正在测试，请稍候」提示；或测试期间禁用保存按钮并在标题说明。

---

## S3 UX 与设计缺陷

### S3-1 表页没有「加载完整值」，但结果页有；多结果集的完整值口径也可疑

- 证据：`desktop/src/components/db/TableData.tsx:210-233` 的 `ResultTable` 没有传 `lob`；而 `RowsEntryView.tsx:60-64` 传了。`CellDetail.tsx:131` 对预览只提示「按原 SQL 重查这一行」。
- 影响：NC 用户主要在表页浏览数据，>8K 的 CLOB 永远只能看到前 8K；同一份数据在 SQL 结果页却能加载完整值，行为不一致。
- 待运行验证：`RowsEntryView` 对多结果集也传了整段 `entry.sql`，而 `lobValue` 用 `row_index` + 列名重跑 SQL；多结果集时行号来自子结果集，重跑后的第一个结果集行号不对，可能加载到错误行或报错。建议运行确认。
- 修复方向：表页把 `page.sql` 与页内行号偏移接入 LOB 加载；多结果集时禁用「加载完整值」或按子结果集 SQL 加载。

### S3-2 拖列宽会清空选区；拖一次所有列都变成手动宽度

- 证据：`desktop/src/components/db/ResultTable.tsx:90` 的 `setColumns` 无条件 `setSelection(null)`；`:247` 的 `onWidths` 把每一列的当前宽度写进 `layout.widths`；`:95` 单列自适应也走同一个入口。`:164-170` 的解码开关特意绕开 `setColumns` 以保选区，但 `:193` 的「自动换行」又走了 `setColumns`，同一个工具栏里两套口径。
- 影响：用户选中一片区域准备复制/置 NULL，顺手调一下列宽或点「自动换行」，选区没了；之后窗口变宽也不再自动分配，只能点「自适应列宽（全部）」。
- 修复方向：宽度变化不重置选区（只在列可见性/顺序/冻结变化时清）；`onWidths` 只提交被拖的那一列，保留其余列的自动宽度。

### S3-3 表页的页码 / 临时筛选 / 排序不持久，切走再回来回到第 1 页

- 证据：`desktop/src/components/db/TableData.tsx:60` 读 `tab.query`，但 `desktop/src/lib/dbTabPersistence.ts:9` 明确把 `query` 从持久化里剥掉，而且全仓没有写入 `tab.query` 的地方（死字段）。
- 影响：切到「结构」页再回来、切到别的文档再回来、重启应用，页码和未保存的筛选都丢；`saveFilter` 只能保存「常用筛选」，日常临时条件不会保留。
- 修复方向：把 `{where, order, params, page}` 写回 `TableTab.query`（或按连接+表记到本地 session 存储），在 `TableData` 初始化时恢复；或至少持久化页码与「上次条件」。

### S3-4 连接树筛选会保留所有已连接连接，并自动展开；加载失败只显示一行小字

- 证据：`desktop/src/components/db/ConnTree.tsx:86-87`：只要 `rt.status === "connected"` 就不过滤；`:157` 有筛选词时自动展开所有已连接连接；`:139` 的 `loadError` 只有一条 `.dbx-tree-note`。
- 影响：多连接环境下搜一个表名，所有已连接连接都被展开，结果被大量无关节点淹没；连接配置加载失败时，空态仍显示「还没有数据库连接」（`DbTab.tsx:83-91` 只看 `conns.length`），用户会去重建连接而不是重试加载。
- 修复方向：连接行只在「自身命中」或「有命中子对象」时显示；空态区分 `loadError` 并给「重试」；`loadError` 提升到树顶部可操作提示。

### S3-5 「最近关闭」会一口气吞掉最多 10 条；SQL 标签会重名

- 证据：`desktop/src/lib/dbStore.ts:793-806` 循环 10 次 `takeClosed`，每次 `restoreFrom` 失败就继续；`takeClosed` 是消费式，失败条目不会回到栈里。`:637-642` 用「当前 SQL 标签数量 + 1」命名，关闭中间一个标签后新建会与已有名字重复。
- 影响：连接被删除后的失效条目会让「恢复最近关闭」一次丢掉多条还能恢复的记录；多标签时出现两个「SQL 2」，用户无法靠名字区分。
- 修复方向：失败条目放回「不可恢复」列表或只跳过不消费；标签序号用「最小未使用编号」或持久递增计数器。

### S3-6 「复制原始值」复制的是带说明的 8K 预览，不是原始值

- 证据：`desktop/src/components/db/ResultTable.tsx:119` 走 `quickCopyTransfer(frozen, "tsv", true)`；`desktop/src/lib/resultTransferClipboard.ts:46` 的 `raw` 分支直接 `String(...)`，没有 `isLobPreview` 处理，toast 仍写「原始值」。
- 影响：用户把 CLOB 粘到别的系统，得到的是一段带「共 N 个字符」说明的截断文本，且以为拿的是全量。
- 修复方向：`raw` 遇到预览时提示「这是 8K 预览」并改为先加载完整值（有 `lobValue` 通道）或明确拒绝；`复制唯一值 / IN 条件` 同样跳过预览值并提示。

### S3-7 导入结果只报前 3 条跳过原因；同一个文件重选没有反应

- 证据：`desktop/src/components/db/ConnOtherToolsPane.tsx:110-115` 成功 toast 只统计新增数量，错误行 `skipped.slice(0, 3)`；`desktop/src/components/db/PropsFileImportPane.tsx:54` 的文件 input 没有清空 `value`。
- 影响：导入 20 条只成功 12 条时，用户只看到前 3 条失败原因；文件解析失败后再选同一个文件，浏览器不触发 `change`，看起来像按钮坏了。
- 修复方向：成功提示带上「跳过 N 条」并可展开；`onChange` 处理完后 `e.target.value = ""`（或 `finally` 里重置）。

### S3-8 标签上没有「有未写回改动」的标记

- 证据：`desktop/src/components/db/DbDocTabs.tsx` 标签渲染没有 dirty 状态；`ResultPanel.tsx` 结果标签也没有。
- 影响：用户切换/关闭时无法预判会丢东西；结合 S2-1 形成「事后才发现」的体验。
- 修复方向：与 S2-1 的脏编辑登记一起做，标签显示小圆点，`title` 写明「N 处未写回」。

### S3-9 结果标签切换会丢掉本地筛选、排序、滚动和单元格选择

- 证据：`desktop/src/components/db/ResultPanel.tsx:59` `key={cur.id}` 强制重挂载；`RowsEntryView.tsx:60` 的列元数据请求也在每次挂载时重发（`useResultSetEdit.ts:61` 直接调 `dbApi.columns`，绕过了 `columnsOf` 缓存）。
- 影响：在结果 A 里筛到想看的数据，切到结果 B 再切回来，筛选和滚动位置全没了，还多一次 `columns` 往返。
- 修复方向：结果视图按 `resultId` 保活（或把筛选/排序/滚动存到结果条目上）；列信息改用 `columnsOf` 缓存。

### S3-10 无障碍与键盘细节

- `desktop/src/components/db/DbDocTabs.tsx:146` 给所有标签都设了 `aria-controls={dbPanelId(t.id)}`，但只有激活文档的面板真的挂载，其余 id 不存在。
- `desktop/src/components/db/ResultGrid.tsx:207-220` 的可打印字符分支没有 `e.nativeEvent.isComposing` 判断（对象查找、筛选框都有），中文输入法下首个字符可能被当成「直接进入编辑」。
- `desktop/src/hooks/useGridEditing.ts:26, 53, 65`：Esc 置 `cancelRef = true`，只有下一次 `commit()` 才消费；如果 Esc 后 blur 没有触发，下一次 Enter 会被吞掉（待运行验证）。
- 修复方向：`aria-controls` 只给激活标签；键盘分支补 composition 判断；Esc 时同时安排一次微任务/`onBlur` 复位。

---

## S4 性能与持续查询

### S4-1 `useOperations()` 全量订阅 + 125ms 进度更新，会放大成整块网格重渲染

- 证据：`desktop/src/lib/operations.ts:16-24` 每次 `patch` 都 `notify` 并返回新数组；`ResultPanel.tsx:18`、`TableData.tsx:55`、`SqlToolbar.tsx:43` 都订阅整个数组。任务进度按 125ms 节流更新。
- 影响：任意一个后台任务（例如另一个标签的执行/加载更多）每 125ms 让当前表页/结果面板重渲染一次；`ResultTable`/`ResultGrid` 没有做父级 memo，500×30 的网格会跟着重算。
- 修复方向：提供按键选择器（`useOperation(key)` / `useOperationActive(key)`），只让真正关心该任务的叶子组件订阅；把执行进度显示拆成独立兄弟组件，避免带着网格一起重渲染；完成态列表与进度态分开通知。

### S4-2 换行模式下拖列宽，每个 pointermove 重算全部行高

- 证据：`desktop/src/components/db/ResultGrid.tsx:162` 每次移动 `setWidths`；`desktop/src/hooks/useGridRowLayout.ts:20-26` 以 `widths` 为依赖调用 `rowHeights`；`desktop/src/lib/gridRowMetrics.ts:74-93` 对每行每列做字符级换行计数（CLOB 预览可达 8K 字符）。
- 影响：500 行 × 20 列、开启换行时，拖动列宽会卡顿，CLOB 列尤其明显。
- 修复方向：拖动期间用 `rowH` 近似高度，`pointerup` 后再精确重算；把行高计算放进 worker（和 `useResultOrder` 一致）；对超长文本只测前 N 字符（已有 `MAX_WRAP_LINES`，但字符循环仍然发生）。

### S4-3 所有表页共用 primary、固定 60s、不可取消

- 证据：`desktop/src/components/db/TableData.tsx:94` 每次翻页 `claimCursor(tab.connId, null, tab.id)`；`:104` `execBound(..., 60)`；`beginOperation` 的 spec 没传 `cancel`。
- 影响
  - 两个表页不能并行查询，翻页会互相顶掉游标；
  - 表页查询与回退到 primary 的 SQL 标签、执行计划共享会话，长查询会互相排队；
  - 超过 60s 直接中断且没有设置项；用户唯一出路是去会话面板杀会话（如果权限够）。
- 修复方向：表页也走独立会话槽（读取可用只读槽/自己申请一条），或至少与 SQL 的 primary 回退隔离；表页查询接入可取消任务；60s 改为可配置并显示在页脚。

### S4-4 默认 30s 超时对报表查询偏短，且与「停止」共用同一错误表现

- 证据：`desktop/src/lib/dbStore.ts:224-225` `DEFAULT_MAX_ROWS = 500`、`DEFAULT_TIMEOUT = 30`；单标签可在 `QuerySettings.tsx:108` 调，但新建标签默认 30s；Rust 超时与取消共用 `timeout` code（`db_rust.rs:150-153`）。
- 影响：NC 上常见的多表关联/月结查询很容易超过 30s，默认体验是「第一次跑必然失败」，用户得先学会改设置；失败提示又分不清是超时还是自己点了停止。
- 修复方向：评估把默认值提到 60–120s（或按连接配置）；执行条显示已用时与「停止」，超时文案明确写「等待超过 N 秒」而不是「点了停止，或…」；超时后保留已取到的行（如果后端能返回部分结果）。

### S4-5 每条语句同步写一次全量执行历史到 localStorage

- 证据：`desktop/src/lib/dbStore.ts:1023` 每条执行都 `addHistory`；`desktop/src/lib/dbHistory.ts:50-62` 每次构造新映射并 `JSON.stringify` 最多 500 条 SQL 后同步 `setItem`。
- 影响：几百条 INSERT 的回放脚本会在主线程上做几百次全量序列化；存储接近配额时更慢。隐私模式下异常被吞，但性能成本仍在。
- 修复方向：按批次/节流写入（例如脚本结束后一次写，或 200–500ms 合并）；历史列表只保留截断后的 SQL 预览（如 2KB）并在需要时懒加载全文；或改存 IndexedDB。

### S4-6 对象查找每次按键都对全量对象做拼音打分和排序

- 证据：`desktop/src/components/db/DbObjectFinder.tsx:34-35`：`names.map(...matchText...).filter(...).sort(...).slice(0,80)` 直接在 render 里算，没有 `useMemo`，也没有预计算搜索键。
- 影响：几千个对象（NC 大 schema）下，输入每个字符都会卡一下；`matchText` 还要同时处理表名和中文名。
- 修复方向：`useMemo` 依赖 `[names, query, recent]`；加载对象时预计算 `searchKey`（表名+中文名+拼音首字母）；只对前 N 个候选做完整打分，或使用增量索引。

### S4-7 会话与锁抽屉每 5 秒轮询，切走页面也不停

- 证据：`desktop/src/components/db/SessionDrawer.tsx:12` `REFRESH_MS = 5000`；`:55-66` 只在窗口隐藏（`useAppHidden`）时停；抽屉是 store 级状态，切到别的工具页仍然打开并轮询。
- 影响：共用库上长期开着会话面板会持续查 `v$session` / `v$locked_object`；对 DBA 敏感的库是额外压力。
- 修复方向：抽屉关闭或不可见时暂停（不只窗口隐藏）；间隔可配或默认 10s；「自动刷新」开关保留（现有设计是对的）。

### S4-8 切换结果标签会重新拉一次表结构（绕过已有缓存）

- 证据：`desktop/src/hooks/useResultSetEdit.ts:61` 直接 `dbApi.columns(connId, table)`；同一连接+表的结构在 `lib/dbStore.ts:555` 的 `columnsOf` 里已有 promise 缓存。
- 影响：每次切回一个可编辑结果标签都多一次字典查询；在慢库/多结果间切换时明显。
- 修复方向：改用 `columnsOf`（注意 schema 维度，见 S1-4），或把列信息挂到结果条目上。

---

## 做得好的地方（修复时别顺手改坏）

- 重结果集的排序/筛选放 worker，且有 pending/error UI：`useResultOrder` + `ResultTable.tsx:201, 228`。
- 值搜索有进度、可取消、命中上限提示：`ValueSearchDialog.tsx`。
- 断开/关标签前统一检查 primary 与所有独立槽的未提交事务：`dbActions.ts:128-134` + `dbConfirm.guardAllSessions`。
- 只读模式是后端强制的（JVM 策略 + Rust `set transaction read only`），不是只藏按钮：`db_engine.rs:353`、`db_rust.rs:686-708`。
- 轮询在窗口隐藏时停止：`SessionDrawer.tsx:55-66`，符合仓库「自动行为必须有可见开关 / 不可见即停」的约定。
- 结果集有 16MB 预算与明确提示，续取失败会复位 `loadingMore`：`dbResultBudget`、`dbStore.ts:1041-1053`。
- 写回顺序（删→改→插、新增倒序）和 UPDATE 原值守卫/CLOB 守卫的设计是正确的：`dbOptimisticEdit.ts:25-40, 98-102`。
- PL/SQL 错误行号按语句起始行偏移映射：`dbActions.ts:330-340`。
- 事务状态优先问数据库真源（`txActive` / `txStatus`），不迷信本地计数：`TxBar.tsx:55-62`。

---

## 建议修复批次

### 批次 A：S1 数据安全（先做，做完再发版）

1. S1-1 续取保留编辑（前缀判定 + loadMore 前检查）
2. S1-2 INSERT 预览守卫 + 克隆行跳过预览 CLOB
3. S1-3 render 期 plan 加 try/catch + canEdit 排除预览值 + 结果页显示 planError
4. S1-4 表页带 schema + 切 schema 处理旧页（限定表名是根治）
5. S1-5 plan 去重「已删行的 UPDATE」+ 自动提交失败后强制刷新

配套测试：`useResultSetEdit` / `dbOptimisticEdit` / `useTableSave` / `TableData` 各补最小回归；`Strict` 先跑 `desktop/scripts/gate.mjs` 的 scope 子集，最后跑全链。

### 批次 B：S2 一致性

- S2-1 脏编辑登记 + 关闭/切页/释放确认（先覆盖关闭与释放）
- S2-2 冷连接先 await ensureConnected
- S2-3 Rust 取消与超时拆 code
- S2-4 explain 走槽 + 任务键统一
- S2-5/S2-6 loadMore 返回原因、游标关闭不可重试
- S2-7 只读探测错误态 + 重试
- S2-8 空草稿不参与必填校验
- S2-9 txEpoch 刷新与过期提示
- S2-10 测试/保存拆键

### 批次 C：S3 UX

S3-1 → S3-10 按上面的修复方向逐条做；优先级：表页 CLOB 完整值 > 列宽/选区 > 持久化 > 文案与导入 > a11y。

### 批次 D：S4 性能

先做 S4-1（订阅拆分）与 S4-3（表页会话），再做 S4-2（行高）与 S4-5（历史节流）；S4-6/7/8 可以在同一批收尾。每项都要有可对比的测量（拖列宽帧时间、500 行网格重渲染次数、脚本回放耗时），不能只看「改完感觉快了」。

---

## 需要产品决策的点

1. **续取与编辑的语义**：推荐「追加行不丢编辑」；如果担心行号错位，退化为「有编辑时禁止自动续取，只保留手动按钮」。不建议静默清空。
2. **CLOB 是否允许网格编辑**：推荐网格只读预览，编辑一律走 SQL 或「大文本编辑框 + 完整值加载」；至少禁止对预览值做任何写回。
3. **表页是否占独立会话槽**：占用会多一条服务端会话，但不占会让表页、SQL 回退、执行计划互相顶锁；按「读多写少」的使用习惯，推荐表页占只读槽。
4. **默认超时**：30s 是否改成 60/120s，或按连接配置（生产库更保守、报表库更宽松）。
5. **文档/结果保活成本**：是否为多个结果标签保留挂载（保留筛选与滚动）而接受内存增长；或只持久化「筛选/排序/页码」到条目，不保留 DOM。

---

## 待运行验证清单

| 项 | 为什么不能只靠静态判断 |
|---|---|
| S1-4 切 schema 后表页的实际表现 | 代码路径确定，但页面是否已经加载过、是否自动重查，取决于真实运行时的状态时序 |
| S3-1 多结果集「加载完整值」 | 依赖后端 `lobValue` 对多结果集/行号的具体行为，需用真实 PL/SQL 返回多结果集验证 |
| S3-10 Esc 后首个 Enter | 取决于浏览器 blur 是否在 Esc 卸载 input 时触发 |
| S3-10 输入法首字符 | 取决于 WebView2 + 具体输入法的 keydown 序列 |
| S4-2 拖列宽卡顿 | 需要 500 行 + CLOB + 换行模式下实测帧时间，确认是否达到用户可感知阈值 |

除此之外的条目均由源码直接判定；审查期间没有修改任何文件，也没有执行测试套件。
