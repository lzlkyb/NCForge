# NCForge 桌面端 UI/UX 顶尖化：对标与落地方案

- 日期：2026-11-16
- 性质：设计契约候选稿（不是完成度台账）。**任何"已实现/未实现"的判断以当场 grep 为准**，本文只锚定"什么算顶尖"和"我们的差距在哪一层"。
- 调研口径：Linear 设计刷新复盘、VS Code 2026.10 Modern UI 复盘、JetBrains New UI 文档、Zed 渲染架构文章、Cursor 3 发布、Obsidian 主题生态、gadak `docs/UX_PRINCIPLES.md`（开源、逐条给了出处）。
- 本机体检基线：`desktop/src`（1599 个 ts/tsx、70 个 css、`index.css` 1402 行、353 个 `--` 变量、裸 hex 125 处、rgb/rgba 171 处、79 个 tsx 含内联 style）。

---

## 一、先把"顶尖"定义清楚

行业里被反复引用的顶级桌面产品（Linear、Raycast、Superhuman、Zed、Cursor、JetBrains、VS Code）在 2026 年已经收敛到**四条硬指标**，而不是"配色好看"：

| # | 指标 | 硬判据 | 一手证据 |
|---|---|---|---|
| 1 | **延迟预算** | 高频交互 < 100ms，理想 < 50ms；Zed 把每帧 8.33ms 当预算 | Superhuman「每次交互快于 100ms」、Raycast 50ms 规则、Zed GPU 渲染（`zed.dev/blog/videogame`） |
| 2 | **密度可调而非二选一** | 默认密度 + 紧凑密度都是 token 级档位 | VS Code 2026.10 把工作台做松后被用户骂"看不到代码"，最后补 `Layout Density: Compact`；JetBrains New UI 保留 Compact mode |
| 3 | **键盘完备** | 每个可执行动作都进命令面板；快捷键就地显示 | Linear/Raycast/Cursor 一致；gadak 更进一步：把"动作清单 vs 面板注册表"的 diff 当成可审计项 |
| 4 | **状态诚实** | UI 绝不暗示"已保存/已提交/已完成"，除非有证据 | Alinery `DESIGN.md`、JetBrains「无保存按钮 + Local History」、本项目 S1 系列静默丢改动的教训 |

**视觉层面的三条 2026 共识**（Linear 设计刷新原话）：

1. **别抢你没挣到的注意力**——导航、标签、图标降噪，让内容区占优；
2. **结构要被感受到，不要被看到**——少画分界线，靠字重/字号/留白建层级；
3. **一屏只用一次强调色**——颜色是注意力预算里最贵的一项。

---

## 二、可抄的 6 个样本（抄什么 / 别抄什么）

| 样本 | 抄 | 别抄 |
|---|---|---|
| **VS Code 2026 Modern UI** | 共享 design token 支撑多密度多主题；渐进发布（实验开关 → Insiders → 灰度 → 默认 + 保留回退） | 先做松再补紧凑（代价是两轮返工 + 公开反馈危机）；pill 标签割裂"标签-内容"归属 |
| **JetBrains New UI** | 标题栏 widget 化（Project/VCS/Run 各占一格）、tool window 可拖到任意 stripe、compact mode | 4 年长周期 + 双 UI 并行维护（资源黑洞）；经典 UI 插件化是补救不是设计 |
| **Linear** | 三条视觉原则；dev toolbar 挂 feature flag，一键对比新旧；把配色实验做成内部工具（调 hue/chroma/lightness 后导出 token JSON 回灌 Figma） | 极简到隐藏关键动作（它有 Cmd-K 兜底，多数产品没有） |
| **Zed** | 帧预算意识；ACP：不自己造大脑，把外部 agent 当引擎、自己只做最快的宿主 UI | 自研 GPU UI 框架（对 Electron/Tauri 栈是自杀式投入；但"渲染路径要可测量"必须学） |
| **Cursor 3** | agent-first 信息架构：会话是主体、diff 是审阅面、checkpoint 可回滚；本地/云端会话无缝交接 | 为 agent 重构一切（NCForge 的 NC 场景里人的精读仍是主体） |
| **Obsidian** | 把 CSS 变量当**公开 API**，命名稳定 → 长出 2000+ 主题；系统字体作为性能决策 | 完全放开的插件主题（一致性成本由核心团队承担） |

一个反常识结论：**顶尖感主要来自"不打断"和"可预期"，不是动效和玻璃**。gadak 的原则写得最直白——"读路径里出现 loading 态，是我用数据的姿势错了，不是待优化的 UI 细节"。

