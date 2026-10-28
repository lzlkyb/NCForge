# NCForge 项目开发规则

> 可复用的 Tauri 2 桌面应用壳子：技术架构（托盘/单实例/窗口生命周期）+ 软件更新架构
> （签名/多源回退/updater.json 合并）+ UI 风格架构（设计 token + 组件库 + 动效体系）。
> 规则从 cc-bridge 移植，剔除业务专属条目，保留全部工程纪律。

## 0. 先读这里：三层架构与复制即用

本仓库**不是应用，是壳子**。任何具体应用都从这里复制一份再改：

```bash
# 复制壳子 → 一键改名（十余处产品标识一次改齐）→ 换图标 → 生成签名密钥 → 开发
cp -r desktop-app-shell my-app && cd my-app/desktop
node scripts/rename-app.mjs my-tool --repo your-name/my-tool --display "我的工具"
```

三层资产与边界（详见 `docs/桌面应用壳子抽离方案-2026-10-26.md`）：

| 层 | 资产 | 位置 |
|----|------|------|
| UI 风格 | 设计 token + 30+ ui 组件 + layout 壳 + 动效体系 | `src/index.css` `src/components/ui/` `src/components/layout/` `src/lib/motion.ts` |
| 技术架构 | App 骨架 + 托盘/单实例/窗口销毁重建/DWM 圆角 + 命令分层 + 安全原语 | `src/App.tsx` `src-tauri/src/main.rs` `src-tauri/src/commands/` `security/` |
| 更新架构 | 单飞闸+退避重试+错误分类 → 前端状态机 → 一键发版链 | `src-tauri/src/commands/update.rs` `src/contexts/UpdateContext.tsx` `src/components/update/` `scripts/release.mjs` `scripts/generate-updater-json.mjs` |

**不抽什么**：任何业务代码（MCP/SSH/对话 GUI/防火墙/备份等）。新功能一律在复制出的
仓库里加，壳子只接受**通用架构改进**的回流。

## 1. 先出方案再动手

修改代码前先出方案让用户确认，涉及取舍时提供 2-3 个方案对比（含优缺点），让用户选择。复杂任务先进 Plan Mode 规划再执行。

## 2. 版本号只有一个真源：Cargo.toml

- **真源**：`desktop/src-tauri/Cargo.toml` 的 `version`。
- `desktop/src-tauri/tauri.conf.json` 与 `desktop/package.json` 的 `version` 由 `desktop/scripts/sync-version.mjs` 在 `predev` / `prebuild` 自动同步，**禁止手改这两处**——手改会被脚本覆盖，还会造成"改了这两处就齐了"的错觉。
- **发版只走 `npm run release`**（见「发版流程」），它 bump 真源一处并触发同步。

**不要因为改了代码就跳版本号**。日常改动（bug 修复、加小功能）：不动任何版本文件，只把变更条目追加到 `CHANGELOG.md` 顶部的 `## [Unreleased]` 分区（按 新增/变更/修复 分类）。

**什么时候才递增版本号**：仅当用户明确说 **"tag"** 或 **"打tag"** 时。在这之前，无论经历多少次修复/新增功能，版本文件都保持原样不动。

## 3. 构建 exe / 安装包前要询问用户

用户确认后才在 `desktop/` 目录执行 `npm run build`（= `tauri build`，产出 `<app-name>.exe` + NSIS 安装包）。构建前先结束占用进程（`taskkill //F //IM <app-name>.exe`）。

## 4. 改动 UI 要先出 HTML 设计稿

涉及界面变更时，先生成 HTML 设计稿让用户确认效果，再改代码。设计稿放 `design/`（见规则 13）。

## 5. 等用户说「提交」再 commit

不要自动 `git commit`。等用户明确说"提交"或"commit"再操作。CI 分支为 `main`。

## 6. 预览测试用 Tauri dev 后台运行

在 `desktop/` 目录下启动，独立窗口后台运行，支持 Vite HMR 热更新，不阻塞主终端：

```powershell
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd desktop; npm run dev" -WindowStyle Minimized
```

🔴 **跑 dev 前先确认没有同 identifier 的已安装版本在跑**：`tauri-plugin-single-instance` 无条件注册，安装版持锁会让 dev 秒退。启动失败先查这个，不是配置问题。

