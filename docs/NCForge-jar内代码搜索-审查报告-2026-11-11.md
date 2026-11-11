# jar 内代码搜索（批次 A + A 续）审查报告

- 日期：2026-11-11
- 范围：jar 内符号搜索（`class_pool` / `jar_symbols` / `jar_symbol_cmds` / `JarSymbolResults`）、
  jar 内源码注释搜索（`java_comments` / `src_notes` / `src_note_cmds` / `read_src_file` / `SrcNoteResults`）、
  前端接线（`lang.ts` / `searchStore` / `SearchTab` / `useSearchControls`）、GBK 编码探测修复。
- 方法：读真实源码 + file:line 证据；关键数字用 release 探针实测（探针用完即删，未入库）。
- 结论先行：**3 个真 bug、4 个体验问题、2 个性能问题**；另有一批「查过确认没问题」的疑点列在末尾，避免重复排查。

---

## 一、真 bug（会导致错误结果或功能失效）

### B1 `extract_notes` 字符串转义越界 → panic，且会把「后台建索引」永久卡死

`desktop/src-tauri/src/java_comments.rs:97`

```rust
if b[i] == b'\\' {
    if b[i + 1] == b'\n' {   // ← i 是文件最后一个字节时越界
```

外层 `while i < b.len()` 只保证 `i` 合法，不保证 `i+1`。同一个函数里 `//`、`/*`、`*/` 三处判断都写了 `i + 1 < b.len()`，只有字符串转义这一处漏了。

触发条件：某个 `.java` 的最后一个字节是字符串字面量里的 `\`（被截断的源文件、异常编码）。21.4 万个源文件里只要有一个就中。

**比 panic 更严重的连带后果**：`src_note_cmds.rs:102` 的 `BUILDING.store(false)` 在 panic 之后不会执行
（panic 直接从 `spawn_blocking` 闭包里穿出），于是：

- `BUILDING` 永久为 true → 之后所有 `spawn_build` 第一行就 return；
- 索引永远建不出来 → 前端永远显示「索引正在后台建立」；
- **只能重启应用恢复**。

修复（两行，建议一起做）：

1. `java_comments.rs:98` 改成 `if i + 1 < b.len() && b[i + 1] == b'\n'`；
2. `src_note_cmds.rs` 的 `BUILDING` 复位改成 RAII guard（或 `std::panic::catch_unwind` 包住 build），
   保证任何 panic 都不把「在飞」标志留在 true。`jar_symbol_cmds.rs:139` 是同一个模式，一起改。

### B2 同一条注释里关键词出现多次 → 返回多条完全相同的命中

`desktop/src-tauri/src/src_notes.rs:440-446`

`search` 对每个字节命中都 `out.push(...)`，**没有按注释下标归并**。对照 `jar_symbols.rs:599-600`：

```rust
found.sort_unstable();
found.dedup_by_key(|(id, _)| *id);   // jar_symbols 有归并，src_notes 没有
```

release 探针实测（构造 3 条注释，其中一条含两个「凭证」）：

```
索引共 3 条注释
搜「凭证」limit=10 → 3 条命中
   - "凭证校验：凭证号不能为空"
   - "凭证校验：凭证号不能为空"     ← 同一条注释出现两次
   - "凭证同步"
