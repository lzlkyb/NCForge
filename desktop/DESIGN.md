# NCForge 桌面端设计契约

> 本文件是 UI 的**判据**，不是灵感集。改动界面时先对照这里；改动这里的规则必须带日期和原因。
> 与代码冲突时：先怀疑代码。与测试冲突时：先读测试钉的语义。
> 最后更新：2026-11-16（P0 建立）。

---

## 1. 六条硬规则

每条都给出**可机器校验**的口径。不能校验的规则不写进来。

### R1 几何只有一份

圆角、控件高度、控件间距由 `desktop/src/index.css` 的「几何档位矩阵」统一定义
（`@tokens-geometry:start` / `:end` 之间）。其它 CSS **只允许引用**，不允许定义。

校验：`npm run tokens:check`（`scripts/lib/token-geometry.mjs`）。违规即红。

### R2 颜色只能来自语义令牌

组件与页面不写裸色值（`#hex` / `rgb()`），只用 `--color-*` 这一层。
新增颜色先问：能不能用现有语义色？不能才加 token，并在 `:root` 与 `.dark` 同时给值。

校验：`npm run tokens:check` 的裸色值棘轮（**基线已置空**：2026-11-16 清零，新增任何裸 hex 直接红）。

### R3 密度是档位，不是像素

档位三档（`html[data-ui-density]`）：

| 档位 | 适用 | `--h-control` | `--h-icon` | `--h-topbar` | `--h-toolbar` | `--h-side-item` 展开/折叠 | `--row-h` |
|---|---|---|---|---|---|---|---|
| `compact` | 小屏、多编辑器组、网格/日志并排 | 26px | 24px | 36px | 32px | 32 / 46 | 22px |
| `standard`（默认） | 常规 | 32px | 28px | 40px | 36px | 36 / 53 | 26px |
| `comfortable` | 大屏、演示、触摸 | 32px | 32px | 44px | 40px | 40 / 60 | 30px |

触屏（`pointer: coarse`）强制 ≥ 40px，覆盖上表。

**外壳几何必须跟密度走**（2026-11-17 接线）：顶栏、工具栏、侧栏项此前写死
40 / 36 / 53px，实测三档切换只有字号在变，密度形同虚设。现在四类外壳高度
全部取自 `--h-topbar` / `--h-toolbar` / `--h-side-item` / `--h-side-item-col`
（折叠态是图标+文字竖排，单独一档），改动只允许在 `index.css` 的矩阵区。

**新增尺寸一律写成 `var(--h-control)` 之类的令牌引用**，不写死像素。
虚拟列表（结果网格、日志、文件树）必须在密度变化事件里重算行几何——
`lib/uiDensity.ts` 提供 `subscribeUiDensity`，不订阅就会出现"行高变了但滚动位置错位"。

验证方式不是看代码，是**切三档量实际高度**：改 `document.documentElement.dataset.uiDensity`
后逐档读 `getBoundingClientRect()`。令牌字面值变了不等于渲染变了——2026-11-17 就是
靠这一步才发现顶栏三档都恒为 40px。

### R4 层级靠字重与留白，不靠颜色

- 字号阶梯 ≤ 6 级；字重只用 400 / 500 / 600 三档。
- 差异 < 15% 的字号不构成层级——用字重或留白区分。
- **一屏只允许一个强调色区域**。状态色（success/warning/destructive）只用于状态，
  不用来装饰标题、图标或边框。
- 分隔线优先用 `--border` 而不是硬描边；能靠留白就不断线。

### R5 动效必须传达信息

- 只动 `transform` / `opacity`；动 `width`/`height`/`top` 属于性能缺陷。
- 时长只用 `--dur-*` 令牌：反馈 70–100ms，面板 140–180ms，大转场 ≤ 320ms。
- 每个动效必须回答"它表达了什么"：从哪来 / 正在跑 / 已成功。答不上来就删。
- `prefers-reduced-motion: reduce` 下必须降级为零位移（`check-motion` 校验）。

### R6 状态必须诚实

UI 不得暗示"已保存 / 已提交 / 已完成"，除非有证据。