## 7. 方案设计需考虑代码架构

模块化、可维护性、扩展性，遵循已有的分层架构：

- **Rust 命令分层**（`src-tauri/src/commands/`）：`mod.rs` 只做 `pub mod` + `pub use` 汇总，具体命令按域拆文件（`system.rs` / `update.rs`）。新增命令三处：写函数 → `pub mod` → `pub use` + `main.rs` 的 `invoke_handler` 注册（三处都有注释标出）。
- **前端公共纯函数统一放 `lib/`**，按主题分文件（`utils.ts` 已 500+ 行且不在体量门禁扫描范围，**不要再往里堆**，新建主题文件）。

**前端组件体量限制**（硬性规则，**已由机器执行**）：

门禁在 `desktop/scripts/check-component-size.mjs`，跑在 pre-push 钩子与 CI 的 frontend job 里。两个指标，扫 `src/components/**` 与 `src/hooks/**`：

- **行数 ≤ 300**，且**同时管 `.tsx` 与 `.ts`**（只管 `.tsx` 会让复杂度搬家到 hooks 里躲计数器）。
- **单文件里 `useState` + `useEffect` 总数 ≤ 8**（比行数准：100 行 JSX 与 100 行异步状态逻辑的阅读成本差一个数量级）。

存量超标记在脚本里的 `BASELINE`，采用**棘轮**：存量文件只允许变小不允许变大，新文件必须直接合规；改小了脚本会提醒把基线跟着调低。

**ESLint**（`desktop/eslint.config.mjs`）：为 `react-hooks` 两条规则（`rules-of-hooks` / `exhaustive-deps`）而上——依赖数组不全导致的"闭包拿陈旧值" tsc 完全看不出来。壳子基线**零豁免**；若确需存量豁免，用 `eslint . --suppress-all` 生成 `eslint-suppressions.json`（棘轮，只许减少），修好后跑 `npm run lint:prune` 收紧。

**Rust 后端规则**——提交前在 `desktop/src-tauri/` 跑这三条，保持零警告：

```bash
cargo fmt --check
cargo clippy --all-targets --no-default-features -- -D warnings
cargo test --no-default-features     # 含 tests/update_flow.rs：本地假源无头跑通更新链路
```

`--no-default-features` 与 `--all-targets` 不是可选项。三项都已进 pre-push 钩子，不靠记性。

**Windows 测试二进制 0xc0000139 的根因与修复**（2026-10-27 定位，改 build.rs 前必读）：mock 应用集成测试会把 wry 运行时的原生对话框代码链进测试二进制，导入表含 `comctl32.dll!TaskDialogIndirect`（仅 comctl32 v6 有）。tauri-build 只给 **bin** 目标嵌 Common-Controls v6 manifest，测试目标拿不到 ⇒ 加载器给 comctl32 v5 ⇒ 进程启动即 STATUS_ENTRYPOINT_NOT_FOUND。`build.rs` 用 `embed_resource::compile_for_tests` 给测试目标补嵌了同款 manifest；且该指令**只作用于 `tests/` 集成测试目标**，不覆盖 `cargo test --lib`——所以构建 mock 应用的测试必须放 `tests/` 下，不能放 `#[cfg(test)] mod tests`。

**安全模块不得放松**：路径白名单校验（`security/path.rs` 的 `canonicalize` + 祖先遍历）任何改动都不能削弱，且要保留被拒时附带白名单的错误提示。

## 8. 方案设计需考虑性能

内存占用、二进制体积（体积预算红线：**程序本体** NSIS ≤ 15MB，不含随包外部资源；壳子实测约 3.2MB，引依赖前先评估增量。随包资源（放 `src-tauri/resources/`，如 jdt.ls 0.57.0 约 53.5MB）单独计，整包预计约 75MB）、前端加载速度、轮询频率（窗口不可见时必须停轮询，统一用 `useAppHidden` + `refetchInterval: false`，不要自己起 `setInterval` 轮询）。

### 8.1 常驻循环 / 后台任务的硬性检查项（每新增一个就过一遍）

新增或修改任何 `loop` / 周期任务 / 事件消费循环时，**逐条回答**：