---

## 三、NCForge 现状体检

### 3.1 已经站在前面的（不要推倒重来）

| 项 | 证据 |
|---|---|
| 设计 token **双棘轮** | `desktop/scripts/check-design-tokens.mjs`：裸 hex 按文件记账、只降不升；TSX 实底表面类单独棘轮防"玻璃被戳穿" |
| 对比度是**算出来**的 | `index.css:131-137` 注释给出 success 4.88:1 / warning 4.81:1 / destructive 6.11:1，并解释为何不能复用 `-foreground` 而单列 `-ink` |
| 动效有门禁 | `scripts/check-motion.mjs` |
| UI 契约检查 | `scripts/check-ui-contract.mjs` + 一组 acceptance（glass / interaction / db-visual / code-controls） |
| 命令体系闭环 | `lib/commandRegistry.ts` + `keymap.ts` + `paletteStore.ts` + `paletteSources.ts` + `commandUsage.ts`（注册 → 面板 → 使用统计） |
| 密度与外观 | `lib/uiDensity.ts`（standard / comfortable）+ `appearance`（classic / glass）+ `.dark` |
| 组件基座 | `components/ui` 32 个（button/dialog/input/tabs/card/toast/Modal/Menu/EmptyState/Skeleton…） |

这套东西放在自研 IDE 类产品里属于上游水平。问题不在"有没有"，在**"是否只有一份"**。

### 3.2 真实差距（按影响排序）

**D1 · 同名令牌多值，没有单一真源（最高危）**

```
index.css:140            --r-control: 6px
forge-controls.css:6     --r-control: 8px
workbench-material.css:3 --r-control: 8px; --r-chip: 6px; --r-card: 14px; --r-menu: 14px; --r-dialog: 18px
```
同一个"控件圆角"在三个作用域是三个值。结果是：**换主题/换密度时圆角不会一起变，只在部分区域变**——这正是"做得不差但看起来不整齐"的典型成因。`--radius-*` 又从 `--r-*` 派生，整条派生链跟着漂。

**D2 · 令牌没有分层**

`@theme inline`（index.css:45）里同时住着：动画时长 `--dur-*`、缓动 `--ease-*`、控件尺寸 `--h-control`、圆角档位 `--r-*`、语义色 `--color-*`、阴影 `--shadow-*`。缺 primitive → semantic → component 三段，导致"改一个档位要动多个文件"。

**D3 · 样式按功能切文件，不按层**

70 个 css：`db*.css` 8 个、`svn*.css` 5 个、`settings-*.css` 4 个，令牌/组件/页面三层混写。新页面只能再开一个 css，棘轮又把裸 hex 锁死，作者只能在旧文件里加内容 → `index.css` 长到 1402 行。

**D4 · 缺设计契约文档**

`CLAUDE.md` 讲清了门禁怎么跑，但没回答"什么样的界面算合格"：密度档位怎么选、层级能否用颜色、动效能表达什么、状态怎么算诚实。没有契约时，一致性只能靠人记。

**D5 · 缺交互延迟预算与观测**

有 `check-bundle-size` / `check-motion`，没有"按键→首帧 p95"。这恰恰是顶尖与优秀的分水岭：用户感知不到 bundle 大小，能感知 120ms 的卡。

**D6 · 两代组件并存**

`button.tsx / dialog.tsx / input.tsx / tabs.tsx / card.tsx` 与 `Modal.tsx / ConfirmDialog.tsx / Menu.tsx / InfoPopover.tsx` 同时存在。新页面用哪套靠自觉，一致性会随人流动而衰减。

**D7 · 缺视觉回归基线**

acceptance 脚本能跑通，但没有"改完和改前逐像素/逐区域对比"。设计刷新的最大风险是"修好一处、弄坏三处"，没有基线就只能靠眼睛。

---

## 四、落地路线

### P0（先做，约等于把地基夯平）

**P0-1 令牌单一真源**
- 把 `--r-*` / `--h-*` / `--dur-*` / `--ease-*` 收进 `index.css` 一处定义；其他文件只允许**引用**，不允许重定义。
- 密度差异通过 `[data-ui-density]` 下的**档位映射**实现，而不是在各页面 css 里改值。
- 判据：`grep -rn -- "--r-control:" src` 只命中 1 处（档位映射块内可有多值，但必须在同一文件、同一选择器族）。写成 `scripts/check-token-single-source.mjs` 进门禁。