```

后果：

- 结果列表出现重复行（`jar`/`path`/`line`/`text` 全同）；
- 前端 `SrcNoteResults.tsx:102` 的 `key` 是 `${hit.jar}:${hit.path}:${hit.line}` → **React 重复 key 警告**；
- `limit=40` 被重复项占用，真实不同注释被挤出；
- 高频词（「凭证」「升级」「单据」）在长 javadoc 里很容易重复出现，不是边缘情况。

修复：push 前记下 `lo_i`（命中归属的注释下标），与上一条相同就 `continue`；或仿 `jar_symbols` 收集后 `dedup_by_key`。

### B3 点开一条命中要固定多花约 1.9 秒

`desktop/src-tauri/src/commands/src_note_cmds.rs:208`（`read_src_text` 内）

```rust
let jars = crate::java_comments::source_jars(nc_home);   // 每次点开都全量枚举
```

`source_jars` 是 `modules/**` 的完整目录遍历。release 探针实测（`D:\ncc\1909home`）：

```
源码包 2775 个：枚举 1869 ms，逐个 stat 112 ms
```

也就是说用户点一条「jar 内注释」命中，编辑器要过 ~1.9s 才出来（冷缓存时上轮实测 2.8s）。
直读本身是 zip STORED 直读，毫秒级——**99% 的时间花在枚举 jar 上**。

修复：进程内按 NC home 缓存 jar 清单（`OnceLock<Mutex<Vec<PathBuf>>>`），或直接复用
`LOADED` 槽里已经记住的那份（`src_note_cmds.rs:51` 的 `LoadedSlot` 第三字段就是它）。
组件装卸导致清单变化时，下一次搜索的 `stale()` 本来就会发现并重建，语义不丢。

---

## 二、体验问题（结果会误导用户）

### U1 这一段永远显示「显示前 N」，而且从不告诉用户命中了几条

`desktop/src/components/search/SrcNoteResults.tsx:65-69`

```
共 <b>{result.total}</b> 条注释可搜
{result.items.length < result.total && ` · 显示前 ${result.items.length}`}
```

`total` 是**索引里注释的总条数**（`src_note_cmds.rs:186` 的 `index.notes()`，30 万量级），
**不是命中数**。于是：

- 只有 1 条命中时也显示「共 300000 条注释可搜 · 显示前 1」——读起来就像被截断了；
- 真正的「还有更多」反而没有出口：`src_notes.rs:447-449` 在 `limit` 截断时直接
  `return (out, false)`，`truncated` 恒为 false。探针实测 `limit=1` → 1 条命中、`truncated=false`。

对照 `JarSymbolResults.tsx:71-72`：「共 N 个词命中 · 显示前 M」——那边的 `total` 是真命中数
（`jar_symbols.rs:601`），文案是对的。两段并排，差别一眼能看出来。

修复（与 B2 同一个改动）：`src_notes::search` 返回「命中总数 + 是否因 limit/预算截断」，
前端文案改成「命中 N 条 · 显示前 M」，`truncated` 真正用于提示。

### U2 相邻两段的常驻说明自相矛盾

`JarSymbolResults.tsx:93` 写着「**搜不到注释**——class 文件不含注释」，而它下面紧接着就是
「jar 内源码注释」这一段。两句话各自都正确，但并排出现会让用户以为功能坏了。

修复：上一段改成「注释不在这段，见下面『jar 内源码注释』」。

### U3 两段都没有「取数中」状态

`JarSymbolResults` / `SrcNoteResults` 都只在后端回 `building` 时显示建立中的文案；
自己的 IPC 在飞时（约 120-180ms，见 P1）界面毫无变化，结果是「迟一点突然出现」。
低优先级，加一个 `<i>搜索中…</i>` 即可。

### U4 building 态的头部也显示上次的 `total`

`SrcNoteResults.tsx:66` 的「共 N 条注释可搜」在 `building` 时同样渲染，数字来自上一次的索引量级，
可能误导。建议 building 时只保留「正在建立」那一行。

---

## 三、性能问题

### P1 每次搜索先做 2775 次 stat ≈ 112-173ms，是搜索本身（1.3ms）的 100 倍

`src_note_cmds.rs:171` → `src_notes.rs:363-379`：`stale()` 对全部源码包逐个
`metadata + mtime`。release 探针实测：**逐个 stat 112ms**（冷/热有差异，上轮探针测到 173ms），
而搜「凭证」本身只要 1.3ms。`jar_symbols` 是同一个模式（3341 个 jar，`jar_symbols.rs:494-504`）。

另外这 112ms 是**在 async 线程上同步做的阻塞 I/O**，会拖慢同线程的其他 IPC。

修复：进程内按索引记一个 `last_stale_check: Instant`，2-5 秒内不重复 stat。
jar 被替换（打补丁）时，最晚 5 秒后的那次搜索必然发现，语义不丢，代价从 112ms 变成 1.3ms。

### P2 常驻内存与多 home 索引残留

- 源码注释索引常驻 **227MB** + jar 符号索引 **96MB**（均实测），加上类索引与内容包，稳态数百 MB。
  可接受，但要写进文档——用户报「占内存」时答得上来。
- `cache_dir_for` 按 NC home 哈希分目录（`src_notes.rs:61`），换一个 home 就多一份 227MB，
  旧的不会自动清。建议设置里给一个「清理索引缓存」。

### P3（查过，不是问题）零命中关键词的最坏扫描实测 38ms

`src_notes.rs:450` 的预算检查只在命中之后，无命中的 needle 会扫完整个 227MB blob。
原以为这是隐患，实测（构造同尺寸缓冲，`memchr2`）：

```
零命中 needle 扫完 227 MB：38 ms（命中 0 次）——即一次搜索的最坏耗时
对照：每字节都命中（931180 次候选）耗时 33 ms
```

38ms 远低于 500ms 预算，**不需要改**。记录这个数，以免以后凭感觉把它当故障。
`jar_symbols` 把检查放在循环顶（`jar_symbols.rs:562`），保留即可，两档保持一致更好看但不是必须。

---

## 四、已知边界 / 理论缺口（不阻塞，列出来防止重复排查）

| # | 事项 | 证据 / 结论 |
|---|---|---|
| K1 | `read_src_file` 没有大小上限 | 建索引时跳过 >2MB 的 `.java`（`java_comments.rs:114`），点开时仍整读 + IPC。NC 源码不存在这种文件，属纵深防御，可加一行 `MAX_JAVA_BYTES` 守卫 |
| K2 | peek 路径不认 `_src.jar` | `lang.ts:764-773` 无 try/catch、无直读分支。**未观察到触发路径**：`_src.jar` 被 `is_runtime_archive` 排除在 classpath 外（`nc_index.rs:108`），jdt.ls 与类型目录（`java_types` 只读 `ClassIndex.jars`）都不会产出这种 URI；且 `provideDefinition` 有 try/catch（`langProviders.ts:196-200`），最坏只是跳过该跳转目标。要修就 3 行 |
| K3 | 同名源码包跨模块可能点开错模块 | 前端只回传 jar 文件名（`jarSymbolSearch.ts:54` 的 `pop()`），`pick_jar` 取第一个匹配（`decompile.rs:93`）。NC 的 jar 名带模块前缀，实际不会撞；与既有反编译路径同性质 |
| K4 | GBK 探测阈值 1.5 的边界 | `workspace.rs:499` `cont*2 > lead*3`：3 字节与 2 字节字符 1:1 混合的文件比值恰为 1.5 → 判 GBK。已文档化为取舍（显示错、字节不丢） |
| K5 | 启动预热的串行代价 | 4 个预热共用 `prewarm_budget` 全局互斥（`prewarm_budget.rs`），全新安装首次启动后台要跑几分钟；「载入已有索引」不走闸，启动时会有一次 227MB+96MB 并发读。设计如此，记录备查 |
| K6 | `jar_symbols::places` 上限 8 处，UI 文案会说少 | `JarSymbolResults.tsx:127-130` 的「另有 N-3 处」基于被截到 8 的列表，实际可能更多。极小 |

---

## 五、查过确认没问题的疑点（省得以后重复查）

1. **`src_notes.rs:346` 裸切片**（`&self.data[at+2..at+2+len]`）：`load`（291-301 行）逐段校验了边界，
   且 `jar_of` 的循环 walk 每步都有 `.get()` 容错；只有「索引文件被手工篡改」才可能越界，
   而 `load` 的段校验已经把这种文件挡在门外（`total != data.len()` 直接 None）。
   **不需要改**，与 `rd_*` 全用 `.get()` 的风格不一致，属美观问题。
2. **GBK 修复与包版本迁移**：`content_pack.rs` 的 `FORMAT_VERSION` 已从 2 提到 3，
   注释写明了「不是为了布局，是为了让旧包失效」——旧包里按 UTF-8 误解释的乱码不会被增量复用。✔
3. **`nc_home::resolve` 每次搜索扫盘**：不存在。配置了路径只 `probe()` 一次。
4. **测试 URI 切片非 char 边界 panic**：`start`/`i` 总在 ASCII 边界。
5. **zip `by_name` 任意文件读**：条目名由 URI 拼出且限定 `_src.jar`，无逃逸。
6. **`class_pool` 解析循环**：Long/Double 双槽、畸形 class 全部 `return false` 跳过，
   8 个测试覆盖；`keep()` 对 `/`、`.`、`;` 的处理与实测吻合。
7. **前端状态流**：`searchStore` 的 `jarSymbols`/`srcNotes` 在换范围、换工作区
   （`resetSearchForm`/`applySearchScope`）时都清空；两段都用请求序号防旧请求覆盖新结果。✔

---

## 六、归属与修复顺序

**本轮新代码引入**：B1、B2、B3、U1、U4、P1、P3（实测澄清）。
**新代码与既有 UI 并置产生**：U2、K6。
**既有框架被本轮放大**：P2、K5。

建议顺序（前三个都是一两行，收益/风险比最高）：

| 顺序 | 项 | 改动量 | 用户可感知的收益 |
|---|---|---|---|
| 1 | B1 | 2 行（边界 + RAII guard） | 消除「功能永久停在建索引」的最坏情况 |
| 2 | B2 | 约 5 行 | 结果不再重复、limit 不被浪费 |
| 3 | B3 | 约 10 行（缓存清单） | 点开从 ~1.9s 到毫秒级 |
| 4 | U1（含命中总数/截断语义） | Rust 返回 + 前端文案 | 「命中几条」终于说得准 |
| 5 | P1 | 约 5 行（节流） | 每次搜索从 ~120ms 到 ~1.3ms |
| 6 | U2 | 1 行文案 | 两段不再互相矛盾 |

---

## 七、修复结果（2026-11-11 当天完成，未提交）

按上表顺序全部落地。U3/U4 顺手一并做（都在同一批文件里，拆开反而多一轮验证）。

| 项 | 落在哪 | 怎么验的 |
|---|---|---|
| B1 | `java_comments.rs:98` 加 `i + 1 < b.len()`；`src_note_cmds.rs` / `jar_symbol_cmds.rs` 的 `BUILDING` 复位改成 RAII `BuildingGuard`（panic 也释放） | 新增回归测试「字符串以反斜杠结尾不越界」：panic 用例 + `\\` 转义对照组 |
| B2 | `src_notes.rs::search` 按注释下标归并（`last_note`）+ 命中后把游标推到注释末尾 | 新增「同一条注释命中多次只算一条」 |
| B3 | `src_note_cmds.rs` 的 `source_jars_cached`：按 NC home 缓存 jar 清单（`OnceLock<Mutex<Option<JarList>>>`），点开 / 预热 / 搜索加载 / `read_src_text` 四处共用 | 新增「源码包清单按_home_缓存_换_home_才重枚举」 |
| U1 | `search` 返回 `(hits, total, truncated)`：`total` 改为**本次命中条数**，收够 limit 只停止 push、继续计数；前端文案「共 N 条注释可搜」→「命中 N 条 · 显示前 M」 | 新增「limit_截断要报出来_并且总数是命中数」；前端断言同步改为「命中 5 条」+「显示前 1」 |
| P1 | `stale_throttled`：按索引路径记 `(path, Instant, verdict)`，2s TTL 内复用结论，stat 不持锁；两档都上 | 新增「stale_节流按索引路径分开_同路径复用结论」 |
| U2 | `JarSymbolResults.tsx` 常驻说明补「要搜注释看下面的『jar 内源码注释』段」 | 测试断言加 `toContain("jar 内源码注释")` |
| U3 | 两段各加 `loading` state：请求在飞显示「搜索中…」，序号守卫防旧请求收掉新请求的 loading | 两端各加 1 个 deferred-promise 测试 |
| U4 | building 时不渲染命中数那一行（索引没建好，报上次的条数只会误导） | 新增「building 时不报命中数」测试（`total: 300000` 也不许出现） |

**未做**（明确记录，避免下次重复排查）：

- P2（多 home 索引残留）：要设置里加「清理索引缓存」，属独立小需求，不在本批。
- K1（`read_src_file` 大小上限）：纵深防御，NC 源码不存在 >2MB 的 `.java`。
- K2（peek 路径不认 `_src.jar`）：实测无触发路径（`_src.jar` 被 `is_runtime_archive` 排除在 classpath 外）。

**门禁逐项结果**（`node scripts/gate.mjs --only <id>`，fail-fast 所以必须分批跑，各项退出码逐一记录）：

| 项 | 结果 |
|---|---|
| component-size | ✅ |
| contract | ✅ 247 条命令一致 |
| tokens / ui-contract | ✅ 均未超基线 |
| fmt / machete | ✅ |
| eslint | ✅ |
| tsc | ✅ |
| clippy（`-D warnings`） | ✅ 1m38s |
| rust-test | ✅ **1166 passed / 0 failed** |
| vite-build | ✅ 1921 modules，40s |
| bundle-budget | ✅ 1686/1700 KB gzip、5773/5850 KB raw |
| knip | ⚠️ 红在 `src/hooks/useSettingsMutation.ts`——**他人未入库的新文件**（无人 import），不是本次改动 |
| rust-tempdir | ⚠️ 模块内 90>87、integration 14>12——与他人并发改动完全吻合；本次 4 个 .rs **0 处裸 `temp_dir()`**、9 处走 `test_support::tmp` |
| vitest | ⚠️ 12 failed / 2824 passed——**全部来自工作树里他人未提交的「设置中心」重构**（`BuildSettings`/`NcEnvSettings`/`SqlFormatSettings`/`WorkbenchFrame` 四个测试文件，文案从「常驻 ecj 编译进程」改成「保留后台编译进程」等），与本次改动无关；本次的两个测试文件 17 个用例全过 |

⇒ **12/15 绿，3 个红全部可追溯到他人并发**。判自己的改动绿不绿只能 `--only` 逐项记退出码，别信全套 exit code（fail-fast 会在第 2 项 knip 就停，看起来像「全红」）。

> 本轮全部改动（含本审查发现的问题）**尚未提交**：新文件 `class_pool.rs`/`jar_symbols.rs`/
> `java_comments.rs`/`src_notes.rs`/`jar_symbol_cmds.rs`/`src_note_cmds.rs`/
> `JarSymbolResults.tsx`/`SrcNoteResults.tsx`/`useSearchControls.ts`/`srcNoteSearch.ts`/
> `jarSymbolSearch.ts` 均为未跟踪状态；`workspace.rs`/`content_pack.rs`/`lang.ts`/
> `SearchTab.tsx`/`searchStore.ts` 等为已跟踪未暂存。工作树同时混有他人未提交改动，
> 提交时须白名单分笔，禁 `git add -A`。
