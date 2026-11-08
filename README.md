# NCForge

**NC65 / NCC 二开的轻量桌面工作台** —— 替代 Eclipse / UAP Studio 的本地开发工具。

![Release](https://img.shields.io/github/v/release/lzlkyb/NCForge?label=%E6%9C%80%E6%96%B0%E7%89%88)
![License](https://img.shields.io/github/license/lzlkyb/NCForge)
![Platform](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%2010%2B-blue)
![Built with](https://img.shields.io/badge/Tauri%202%20%2B%20React%20%2B%20Rust-orange)

NCForge 把 NC 二开每天要做的事收进一个约 15MB 的原生窗口：代码浏览与搜索、按模块自动编译、
连库查数据、改元数据、打补丁、起 NC 服务、翻日志。Tauri 2 + React + Rust，
大部分能力不依赖 NC 安装目录（数据库、日志、反编译开箱即用）。

## 下载安装

- **Windows**：从 [Releases](https://github.com/lzlkyb/NCForge/releases/latest) 下载 NSIS 安装包；
  国内网络走 [Gitee 镜像](https://gitee.com/lzul/NCForge)。
- 应用内置自动更新（GitHub 优先、Gitee 兜底），装一次之后新版本在应用里点「检查更新」即可。
- 安装包只含本体；Java 语言服务（jdt.ls）、编译器（ecj）、SVN、反编译器（cfr）等随包资源
  在**首次用到时**自动下载到本地配置目录，不联网的功能不受影响。

## 功能面

| 模块 | 能做什么 |
|------|---------|
| 📝 代码工作台 | Monaco 编辑器（Java 语义高亮 / 补全 / 面包屑）、文件树 + 包视图（类 / 接口 / 成员图标）、快速导航（文件 `Ctrl+Shift+R` / 类型 / 符号 / 命令，`#` 全文边扫边出）、全工程搜索替换、双编辑器组布局 |
| ⚡ 编译与反编译 | 按模块自动编译（ecj 增量，保存即编译）、编译问题按模块归因（未编译 / 失效产物 / 跳过）、jar 内类一键反编译（CFR） |
| 🗄️ 数据库 | 纯 Rust Oracle 驱动（不需要 NC home，JVM 桥兜底 REF CURSOR 等场景）、手动 / 自动提交事务、导入导出（CSV / XLSX / INSERT / Markdown…）、数据字典（NC 中文名）、默认 schema 切换 |
| 🧬 元数据（BMF） | 模型 / 字段表 / 属性检查器联动编辑、业务接口与关系语义校验、生成中心：一次生成 Java 源码（VO / 聚合 VO / 枚举 / 接口 / 测试）、多数据库建表脚本与注册清单 |
| 🚀 NC 服务与控制台 | 「开始开发」一条龙（编译 → 投送 → 启动中间件 → 等客户端真正连上 → 可选调试附加）、控制台查找 / 异常分组 / 源码定位 / 虚拟阅读 |
| 📜 日志排查 | NC 日志按 `$$` 段解析（一个 logger 一个文件）、`callid` 即 traceId 全链路定位、慢 SQL 自带耗时、时间 / 级别过滤 |
| 📦 补丁与版本控制 | 补丁打包落位预览与编译状态、SVN 工作台 |
| 🔄 自我更新 | 单飞闸 + 错误分类 + 可撤销重启的自动更新闭环，发版一条命令走完 CI 打包与双源分发 |

**三层技术资产**（二次开发 / 复用时最值钱的部分）：

| 层 | 内容 | 关键位置 |
|----|------|---------|
| 🎨 UI 风格架构 | 设计 token（浅/深双主题 + classic/glass 双材质）+ 30+ 基础组件 + layout 壳 + 动效体系（三档时长/统一 easing/减弱动效守卫） | `desktop/src/index.css` `desktop/src/components/ui/` `layout/` |
| ⚙️ 技术架构 | App 骨架 + 托盘/单实例/窗口销毁重建/DWM 圆角 + 命令分层 + 路径白名单安全原语 + JSON 配置持久化 | `desktop/src/App.tsx` `desktop/src-tauri/src/main.rs` `commands/` `security/` |
| 🔄 软件更新架构 | 单飞闸 + 指数退避 + 错误分类 → 前端状态机 + 可撤销自动重启 → 一键发版 + 跨平台 updater.json 合并 + CI tag 构建 | `desktop/src-tauri/src/commands/update.rs` `desktop/src/contexts/UpdateContext.tsx` `desktop/scripts/release.mjs` |

## 快速开始（开发）

```bash
# 0. 前置：Node 22+、Rust stable、Tauri 2 系统依赖
#    （Windows 需 WebView2 + VS C++ Build Tools）https://tauri.app/start/prerequisites/

# 1. 取代码并进入前端目录
git clone https://github.com/lzlkyb/NCForge.git && cd NCForge/desktop

# 2. 安装依赖
npm install        # ⚠️ 首次安装若报 "Cannot read properties of null (reading 'edgesOut')"
                   # （npm 10.9.x + vitest 4 可选 peer 的已知 bug），加 --legacy-peer-deps 跑一次；
                   # 生成 package-lock.json 之后恢复正常

# 3. 跑起来
npm run tauri dev
```

起来后是代码 / 版本控制 / 数据库 / 日志排查 / 元数据 / 设置的侧栏工作台：
`Ctrl+1~6` 直达，`Ctrl+B` 收展侧栏，`Ctrl+J` 底部面板，`Ctrl+Shift+R` 快速导航。

### 发布前准备（fork 自用的人看这里）

```bash
# 换图标：至少替换 desktop/src-tauri/icons/ 下的 icon.ico / icon.png / 128x128.png / icon.icns
# 可用 `npx tauri icon your-logo.png` 从一张图生成全套

# 生成更新签名密钥对（自动更新的命脉，每个发布者必须自己签）
npx tauri signer generate -w ~/.tauri/ncforge.key
# 公钥 → desktop/src-tauri/tauri.conf.json 的 plugins.updater.pubkey
# 私钥 → GitHub 仓库 Settings → Secrets → TAURI_SIGNING_PRIVATE_KEY（整个文件内容）
# 另：tauri.conf.json 里的 dangerousInsecureTransportProtocol 是本地 http 联调开关，
# 面向 https 源发布前删掉它
```

## 目录结构

```
NCForge/
├── CLAUDE.md                  # 工程纪律（AI 协作规则，先读它再改代码）
├── CHANGELOG.md               # Keep a Changelog 唯一手写源（更新弹窗内容从这抽）
├── docs/                      # 设计与调研文档快照
├── design/                    # HTML 设计稿（改 UI 前先出稿）
├── tools/fingerprint.py       # 装机环境指纹（排"我这能跑你那不能"用）
├── .github/workflows/build.yml    # CI：门禁（--only 单项）+ tag 双平台发版
├── .githooks/                 # pre-commit（30s 内三项）+ pre-push（全量门禁）
└── desktop/
    ├── src/
    │   ├── index.css                # 设计 token 体系（改 UI 先读它）
    │   ├── App.tsx                  # 应用骨架：页面表/Ctrl+1~N/过渡动效
    │   ├── components/
    │   │   ├── ui/                  # 30+ 基础组件（按钮/卡片/开关/弹窗/徽章…）
    │   │   ├── tabs/                # 文件/数据库/元数据/服务等工作台页签
    │   │   ├── workspace/           # 编辑器区、快速导航、搜索页
    │   │   └── update/              # 更新 UI（徽章/弹框/进度/可撤销重启）
    │   ├── hooks/                   # 会话/树加载/面板查询等编排 hooks
    │   └── lib/                     # 主题/动效/平台/配置/搜索 等纯函数
    ├── scripts/                     # 发版链 + 门禁单一真源 gate-plan.mjs
    └── src-tauri/
        ├── src/main.rs              # 托盘/单实例/窗口生命周期/DWM 圆角
        ├── src/commands/            # 按域拆分（40 文件 / 229 条命令）：db/bmf/compile/deploy/nc_log…
        ├── src/security/path.rs     # 路径白名单（canonicalize + 基准目录重解析点检查）
        └── tauri.conf.json          # 产品标识/updater 端点/NSIS 配置
```

## 常用命令

```bash
cd desktop

npm run tauri dev      # 开发（前端 HMR；改 Rust 需重启）
npm run vite:build     # 只构建前端（tsc + vite）
npm test               # vitest 单测
npm run lint           # eslint（react-hooks 规则是重点）

node scripts/gate.mjs  # 门禁单一入口（15 项）：--list 看清单、--only <id> 跑单项
                       # pre-commit 只跑 token/fmt/tsc 三项（~8s），pre-push 全量，
                       # CI 每步就是 gate.mjs --only <id>，三者同源不漂移

cd src-tauri
cargo clippy --all-targets --no-default-features -- -D warnings
cargo test  --no-default-features     # 900+ 单测 + 更新链路集成测试
                                     # （本地假源无头跑通「检查→下载→验签失败」）

cd desktop && npm run release -- --patch    # 发版：改版本 → CHANGELOG → README → tag → CI
```

## 版本历史

`npm run release` 会自动在表头插入新版本行（此表缺失时发版会明确报错中止）。
更新弹窗里的详细内容来自 `CHANGELOG.md`，这里只留一行摘要。

| 版本 | 摘要 |
| ---- | ---- |
| v0.2.0 | 数据库不再要求先装 NC：装「数据库 JVM 组件」后 JVM 桥照常可用；macOS 上保存连接口令也不再报错。代码、数据库、元数据与服务页面的布局与操作一并收敛。 |
| v0.1.2 | 标签栏各归其页，侧栏有更新时才出现入口；关于页与 SQL 编辑器一并改进 |
| v0.1.1 | 文件树新增按包浏览：Java 文件一眼看出是类还是接口，展开就能看到成员并跳过去；依赖库单独成组，找类不用再一层层点目录。 |
| v0.1.0 | 壳子基线：Tauri 2 技术架构 + 自动更新闭环 + 设计系统三层资产 |

## 更新架构怎么工作

```
用户点「检查更新」
  → Rust commands/update.rs：单飞闸（并发只放一个）+ endpoints 多源按序回退
      + 指数退避重试 + classify_update_error 错误分类码 + update:* 事件
  → 前端 UpdateContext：idle→checking→available→downloading→ready→error/uptodate
  → 用户点「重启安装」：8 秒可撤销倒计时 → tauri-plugin-process 重启
  → 发版时：npm run release → tag → CI build-windows（build-macos 按需触发）
      → generate-updater-json.mjs 跨平台合并 → updater.json 附到 Release
      → 客户端下次启动时读到新版本（GitHub 优先、Gitee raw 兜底）
```

本地联调更新链路（不发版也能验证）：

```bash
# 终端 1：起一个假的更新服务器（serve 当前 dist 的产物 + updater.json）
node desktop/scripts/fake-update-server.mjs --dir desktop/src-tauri/target/release/bundle/nsis

# 终端 2：把 dev 应用的更新端点指到假服务器
APP_UPDATE_ENDPOINT=http://127.0.0.1:8787/updater.json npm run tauri dev
```

## 工程纪律（摘要）

完整版见 [`CLAUDE.md`](CLAUDE.md)，与贡献者最相关的几条：

- **引新依赖前**先评估二进制体积增量（红线：NSIS 本体 ≤ 15MB，不含随包资源）。
- **加后台循环前**过一遍 CLAUDE.md §8.1 六条检查项（让出点 / 生产端异常 / 流结束信号 / 单轮成本 / 兜底上限 / 平台分支验证）。
- **改 UI 前**先读 `src/index.css` 的 token 与真实组件源码，再出 HTML 设计稿（`design/`），确认后落代码；组件有体量红线（300 行 + 8 个状态），由门禁机器执行、棘轮式管理存量。
- **提交 / 发版**走门禁与 `npm run release`，不手动起 cargo 抢 target 锁；Gitee 镜像只在本地跑（境外 CI runner 到 Gitee ~50KB/s 必断），推 tag 默认只出 Windows，mac 包 `gh workflow run build.yml --ref vX.Y.Z -f with_macos=true`。
- **测试临时目录**必须用 `crate::test_support::tmp`（canonicalize 过的路径），避免 Windows 短名 / macOS `/private/var` 造成的「本地绿、CI 红」。

## 许可

MIT（LICENSE）