**P0-2 令牌三层化**
- `primitive`（色阶/间距刻度/字号阶梯/圆角刻度）→ `semantic`（surface / text / border / accent / status / focus）→ `component`（`--tab-height`、`--grid-row-h`、`--statusbar-h`）。
- 判据：`components/**` 与页面 css 里不出现 primitive 令牌；只出现 semantic / component。脚本可按名前缀白名单校验。

**P0-3 写 `DESIGN.md`（设计契约）**
必须固定的条目：
1. 密度档位与各档的 `--h-control` / 行高 / 间距（含虚拟列表行几何联动要求）；
2. 层级规则：字重 ≥ 两级、字号阶梯不超过 6 级、一屏强调色 ≤ 1；
3. 颜色使用：状态色只用于状态，不用来装饰；禁止用色相区分非语义内容；
4. 动效：只动 `transform` / `opacity`，100–300ms，`prefers-reduced-motion` 必须有降级；动效必须表达"从哪来/在跑/已成功"三者之一，否则删；
5. 状态诚实：写操作必须有"已写入的证据"（行数/回执/落盘），禁止乐观 UI 冒充成功；
6. 键盘：新动作必须同时进 `commandRegistry` 并在可见处显示快捷键。

**P0-4 交互延迟预算**
- 指标：`keydown → next paint` p95，目标：编辑/导航类 ≤ 50ms，面板/弹窗打开 ≤ 100ms，页面切换 ≤ 150ms。
- 做法：先在 dev 构建里埋一个轻量采样（performance.mark + 环形缓冲），跑三个固定脚本（打开文件、切标签、打开命令面板），把数值写进 `benchmarks/` 基线。
- 判据：基线文件存在 + CI 打印对比，超预算 20% 直接红。

### P1（补齐一致性）

**P1-1 组件层收敛**：给 `Modal/Menu/InfoPopover/ConfirmDialog` 标 `@deprecated` + 迁移清单（按调用点数量排），新代码只允许 `dialog/menu/popover`。判据：`grep -rn "from \"../ui/Modal\""` 数量只降不升（棘轮）。

**P1-2 密度三档**：`compact / standard / comfortable`。VS Code 的教训是"只给松不给紧"会被骂，NC 场景屏幕常被日志和网格挤满，compact 是刚需。判据：三档下截图对比同一页面，行数差 ≥ 15%，且无溢出/截断。

**P1-3 命令面板覆盖率审计**：把"可执行动作总数"与"已注册进 palette 的数量"做 diff，输出未覆盖清单。判据：覆盖率 ≥ 90%，未覆盖项必须写明理由（如危险操作需二次确认）。

### P2（把质量变成可回归的）

**P2-1 视觉回归**：10 个关键页面 × 3 档密度 × 2 主题，截图基线入库，改动超阈值才红（先只报不拦）。
**P2-2 空/载/错三态清单**：每个数据面必须有 `EmptyState / LoadingState / error` 三个显式实现（`components/ui` 已有基件，缺的是逐面核查）。
**P2-3 一次性清洗**：把 `index.css` 42 个裸 hex、其它文件按棘轮逐批降到 0，然后删除棘轮机制本身（棘轮是债，不是目标）。

---

## 五、一个必须避开的陷阱

**不要为了"顶尖感"引入玻璃、发光、渐变、大圆角。**
Linear 的设计刷新是把暖灰调回中性、把边框减淡、把图标缩小；VS Code 的现代化是把间距统一后**又因为挤掉内容而回退**。这两件事说明：顶尖感来自**约束的稳定性**，不是装饰的强度。NCForge 已有 `glass` 外观档，保留它，但默认档必须是"文字和数据最清楚"的那一档，玻璃只在用户显式选择时启用。

---

## 附：本文引用的一手来源

- Linear 设计刷新复盘：https://linear.app/now/behind-the-latest-design-refresh
- VS Code Modern UI 复盘（密度回退、connected tabs）：https://code.visualstudio.com/blogs/2026/10/15/modern-ui
- JetBrains New UI：https://www.jetbrains.com/help/idea/new-ui.html
- Zed 渲染架构（8.33ms/帧）：https://zed.dev/blog/videogame
- Cursor 3 发布：https://cursor.com/blog/cursor-3
- 开源 UX 原则（逐条挂出处）：https://github.com/midagedev/gadak/blob/v0.14.0/docs/UX_PRINCIPLES.md
- Obsidian 设计拆解（CSS 变量当公开 API）：https://blakecrosley.com/zh-Hans/guides/design/obsidian

---

## 六、落地记录（P0–P2 执行结果，2026-11-16）

### 6.1 已完成：代码 + 门禁 + 单测