- 写操作成功 → 必须有可核对的结果（影响行数、返回码、落盘路径、后端回执）。
- 乐观 UI 只允许用于**可回滚且失败可见**的操作；失败必须把界面恢复成库里的真实状态。
- "加载中" 不得掩盖失败。三种合法呈现，按面类型选一种并**在同一面内保持一致**——不强制用某个组件：

  | 面类型 | 写法 | 现有例子 |
  |---|---|---|
  | 面板 / 页面主体 | 具名组件 `EmptyState` / `LoadingState` / `ErrorBoundary` | `DbTab`、`MetaTab`、`NoWorkspace` |
  | 密集列表、分栏内的局部区 | 内联语义 `role="status"` + `role="alert"` + `vc-empty` / `vc-alert` | `HistoryView`、`ConflictPane`、`PackageDependencies` |
  | 状态栏 / 工具条上的胶囊 | `data-tone` 编码：`busy` / `bad` / 缺省 | `PatchHealth`、`ServiceStatusButton`、`HotswapStatusChip` |

  红线只有一条：**允许显示"正在加载"的面，必须有失败出口**（alert / toast / `data-tone="bad"`）。
  失败后胶囊静默消失、或把读取失败显示成"未配置"，都算欺骗——用户会读成"没有数据"。
  反过来「有错态没有载态」是合理取舍：错误信息本身就是终态，不需要额外转圈。
  校验：`npm run states:audit`。
- 未写回的编辑必须在关闭 / 切换 / 续取前显式确认，不允许静默丢弃
  （历史教训见 `docs/NCForge-数据库UI-UX审查-2026-11-10.md` S1 系列）。

---

## 2. 令牌三层

| 层 | 前缀 | 谁可以定义 | 谁可以消费 | 例子 |
|---|---|---|---|---|
| primitive 原语 | `--r-*` `--h-*` `--gap-*` `--w-modal-*` `--dur-*` `--ease-*` `--fs-*` `--lh-*` | 只有 `index.css` 的矩阵区/动效区 | semantic、component 层 | `--r-card` `--w-modal-md` `--dur-fast` |
| semantic 语义 | `--background` `--foreground` `--primary` `--border` … 及派生 `--color-*` | `index.css`（`:root` 与 `.dark` 成对） | 任何地方 | `--color-primary` |
| component 组件 | `--forge-*` `--material-*` `--dbx-*` `--sh-*` `--badge-*` `--chart-*` `--window-*` | 所属组件/材质文件 | 本组件域内 | `--forge-control` |

规则：
- **语义色必须在 `:root` 与 `.dark` 成对出现**，只写一边等于让另一主题瞎掉。
- 组件层令牌不得被页面 CSS 重新定义（页面只能换 `data-*` 档位）。
- 新增 component 令牌优先写成对 primitive / semantic 的引用（`--forge-radius: var(--r-control)`），
  而不是再写一个字面值。

### 2.1 弹层宽度六档

弹窗宽度**只能**取下面之一，每档自带视口兜底（`min(NNNpx, calc(100vw - 32px))`），
不要自己再写 `max-w-[92vw]`：

| 档位 | 值 | 用在哪 |
|---|---|---|
| `--w-modal-xs` | 380 | 认证、轻提示、生成配置 |
| `--w-modal-sm` | 460 | 通用小弹窗（`Dialog` 的默认）、重命名 |
| `--w-modal-md` | 620 | 表单主力：端口、对比源、SQL 参数、单元格详情 |
| `--w-modal-lg` | 820 | 宽表、日志详情、设置关于、导入向导 |
| `--w-modal-xl` | 960 | 代码预览、关联工程、对象/列检视 |
| `--w-modal-2xl` | 1120 | 传输工作台 |

- 写 `width: var(--w-modal-md)` 或 `className="w-[var(--w-modal-md)]"`，两者都可以。
- **不纳入档位**的：抽屉类（`.dbx-drawer` / `.sc-drawer` / `.vc-commit-drawer`）宽度
  相对容器而非视口，用视口兜底是错的语义；`design-preview` 是独立入口。
- 高度不管：普遍是 `min(NNNpx, calc(100dvh - …))` 的自适应写法，没有档位语义。
- 校验分两层：`npm run tokens:check`（静态，`scripts/lib/modal-width.mjs`）证明代码写的是
  令牌；`npm run modals:audit`（需 dev server + chromium）注入每个弹层类量实际像素，
  证明变量真的解析成了该档位。**静态绿不等于渲染对**——CSS 模块没加载、令牌拼错、
  被更高特异性规则覆盖，静态检查都看不见，2026-11-17 的 720px 漏网就是这样抓到的。