1. **让出点在哪里？** 必须能指出 `sleep` / `interval().tick()` / 阻塞系统调用 / 有界的 IO 其中一个。"循环里有 `.await`" **不算**——`await` 一个立即完成的 future 等于没让出。
2. **如果生产端异常，这个循环会变成什么？** 把"通道关闭 / 返回错误 / 立即返回"当成**必然会发生**的情形去推一遍。
3. **"流已结束"的信号有没有被处理？** 禁止 `let _ = rx.recv().await`。`None` / `Err` / `Ok(None)` 必须显式分支。特别注意：`timeout(d, fut).await.is_ok()` 对**已关闭的通道是 `Ok(None)` → `is_ok()` 为真**。
4. **每轮的单次成本是多少？** 频率 × 单次成本要能口头算出来。
5. **有没有兜底上限？** 吸收/重试/合并类循环必须有 `MAX_*` 或退避，使"生产端发疯"时最坏退化成固定频率。
6. **平台分支那一半怎么验？** 写了 `cfg(not(windows))` 就必须回答它在 mac 上的行为靠什么保证（CI 测试 / 代码契约注释 / 真机）——**不能靠"看着对"**。

### 8.2 空实现（no-op）必须写明对调用方的契约

接过一个资源然后什么都不做的空实现，代价不在它自己那一行，而在别的文件里。空实现处**必须写注释说明调用方需要怎么处理**，并优先还回"同步返回值"而不是"默默吃掉资源"。

## 9. 方案设计需考虑用户体验

交互流畅度、反馈及时性、边界状态（加载中 / 空状态 / 错误）。白名单为空、连接失败等场景要有明确引导，不让用户盲猜。

## 10. 前端改动不用重启 dev，Rust 改动必须重启

`tauri dev` 运行中，前端改动 Vite HMR 自动热更新；**改动 Rust 后端（`src-tauri/`）HMR 不生效**，须重启 dev 或重新 build。

## 11. 改动 UI 前必须读取真实组件源码

生成 HTML 设计稿前，先读相关 `.tsx` 与样式（`index.css` / TailwindCSS 变量）源码，设计稿的样式、结构、图标、文案必须与真实代码一致，不得凭空自创。

## 12. 文件存放目录与命名规范

| 文件类型 | 存放目录 |
|---------|---------|
| `.md` 文档 | `docs/` |
| `.html` 设计稿 | `design/` |

（README.md 保留在项目根。）

**命名一律用中文**：文件名主体用简体中文描述主题，禁止英文短语、蛇形拼接；日期后缀 `-YYYY-MM-DD` 放末尾；同类多稿用 `-方案A` / `-v2` 区分。允许出现的 ASCII 仅限：日期数字、`vN` 版本后缀、已进入中文技术语境的缩写（`MCP` `UI` `AI` `bug` 等）。

## 13. 换行符统一为 LF

根目录 `.gitattributes`：`* text=auto eol=lf`（二进制显式 `binary` 保护）。提交或新增文本文件保持 LF 写入。不要改回 CRLF 方向。

## 14. 提交前必须审查一遍本次改动有无 bug

用户说「提交 / commit」后，**先不要直接 `git add`**。按顺序执行：

1. **逐文件审 diff**（`git diff` + 新增文件通读），重点查：逻辑错误、边界条件（空值/越界/极端输入）、安全问题（凭据泄漏、路径/注入）、遗漏的接线点（改了 A 却没改调用方）、与既有约定的冲突。
2. **有问题当场修复**，修复后重跑受影响的门禁（cargo fmt/clippy/test + eslint/tsc/vitest/体量棘轮），再进入提交流程。
3. **确认无问题才提交**；审查发现但「决定不修」的点，须在 commit message 或回复里向用户说明。
4. 工作区混有并行会话改动时，按批次归属分开处理，只审查并提交本批文件，绝不 `git add -A`。

---

## 发版流程

当用户说 **"tag"** / **"打tag"** 时，走 `npm run release`，**不要手抄步骤**：

```bash
cd desktop && npm run release -- --patch      # 或 --minor / --major / version X.Y.Z
```

`desktop/scripts/release.mjs` 一条命令完成：bump `Cargo.toml` 真源 → 同步另两处版本 → 在 `CHANGELOG.md` 顶部插版本段（`git log` 自动分类出草稿 + 交互填「更新摘要」）→ commit → push main → tag → push tag。

