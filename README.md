# NCForge

可复用的 **Tauri 2 桌面应用壳子**：从生产项目 cc-bridge 抽离的完整桌面应用脚手架。
复制一份、跑一条改名命令，10 分钟内得到一个能跑、能自动更新、UI 成体系的 Hello World 桌面应用。

**包含三层资产**：

| 层 | 内容 | 关键位置 |
|----|------|---------|
| 🎨 UI 风格架构 | 设计 token（浅/深双主题 + classic/glass 双材质）+ 30+ 基础组件 + layout 壳 + 动效体系（三档时长/统一 easing/减弱动效守卫） | `desktop/src/index.css` `desktop/src/components/ui/` `layout/` |
| ⚙️ 技术架构 | App 骨架 + 托盘/单实例/窗口销毁重建/DWM 圆角 + 命令分层 + 路径白名单安全原语 + JSON 配置持久化 | `desktop/src/App.tsx` `desktop/src-tauri/src/main.rs` `commands/` `security/` |
| 🔄 软件更新架构 | 单飞闸 + 指数退避 + 错误分类 → 前端状态机 + 可撤销自动重启 → 一键发版 + 跨平台 updater.json 合并 + CI tag 构建 | `desktop/src-tauri/src/commands/update.rs` `desktop/src/contexts/UpdateContext.tsx` `desktop/scripts/release.mjs` |

不包含任何业务代码（MCP / SSH / 对话 GUI / 防火墙等）——那些在你的应用里按需加。

设计文档见 [`docs/桌面应用壳子抽离方案-2026-10-26.md`](docs/桌面应用壳子抽离方案-2026-10-26.md)；
工程纪律（版本真源、发版流程、体量门禁、性能检查项）见 [`CLAUDE.md`](CLAUDE.md)。

---

## 快速开始（复制即用，5 步）

```bash
# 0. 前置：Node 22+、Rust stable、Tauri 2 系统依赖（Windows 需 WebView2 + VS C++ Build Tools）
#    https://tauri.app/start/prerequisites/

# 1. 复制壳子（整目录拷贝，保留 git 仓库历史可选）
cp -r desktop-app-shell my-app && cd my-app/desktop

# 2. 一键改名：产品标识一次改齐（Cargo 包名/exe 名、Rust crate 名、tauri.conf、
#    package.json、branding.rs 托盘文案、about.ts、HTML 标题、CI 产物名……）
#    漏改的典型症状：托盘 tooltip 还叫 MyApp、CI 找不到 exe、updater 404、
#    Rust 编译直接 E0432（包名一改 crate 名就从 desktop_app_shell 变了）
node scripts/rename-app.mjs my-tool --repo your-name/my-tool --display "我的工具"

# 3. 换图标（现在用的是壳子占位图）
#    desktop/src-tauri/icons/ —— 至少替换 icon.ico / icon.png / 128x128.png / icon.icns
#    可用 `npx tauri icon your-logo.png` 从一张图生成全套

# 4. 生成更新签名密钥对（自动更新的命脉，每个应用必须自己签）
#    ⚠️ 壳子自带的是一个一次性测试公钥（仅供开箱即用的 cargo test 与本地联调），
#    上线前必须按此步骤换成自己生成的——
npx tauri signer generate -w ~/.tauri/my-tool.key
#    公钥   → desktop/src-tauri/tauri.conf.json 的 plugins.updater.pubkey
#    私钥   → GitHub 仓库 Settings → Secrets → TAURI_SIGNING_PRIVATE_KEY（整个文件内容）
#    另：tauri.conf.json 里的 dangerousInsecureTransportProtocol 是本地 http 联调开关，
#    面向 https 源发布前删掉它

# 5. 跑起来
npm install        # ⚠️ 首次安装若报 "Cannot read properties of null (reading 'edgesOut')"
                   # （npm 10.9.x + vitest 4 可选 peer 的已知 bug），加 --legacy-peer-deps 跑一次：
                   #   npm install --legacy-peer-deps
                   # 生成 package-lock.json 之后，npm install / npm ci 均恢复正常
npm run tauri dev
```

`npm run tauri dev` 起来后能看到：左侧导航（home/监控/设置）、顶栏（拖拽区/主题切换/更新状态）、
首页示例（配置读写演示）、设置页（自动开机 + 更新历史弹框）、托盘菜单（打开面板/检查更新/退出）。

## 目录结构