| 项 | 落点 | 判据 / 验证 |
|---|---|---|
| P0-1 几何令牌单一真源 | `index.css` 新增「几何档位矩阵」区（`@tokens-geometry` 标记）；`forge-controls.css`、`workbench-material.css` 的 7 类几何重定义全部删除，改为引用 | `scripts/lib/token-geometry.mjs` + 6 条单测；`tokens:check` 新增硬检查，`--r-control` 全仓只剩 1 个定义处 |
| P0-2 令牌三层 | `scripts/lib/token-layers.mjs`：语义色必须在 `:root` / `.dark` 成对，`var(...)` 引用型自动跟随 | 6 条单测；实跑结果 0 缺失（`--ring: var(--primary)` 属引用型，不是缺陷） |
| P0-3 设计契约 | `desktop/DESIGN.md`：六条硬规则 + 三层定义 + 延迟预算 + 提 PR 六问 | 每条规则都挂可执行校验 |
| P0-4 延迟预算 | `src/lib/interactionBudget.ts`（dev-only 采样，rAF+setTimeout 结算上屏）、`scripts/interaction-budget.mjs`（表格 + 超预算标红） | 前端 5 条 + 脚本 5 条单测 |
| P1-1 组件收敛 | `Modal.tsx` 标 `@deprecated`（写明迁移三处核对点）；`InfoPopover.tsx` 标零引用孤儿；`Menu` **没有**替代品故不标 | `scripts/lib/deprecated-ui.mjs` 棘轮锁定 54，4 条单测 |
| P1-2 三档密度 | `uiDensity.ts` 扩为 compact/standard/comfortable + `DENSITY_ROW_H`/`DENSITY_HEAD_H`；矩阵区补 compact 几何；`interaction-density.css` 对称补齐；设置页加「紧凑」 | 6 条单测；`ResultGrid`/`ComparisonGrid` 行几何同源，不再各写一份 |
| P2-3 裸色清零 | appearance 9 处→`--glass-*` 令牌；palette 4 处→`--qp-kind-*`（明暗成对）；workbench-layout 1 处→`--shadow-tree-drawer`；index.css 渐变→`--grad-progress` | 裸色值 **20 → 0**，基线置空（`{}`），新增即红 |

### 6.2 机制就位、内容待推进（不要当成已完成）

| 项 | 已就绪 | 还差什么 |
|---|---|---|
| P2-1 视觉回归 | `scripts/visual-baseline.mjs`：6 场景（classic/glass × 三档密度 × 明暗），哈希比对，只报不拦；3 条单测 | **基线图未生成**——本机 chromium 未安装。装完跑 `npx playwright install chromium && npm run visual:update` |
| P2-2 三态覆盖 | `scripts/three-states-report.mjs`：列出 25 个「有数据请求但缺空/载/错」的候选文件 | 25 个需逐个判读：真缺就补，不需要就登记到 `ALLOW` 并写理由。脚本给的是候选，不是结论 |
| P1-1 迁移 | 棘轮 + `@deprecated` 说明 | Modal 的 54 处导入未迁移。建议按调用点密度分批（设置页 → 服务页 → 数据库页） |
| P2-3 棘轮机制 | 基线已空，等价硬禁止 | 机制本身保留（`surface-baseline.json` 那半还在管玻璃实底），不清除 |

### 6.3 本轮修掉的真问题

1. **几何令牌三层打架**（这是"看起来不整齐"的根因）：`--r-control` 同时存在于 3 个文件，`html[data-ui-style]`(0,1,1) 特异性压过 `.forge-controls`(0,1,0)，导致 `index.css` 的 `6px` 和 `--h-control: 30px` **从未生效**，而运行时真实值是 8px / 32px。同时 Tailwind 的 `rounded`(6px) 与 `rounded-md`(8px) 互相不一致。
2. **裸色 20 处**全部归零，其中玻璃徽章的 9 处是材质专属色（底是彩色渐变，普通语义色的对比度套不上），单列 `--glass-*-ink` 并写明原因。
3. 更正我上一版方案里的一处事实错误：不存在 `menu.tsx`，`Menu` 是唯一实现，不该标废弃。

### 6.4 遗留判断（明确不做）

- 不追求"禁止页面直接引用 primitive 令牌"：存量太大、收益低，改为在 DESIGN.md 写约定。
- 不给延迟预算设 CI 阈值：机器差异大，卡阈值只会逼人调阈值（与 `perf-baseline.mjs` 同一立场）。
- 不自动生成视觉基线：截图 diff 必然有噪声，基线必须人工确认后入库。
