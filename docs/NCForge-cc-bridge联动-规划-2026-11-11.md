# NCForge × cc-bridge 联动：现状核对与规划

> 日期：2026-11-11　状态：**规划，待确认，未动代码**
> 对应多期规划 §5.2「cc-bridge 联动」，以及「代码区审查体验」方案里的批次 C。

## 1. 已经有的（不重做）

| 能力 | 状态 | 位置 |
|---|---|---|
| 「复制给 Claude」：选代码 / 改动块 + `file:line` 拼成 Markdown 进剪贴板 | ✅ 已落地，版本控制面、代码面浮层、时间线三处共用 | `lib/reviewNotes.ts` |
| 改动来源二分类：「我」（本工作台保存）/「外部」（AI / SVN 更新 / 别的编辑器） | ✅ 已落地 | `lib/changeTimeline.ts`、`externalJavaChanges.ts`、`localSaves.ts` |
| 改动「轮」时间线 + 多文件 diff + 审查清单 | ✅ 已落地 | `ChangeTimelinePanel.tsx`、`MultiFileDiffPanel.tsx`、`ReviewChecklist.tsx` |
| 跟读 `audit.log`，把「外部」细分出「AI」 | ⬜ 没做。**2026-11-10 的决定是「批次 C 不独立做」**，只留了复制给 Claude | `reviewNotes.ts` 头注释写明「不跟读 audit.log」 |
| 按桥备份回滚 | ⬜ NCForge 里没有；**cc-bridge 自己已有**版本历史与按会话还原（`backup_cmds.rs`、`cc_revert_cmds.rs`） | — |
| AI 活动流 | ⬜ NCForge 里没有；cc-bridge 的日志页就是这个 | — |

## 2. cc-bridge 侧的真实数据（本机 2026-11-11 实测）

- 位置：`%APPDATA%\com.ccbridge.desktop\audit.log`，JSONL，当前 10.7 MB / 9582 行，覆盖 2026-10-12 至今。
- 字段（`audit.rs::AuditEntry`）：`timestamp`、`tool`、`params`（请求参数**全文**，JSON 字符串）、`success`、`error`、`sourceIp`、耗时若干、`backupPath`、`targetPath`、`ccSessionId` 等。
- 写类工具带备份：`edit_files` 761 条中 730 条有 `backupPath`，`write_files` 700 条中 112 条（新建文件没有备份）。备份在 `.cc-bridge-backup\<文件名>.<时间戳>.bak`（现存 8535 个），原路径索引在 `cc-bridge.db` 的 `backup_index` 表。
- **四个坑**，决定了方案的边界：
  1. `ccSessionId` **全部为空**（9582 行里 0 行有值）：它只在 cc-bridge 自己拉起的 CC 会话里填，远程 Claude Code 没有。所以**做不了「按对话分组」**，只能按时间间隔分「轮」。
  2. 一次改多个文件时（167 条），`backupPath` / `targetPath` 只有一个字段，其余文件的备份只能从 `backup_index` 里查。
  3. AI 用 `run_command`（python、sed、git 等）改的文件，审计里只有命令文本，**无法可靠归因**，也没有备份。
  4. 日志会被 cc-bridge 按保留期**原地重写变短**，跟读要能处理「文件变小」。
- 路径带 `\\?\` 前缀，需要归一化。`sourceIp` 能区分远程 Claude（10.0.19.194）与本机客户端（127.0.0.1）。

## 3. 规划（全程只读 cc-bridge，不做硬依赖）

### P1 改动归因：「外部」细分出「AI」（约 2 d）

- Rust 侧增量跟读 `audit.log`：记住读到的偏移，文件变小就从头重读；只解析写类工具（`edit_files`、`write_files`、`move_files`、`delete_files`、`notebook_edit`、`batch` 里的写子操作），从 `params` 取出全部目标路径，只保留工作区内的。
- 前端时间线：外部写入与 AI 写入按「路径 + 时间窗」对上，就把「外部」标成「AI」；对不上的仍是「外部」（SVN 更新、别的编辑器、AI 用 run_command 改的）。
- 文件树 / 标签页加一个小标「AI 改过」，直到你标为已审或提交。
- audit.log 不存在 / 读不了：静默退回现在的二分类，不弹错。

### P2 「对比 AI 改之前」（约 1.5 d）

- 有备份的 AI 改动，在 diff 面板里提供「对比 AI 改之前」：用 cc-bridge 的 `.bak` 作基线。它比本地历史准：本地历史只在工作台自己写盘时归档。
- 「还原到 AI 改之前」只把内容放进编辑器，Ctrl+S 才落盘（沿用重构的红线）；不往 cc-bridge 写任何东西。
- 多文件改动的备份要读 `cc-bridge.db` 的 `backup_index`（只读打开），见待决策 4。

### P3 AI 活动流面板（约 1 d，建议不做）

- 列出最近 AI 对工作区的工具调用（时间、工具、文件、成败），点击打开文件或 diff。
- 与 cc-bridge 日志页重复，又是新增一个入口；建议不做，P1 的时间线已经覆盖「这轮 AI 改了哪些文件」。

### 不做

- 往 cc-bridge 写任何东西（配置、备份、数据库）。
- 按对话分组（数据里没有会话 id）。
- 把工作台引擎注册给 cc-bridge：那是 §5.2 的另一项「引擎开放给 AI」，单独规划。

## 4. 待你决策

1. **推翻 2026-11-10「批次 C 不独立做」的决定，做 P1 吗？**
2. **P2 做不做？**
3. **AI 用 run_command 改的文件**：仍算「外部」，还是按命令文本里出现的路径标「疑似 AI」？建议仍算「外部」，猜错比不标更误导。
4. **备份从哪读**：只用审计里的 `backupPath`（简单，但多文件改动只有一个文件有基线），还是只读 `cc-bridge.db` 的 `backup_index`（完整，但依赖 cc-bridge 内部表结构，它改表我们就读不到）？
5. P1 有界面改动（时间线标签、「AI 改过」小标），确认方向后先出本地设计稿。