```
desktop-app-shell/
├── CLAUDE.md                  # 工程纪律（AI 协作规则，先读它再改代码）
├── CHANGELOG.md               # Keep a Changelog 唯一手写源（更新弹框内容从这抽）
├── docs/                      # 设计文档
├── design/                    # HTML 设计稿（改 UI 前先出稿）
├── tools/fingerprint.py       # 装机环境指纹（排"我这能跑你那不能"用）
├── .github/workflows/build.yml    # CI：前端门禁 + Rust 测试 + tag 双平台发版
├── .githooks/pre-push          # 7 项本地门禁（启用：git config core.hooksPath .githooks）
└── desktop/
    ├── src/
    │   ├── index.css                # 设计 token 体系（改 UI 先读它）
    │   ├── App.tsx                  # 应用骨架：页面表/Ctrl+1~N/过渡动效
    │   ├── components/
    │   │   ├── ui/                  # 30+ 基础组件（按钮/卡片/开关/弹窗/徽章…）
    │   │   ├── layout/              # Header + SideNav（拖拽区/徽章/更新状态）
    │   │   ├── update/              # 更新 UI 全家桶（徽章/弹框/进度/可撤销重启）
    │   │   └── tabs/                # 示例页：HomeTab / SettingsTab（照抄改）
    │   ├── contexts/UpdateContext.tsx   # 更新状态机 idle→…→ready→重启
    │   ├── hooks/                   # useAppHidden（窗口隐藏停轮询）等
    │   └── lib/                     # 主题/动效/平台/配置 等纯函数
    ├── scripts/                # 发版链（见下）
    └── src-tauri/
        ├── src/main.rs               # 托盘/单实例/窗口生命周期/DWM 圆角
        ├── src/commands/             # system.rs（配置/自启/外部打开）+ update.rs
        ├── src/security/path.rs      # 路径白名单（canonicalize + 祖先遍历）
        └── tauri.conf.json           # 产品标识/updater 端点/NSIS 配置
```

## 常用命令

```bash
cd desktop

npm run tauri dev      # 开发（前端 HMR；改 Rust 需重启）
npm run vite:build     # 只构建前端（tsc + vite）
npm test               # vitest 单测
npm run lint           # eslint（react-hooks 规则是重点）
npm run motion:check   # 真实浏览器动效回归（重型手动项：需 npx playwright install，
                       # 且先起 vite preview 让 motion-preview.html 在 1425 端口可达；
                       # 不进 pre-push 7 项门禁，改 UI 动效时手动跑）

cd src-tauri
cargo clippy --all-targets --no-default-features -- -D warnings
cargo test  --no-default-features     # 16 单测 + tests/update_flow.rs 集成测试
                                     # （本地假源无头跑通「检查→下载→验签失败」；
                                     #   曾经的 0xc0000139 已由 build.rs 补嵌 manifest 修复）

cd desktop && npm run release -- --patch    # 发版（tag，见 CLAUDE.md「发版流程」）
```

## 版本历史

`npm run release` 会自动在表头插入新版本行（此表缺失时发版会明确报错中止）。
更新弹窗里的详细内容来自 `CHANGELOG.md`，这里只留一行摘要。

| 版本 | 摘要 |
| ---- | ---- |
| v0.1.0 | 壳子基线：Tauri 2 技术架构 + 自动更新闭环 + 设计系统三层资产 |

## 更新架构怎么工作

```
用户点「检查更新」
  → Rust commands/update.rs：单飞闸（并发只放一个）+ endpoints 多源按序回退
      + 指数退避重试 + classify_update_error 错误分类码 + update:* 事件
  → 前端 UpdateContext：idle→checking→available→downloading→ready→error/uptodate
  → 用户点「重启安装」：8 秒可撤销倒计时 → tauri-plugin-process 重启
  → 发版时：npm run release → tag → CI build-macos → build-windows
      → generate-updater-json.mjs 跨平台合并 → updater.json 附到 Release
      → 客户端下次启动时读到新版本
```

本地联调更新链路（不发版也能验证）：

```bash
# 终端 1：起一个假的更新服务器（serve 当前 dist 的产物 + updater.json）
node desktop/scripts/fake-update-server.mjs --dir desktop/src-tauri/target/release/bundle/nsis

# 终端 2：把 dev 应用的更新端点指到假服务器
APP_UPDATE_ENDPOINT=http://127.0.0.1:8787/updater.json npm run tauri dev
```

## 换平台/换技术栈前的自检

- **引新依赖前**：先评估二进制体积增量（红线：程序本体 NSIS ≤ 15MB（不含随包资源，如 jdt.ls），壳子现状约 3.2MB）。
- **加后台循环前**：过一遍 CLAUDE.md §8.1 六条检查项（让出点/生产端异常/流结束信号/单轮成本/兜底上限/平台分支验证）。
- **改 UI 前**：先读 `src/index.css` token 与真实组件源码，再出 HTML 设计稿（`design/`），确认后落代码。
- **提交前**：pre-push 钩子跑 7 项门禁（体量/eslint/tsc/vitest/fmt/clippy/test），不要手动起独立 cargo test 抢锁。

## 从 cc-bridge 抽离时保留的关键经验

- 关窗**销毁** webview 省约 80MB 内存（`release_webview_on_close`），靠托盘重生；退出用 `ExitRequested{code:None}` 拦截。
- 窗口不可见时**必须**停轮询：`useAppHidden` + `refetchInterval: false`。
- updater.json **跨平台合并**（`UPDATER_MERGE_INTO`）：两个平台各产片段，Windows 侧统一合并——防互覆。
- Gitee 镜像失败不能静默：push 后必须回头验证客户端实际读的 raw 地址且版本号匹配（cc-bridge v2.4.0~v2.5.0 四个版本绿灯但镜像 404 的教训）。
- 组件体量红线（300 行 + 8 个状态）由 `check-component-size.mjs` 机器执行，棘轮式管理存量。

## 许可

MIT（LICENSE）