**跑之前必读（这四件事脚本替你做不了，顺序错了要返工）：**

1. **功能代码先单独 commit**——`release` 只 `git add` 元数据文件（版本三件套 + `Cargo.lock` + CHANGELOG + README + `changelog.generated.ts`，精确清单见 `release.mjs` 的 `const files`），**不含任何功能代码**。
2. **发版前停 dev**——钩子要跑两次 cargo，dev 占着 `target/` 锁会让门禁失败。
3. 🔴 **非 TTY（AI 执行）改不了摘要**：不交互时脚本只准备到 commit、不 push/tag（防误发）。要在 tag 前精修摘要，必须走：`release`（只 commit）→ 手改摘要 → `node scripts/gen-changelog.mjs` → `git commit --amend --no-edit` → push main → `git tag vX.Y.Z` → push tag。顺序反了摘要就冻在 tag 里。
4. 拿不准时先 `npm run release -- --patch --dry-run`：只打印将要做什么，不动任何文件。

**CHANGELOG 结构（CI 与脚本都依赖）**：版本段顶部先写 `### 更新摘要`（一句话人话，会渲成更新弹框顶部高亮卡片；禁止代码符号/根因），再按 `### 新增` / `### 修复` / `### 变更` / `### 优化` / `### 安全` 写 1~3 条用户能看懂的点；`### 技术细节` / `### 实现说明` / `### 开发者` 小节不进弹框（`build.yml` 正则会剔除）。

> CI 说明：main push 跑 `frontend`（体量/eslint/tsc/vitest/vite build）、Windows `test`、macOS `check`；**tag 时 `test` job 被 `if` 跳过**，改由 `build-macos` → `build-windows` 串联，Windows 内先 `cargo test --release` 再打包。tag 前确认测试可过。

> ⚠️ **pre-push 钩子会自己跑全部门禁，push 前不要手动起独立 `cargo test`**。当前 **7 项**，顺序按"失败越快越靠前"排：组件体量 → `cargo fmt --check` → `eslint` → `tsc --noEmit` → `vitest` → `cargo clippy` → `cargo test`。**清单以 `.githooks/pre-push` 的实际输出为准，本节不维护它。**
>
> 🔴 改完 `.githooks/pre-push` 必须重新启用。推荐 `git config core.hooksPath .githooks`（免复制、自动同步，本仓库入库即带可执行位）；若用传统 `cp` 方式，记得 `chmod +x`——没有可执行位的钩子会被 git 静默跳过，一项门禁都不跑。

### Commit 前缀规范

| 前缀 | 分类 | 示例 |
|------|------|------|
| `feat:` | ✨ 新功能 | `feat: 新增导出配置命令` |
| `chg:` / `change:` | 🔄 变更 | `chg: 更新端点改为多源回退` |
| `fix:` | 🐛 修复 | `fix: 修复托盘菜单重启后不刷新` |
| `refactor:` | 🔧 重构 | `refactor: 拆分 ConnectTab` |
| `docs:` | 📖 文档 | `docs: 更新 README 快速开始` |

## 附：更新架构关键决策（改动前必读）

- **单飞闸（SingleFlight）**：`commands/update.rs` 同一时刻只允许一个检查，重复调用直接返回进行中的状态——防止用户连点出多个下载。
- **多源回退**：`tauri.conf.json` 的 endpoints 数组按序尝试，配了 `APP_GITEE_REPOSITORY` env 才启用 Gitee 候选组（没配镜像时第一候选必然 404，每次检查白等一轮退避）。
- **updater.json 跨平台合并**：mac 与 Windows 两个 job 各产平台片段，由 build-windows 用 `UPDATER_MERGE_INTO` 合并成完整 updater.json——**防止两个平台互相覆盖**。改动发版链时先读 `scripts/generate-updater-json.mjs` 头部注释。
- **密钥必须自签**：每个新应用必须自己 `tauri signer generate`，公钥进 `tauri.conf.json` 的 `plugins.updater.pubkey`，私钥进 GitHub secret `TAURI_SIGNING_PRIVATE_KEY`。**复制壳子的密钥对是发不了版的**（验签必失败）。
