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

| 档位 | 适用 | 控件高 `--h-control` | 图标位 `--h-icon` | 行高基线 |
|---|---|---|---|---|
| `compact` | 小屏、多编辑器组、网格/日志并排 | 26px | 24px | 22px |
| `standard`（默认） | 常规 | 32px | 28px | 26px |
| `comfortable` | 大屏、演示、触摸 | 32px | 32px | 30px |

触屏（`pointer: coarse`）强制 ≥ 40px，覆盖上表。
**新增尺寸一律写成 `var(--h-control)` 之类的令牌引用**，不写死像素。
虚拟列表（结果网格、日志、文件树）必须在密度变化事件里重算行几何——
`lib/uiDensity.ts` 提供 `subscribeUiDensity`，不订阅就会出现"行高变了但滚动位置错位"。

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
- "加载中" 不得掩盖失败；空态、载态、错态必须是三个独立实现（见 `components/ui/{EmptyState,LoadingState,ErrorBoundary}`）。
- 未写回的编辑必须在关闭 / 切换 / 续取前显式确认，不允许静默丢弃
  （历史教训见 `docs/NCForge-数据库UI-UX审查-2026-11-10.md` S1 系列）。

---

## 2. 令牌三层

| 层 | 前缀 | 谁可以定义 | 谁可以消费 | 例子 |
|---|---|---|---|---|
| primitive 原语 | `--r-*` `--h-*` `--gap-*` `--dur-*` `--ease-*` `--fs-*` `--lh-*` | 只有 `index.css` 的矩阵区/动效区 | semantic、component 层 | `--r-card` `--dur-fast` |
| semantic 语义 | `--background` `--foreground` `--primary` `--border` … 及派生 `--color-*` | `index.css`（`:root` 与 `.dark` 成对） | 任何地方 | `--color-primary` |
| component 组件 | `--forge-*` `--material-*` `--dbx-*` `--sh-*` `--badge-*` `--chart-*` `--window-*` | 所属组件/材质文件 | 本组件域内 | `--forge-control` |

规则：
- **语义色必须在 `:root` 与 `.dark` 成对出现**，只写一边等于让另一主题瞎掉。
- 组件层令牌不得被页面 CSS 重新定义（页面只能换 `data-*` 档位）。
- 新增 component 令牌优先写成对 primitive / semantic 的引用（`--forge-radius: var(--r-control)`），
  而不是再写一个字面值。

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
| `rounded` 用 `--radius`(6px)，`rounded-md` 用 `--r-control`(8px) | 两者不一致 | 统一到 `--r-control`，随档位变化 |
| 裸色值 | **0 处**（2026-11-16 清零，基线置空） | 保持 0，新增即红 |
| `--r-{shell,pane,work,inset}` | 仅 material 档有意义 | 保持，但文档化（已在矩阵区） |
| 两代弹层组件 | `Modal` 仍被 54 个文件导入；`Menu` **没有**替代实现；`InfoPopover` 零引用 | `Modal` 逐批迁到 `dialog`（棘轮只降不升）；`InfoPopover` 删除；`Menu` 保持为唯一实现 |

---

## 6. 提 PR 前的六问

1. 新增尺寸/颜色是令牌引用，还是又写了一个字面值？
2. 三档密度下都看过了吗？`compact` 有没有溢出、截断、图标压字？
3. 这个动效表达了什么？关掉它用户会不会困惑？关不掉就说明它是装饰。
4. 空 / 载 / 错三态都在吗？错态给了可执行的下一步吗？
5. 这个动作能纯键盘完成吗？快捷键在界面上看得到吗？
6. 如果这里失败了，界面会显示成"成功"吗？