---

## 3. 交互延迟预算

| 场景 | 目标 p95 | 说明 |
|---|---|---|
| 编辑输入回显 | ≤ 50ms | keydown → 下一帧文本可见 |
| 命令面板 / 菜单打开 | ≤ 100ms | 触发到首帧 |
| 页面/标签切换 | ≤ 150ms | 不含远端数据 |
| 面板拖拽 | ≥ 55fps | 拖拽期间不掉帧 |

采集：`npm run budget:collect`（需 dev server），或 dev 控制台 `copy(JSON.stringify(window.__ncInteraction.snapshot()))`。
对比：`node scripts/interaction-budget.mjs --from=<file>`。
**不设 CI 硬阈值**——延迟依机器而异，拿来卡 CI 只会逼人调阈值。超预算在本地表格里标红即可。

---

## 4. 键盘与命令

- 每个用户可触发的动作必须注册进 `lib/commandRegistry.ts`，并出现在命令面板。
- 动作出现的地方（菜单、按钮 tooltip、面板行）就地显示快捷键，不只在"快捷键"弹窗里列。
- 新增快捷键前先查 `lib/keymap.ts` 冲突；冲突不允许"后者覆盖"，必须换键。
- 危险动作（删除、覆盖写、强退）不进默认快捷键。

校验：`node scripts/palette-coverage.mjs`（P1 建立，输出未注册动作清单）。

---

## 5. 已知偏差（技术债台账，只允许缩小）

| 项 | 现状 | 目标 |
|---|---|---|
| `rounded` 与 `rounded-md` 圆角不一致 | **已统一**（2026-11-17）：`index.css:79` 的 `--radius` 从恒 `0.375rem` 改为 `var(--r-control)`，四类（`rounded`/`-md`/`-lg` 及 `notice.tsx` 的 `calc`）现在同源。实测 2 外观档 × 3 密度档 6 组全为 8px；红灯验证（退回 6px）6/6 组精确报不一致 | 保持。⚠️ `:root` 的 `--radius: 0.375rem` **保留不删**：`notice.tsx:59,207` 用 `calc(var(--radius)+2px/3px)` 做相对表达 |
| 裸色值 | **0 处**（2026-11-16 清零，基线置空） | 保持 0，新增即红 |
| `--r-{shell,pane,work,inset}` | 仅 material 档有意义 | 保持，但文档化（已在矩阵区） |
| 弹层宽度 | **已收敛**（2026-11-17）：迁移前 16 种宽度、四套体系，现统一取 `--w-modal-*` 六档 | 保持，`tokens:check` 强制；新增弹层只挑档位 |
| `InfoPopover` | ~~零引用~~ 🔴 **2026-11-17 复核：判定错误，有 3 处真实引用，删了会坏**。`SettingsRow.tsx:3,68` 与 `ToggleRow.tsx:4,63` 都 import 并渲染（`info` 属性走它）；`App.tsx:299` 的注释还依赖它「非模态 `role=dialog`」这一特性 | **撤销「删除」目标，保持**。它是非模态浮层，`Modal` 不能替代 |
| 弹层组件关系 | `Modal` 是唯一原语；`Dialog` 只是它的 sm 档预设（曾误标为「两代并存」） | 保持；`Menu` 无替代实现，同样保持 |
| 空/载/错三态 | **已全绿**（2026-11-17 实跑 `npm run states:audit`：「所有含数据请求的组件都具备空/载/错三态」，0 候选） | 保持；新增数据请求组件必须同时给三态 |
| 视觉基线 | **已生成**（2026-11-17，`24e07d2`）：`visual-baseline/` 六张 PNG（classic 三档 + glass 明暗） | 保持；改几何/密度后复跑比对 |

---

## 6. 提 PR 前的六问

1. 新增尺寸/颜色是令牌引用，还是又写了一个字面值？
2. 三档密度下都看过了吗？`compact` 有没有溢出、截断、图标压字？
3. 这个动效表达了什么？关掉它用户会不会困惑？关不掉就说明它是装饰。
4. 空 / 载 / 错三态都在吗？错态给了可执行的下一步吗？
5. 这个动作能纯键盘完成吗？快捷键在界面上看得到吗？
6. 如果这里失败了，界面会显示成"成功"吗？
