# NCForge × cc-bridge 联动：现状核对与规划

> 日期：2026-11-11 初稿，2026-11-12 修订　状态：**规划，待确认，未动代码**
> 对应多期规划 §5.2「cc-bridge 联动」，以及「代码区审查体验」方案里的批次 C。
>
> **2026-11-12 修订**：用户同意 cc-bridge 配合修改，但要求做成开放能力、不为 NCForge 定制。
> 方案从「NCForge 解析 audit.log」改为「cc-bridge 提供开放的变更日志，NCForge 是使用方之一」。
> cc-bridge 侧见 `cc-bridge/proposals/change_journal_rfc.md`。

## 1. 已经有的（不重做）

| 能力 | 状态 | 位置 |
|---|---|---|
| 「复制给 Claude」：选代码 / 改动块 + `file:line` 拼成 Markdown 进剪贴板 | ✅ 已落地，版本控制面、代码面浮层、时间线三处共用 | `lib/reviewNotes.ts` |
| 改动来源二分类：「我」/「外部」 | ✅ 已落地 | `lib/changeTimeline.ts`、`externalJavaChanges.ts`、`localSaves.ts` |
| 改动「轮」时间线 + 多文件 diff + 审查清单 | ✅ 已落地 | `ChangeTimelinePanel.tsx`、`MultiFileDiffPanel.tsx`、`ReviewChecklist.tsx` |
| 从「外部」里认出「AI」 | ⬜ 没做。2026-11-10 决定「批次 C 不独立做」 | `reviewNotes.ts` 头注释写明「不跟读 audit.log」 |
| 按桥备份回滚 / AI 活动流 | ⬜ NCForge 里没有；cc-bridge 自己有版本历史、按会话还原、日志页 | — |

## 2. 为什么改方案

直接读 audit.log 的四个硬伤（2026-11-11 实测）：没有会话 id、多文件编辑只记一个备份、改了哪些文件藏在参数全文里、日志会被原地重写变短。
使用方只能「按路径 + 时间窗」猜。既然 cc-bridge 可以改，就让它在改文件的那一刻把事实记清楚。

变更日志给出的关键信息是每个文件改完后的 **SHA-256**：
NCForge 把文件当前内容的哈希和它比，就能**确定**「这份就是 AI 写的」或「AI 写完后有人改过」，不再依赖时间窗。

## 3. NCForge 侧规划（使用方，只读）

### P1 改动归因（约 1.5 d）

- Rust 侧按 `seq` 续读 `journal\changes-*.jsonl`，只留工作区内的条目。
- 外部写入时，计算文件哈希：等于某条变更的 `after.sha256` 就标「AI」，并带上工具名、客户端与 `run`（一轮活动）；对不上就仍是「外部」（SVN 更新、别的编辑器、AI 用命令改的）。
- 时间线的「轮」优先用变更日志的 `run` 分组。
- 文件树 / 标签页小标：「AI 写的，未改过」/「AI 改过，之后有人动过」，标为已审或提交后消失。
- 没有变更日志（cc-bridge 旧版本、关了、没装）：静默退回现在的二分类。**不再解析 audit.log**。

### P2 「对比 AI 改之前」（约 1 d）

- 变更里有 `backup` 的，diff 面板提供「对比 AI 改之前」。一轮改了多次同一文件时，取这一轮第一条的备份当基线。
- 「还原到 AI 改之前」只把内容放进编辑器，Ctrl+S 才落盘。备份已被清理时明确说「备份已不在」。

### 不做

- AI 活动流面板（与 cc-bridge 日志页重复）。
- 往 cc-bridge 写任何东西。
- 把工作台引擎注册给 cc-bridge（§5.2 另一项，单独规划）。

## 4. 实施顺序

1. cc-bridge：变更日志文件通道 + 写类工具接入 + 规范文档（约 2.5 d）；设置项（约 0.5 d，先出设计稿）。
2. NCForge：P1 → P2（约 2.5 d；P1 的小标与时间线标签先出设计稿）。
3. 合计约 5.5 d。

## 5. 待你决策

1. 按「cc-bridge 开放变更日志 + NCForge 使用」走，并推翻 2026-11-10「批次 C 不独立做」吗？
2. cc-bridge RFC 里的 4 个待决策（首期只做文件通道、`run` 间隔 5 分钟、命令引起的改动先不做、保留 30 天）。
3. NCForge 的 P2 做不做。
