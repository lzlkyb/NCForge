# 变更日志

本文件是**唯一手写源**（Keep a Changelog 格式）。`scripts/gen-changelog.mjs` 在
predev/prebuild 时把它解析成 `desktop/src/lib/changelog.generated.ts`（关于页数据源），
`scripts/update-release-notes.mjs` 在 CI 发版时把用户可见小节抽进 `updater.json` 的
`notes` 字段（更新弹窗内容）。**改这里，不要改生成物。**

版本段结构（CI 与脚本都依赖）：段头为一行内代码 `## [X.Y.Z] - YYYY-MM-DD`，
其下小节如下（注意：本文件内的示例请照此用行内代码书写，段头若独占一行会被
gen-changelog.mjs 当成真实版本段解析——该脚本不跳过代码围栏）：

```markdown
（段头行：## [X.Y.Z] - YYYY-MM-DD）

### 更新摘要
一句话人话，会渲染成更新弹窗顶部高亮卡片（禁止代码符号/根因分析）。

### 新增
- 用户能看懂的点

### 修复
- 用户能看懂的点

### 技术细节
- 不进更新弹窗的小节名之一，仅供本文件与关于页
```

小节映射：新增→feat / 变更→improve / 修复→fix / 安全→sec；`### 技术细节` /
`### 实现说明` / `### 开发者` 小节**不进**更新弹窗。

## [Unreleased]

### 变更
- 点 × 退出前会先看一眼有没有还没保存的东西：编辑器里改过没存的文件、数据库里没提交的事务。有就列出来让你选「保存全部并退出 / 不保存并退出 / 取消」，什么都没有就直接退，不多问一句；保存失败（文件被别的程序改过、编码写不出）会当场列出是哪个文件、为什么，不会假装存好了再退出
- 补丁页填的东西现在会记住：改动说明、勾选的文件、手动改的层、随包挂的 SQL，关掉软件再打开还在；按工程分开存，换个工程不会串
- 点右上角的 × 就是退出应用：以前点了只是把窗口收起来、程序还留在托盘里，要真正退出得去托盘右键「退出」；现在没有托盘、也不留在后台，关掉就是关掉。设置页「开机自启」的说明同步改成「登录时自动启动」
- 数据库页全面升级：从「只连一个库的只读查询面板」变成多连接 SQL 客户端；读写权限交给数据库账号控制，软件不再拦写语句，只负责让你看清连的是哪个库
- 同时开多个数据库连接更省内存：多个连接现在共用一个 Java 进程（实测 5 个连接从约 250MB 降到约 77MB），打开再多库也只涨几 MB；各自仍是独立会话，一个库上的慢查询不会拖慢另一个库
- 界面重构：导航栏收窄为 64px（文字标签保留），顶部合并成 36px 标题栏，编辑区更宽更高；点工具页不再整页替换编辑器，改为中央的工具标签；底部面板统一放问题、编译输出、NC 服务
- 单击文件树为预览标签（斜体、会被下一次单击顶替），双击或编辑后固定；标签右键菜单支持关闭其他、关闭右侧、复制路径等
- 编辑器常驻工作台：搜索在左侧打开，服务在底部显示，SVN、数据库、补丁和设置在中央与源码切换
- 统一各模块的工具栏、侧栏和标签区，支持调整侧栏与服务面板大小；切换工具时保留源码和工具输入状态
- 文件树显示真实 SVN 文件状态和目录变更数量，可在主窗口刷新状态
- 安装包从 63.8MB 瘦到约 5MB：编译与代码智能要用的大组件（Java 语言服务、Java 编译器、SVN 客户端，合计约 63MB）不再塞进安装包，首次启动时按需下载到本机，只下一次；老版本已经装过的组件会自动认领，不重复下载
- 首次启动缺组件时弹出引导对话框：列清要下载什么、总共多大、进度与速度，失败可以重试；不下载也能照常使用，用到相关功能时才会再提示
- 设置页新增「组件」卡：三个组件的安装状态、版本与占用空间一目了然，需要时点「重新下载组件」手动重装
- 换应用图标：从「铁砧占位图」换成 NCForge 自己的「榫接 N」——两段构件拼出 N、中间留斜切口，赤陶色圆角方块配奶白色图形，Windows / macOS / 托盘 / 安装包（含 NSIS 横幅与侧边栏）全套一起换掉
- 版本控制页从「M6 敬请期待」占位换成真页面：侧栏入口不再是灰的，进去就能审改动、提交、看历史
- 侧栏新增「数据库」入口，放只读 SQL 面板；「补丁」从占位换成真页面
- 补丁不再靠命令行脚本打：清单由未提交改动自动生成，落位、配对、CHANGES.md 全在窗口里核对完再出包
- 切深色/浅色主题的过渡改成整页淡入淡出，不再让页面上每个元素各自做一次颜色过渡——大文件树打开时切换主题明显更跟手
- 侧栏和底部面板的分隔条支持键盘复位：聚焦后用方向键微调，连按两次 Enter 回到默认宽度

### 新增
- 数据库工具条多了「片段」：把常用的几句 SQL 存下来（默认只在这条连接里出现，要通用就勾「所有连接都能用」），点一下填回编辑器；能改名、改内容、删除，也能搜名字或内容。存在本机，不上传，换机器不会跟着走
- 「历史」抽屉升级成真的能搜：搜索同时看 SQL **和每次的结果**（找「哪次报了 ORA-00942」不用再一条条翻）、多个关键词要求全部命中、命中的字会高亮标出来；加「只看失败」一排开关，排障时先筛出错的那些；勾「全部连接」还能把别的库上的记录一起捞出来（会标出是哪条连接）
- 表页多了「导入数据」：选一个 CSV / TSV 文件，它会按列名自动对上表的字段并给你看每列前 5 行样例，对得不对可以逐列改、也能整列不导；写之前就能看出会不会把名字写进日期列。导入按批进行、每批自成事务，遇到坏行可以选择跳过并把「第几行、为什么失败」列出来（行号对着你的文件数，不是对着程序内部的下标）；全程走一条独立会话，不会把你在这个连接上还没提交的改动一起提交
- 数据库侧栏除了表和视图，还能看包、过程、函数、触发器、序列、同义词、类型（只列当前账号自己的，不是你权限外的东西）：点一下就打开库里的源码，包规范与包体分成两段显示、带行号、可一键复制全文；序列这类没有源码的对象会明说「只有定义，切到 DDL 看」，不会给你一片空白
- 每条语句执行完多一行统计：逻辑读、物理读、执行次数，都是「这条语句自己消耗了多少」而不是全库累计——调优时先看逻辑读高不高，再决定要不要加索引；账号没权限读统计视图时这行不显示，不会给你一个假的 0
- 一个连接可以同时开几条互不打扰的会话：每条 SQL 标签各占一条会话，某条标签在跑长查询时其它标签照常执行，各自的事务也互相独立（提交 / 回滚只影响自己那条，黄条上会写明是哪条会话）；最多 3 条，闲置 10 分钟自动收回给别的标签用，被回收后再执行会自动换一条新的，不用你重连
- 排序与筛选只作用于「已经取到界面上的这些行」，结果表底栏会一直写明这一点；想按整张表排，在表头右键选「在数据库端排序」，会把这个排序套在原来的 SQL 外面重新查一遍
- 执行计划从一张平表变成树：按原来的缩进层级折出父子关系、每条步骤带成本条，一眼看出钱花在哪一层；可以把当前计划存下来做对照，下次再看时直接标出哪几步变贵了、哪几步不见了
- 结果集能直接导出成文件（CSV / TSV / INSERT 脚本）：按行边读边写，几十万行也不占内存、界面不卡，导出过程中显示已经写了多少行，完成后一键在资源管理器里定位文件
- 侧栏新增「工程关联」页（Ctrl+7，设置随之变成 Ctrl+8）：把「A 工程启动要带上 B 工程」摊开给你看——依赖链自上而下的顺序就是真正生效的类路径顺序（同名类谁在前谁赢），每个工程贡献了几个类目录、哪条依赖写在 `.classpath` 里却在磁盘上找不到，都逐条标出来；还能临时停用某个关联工程（连带剪掉它往下传递的依赖）、把它排到前面、或补一个不在任何工程里的产物目录。这些只管工作台自己怎么算类路径，**不动任何工程文件**，改完一次保存；也能先预演另一个工程的依赖链再决定要不要切过去，切换前会先把没保存的文件存好
- 编译失败时会多说一句人话：报「找不到这个类」的时候，如果某个关联工程里明明有它的源码却没编译过，会直接点出来是哪个工程、哪份源码、缺哪个 class，不用再猜是代码写错了还是依赖没编；类在但比源码旧（改了没编、编译还静默通过）也会指出来。原来的报错原文照旧保留，不会只给你一句推断
- 「工程关联」页多一个「检查产物」：一次扫完所有关联工程，指出哪个工程的产物比源码旧、哪个工程有源码却一个 class 都没编出来——这类问题不会让编译失败，只会让运行时悄悄用到旧类。这项检查要遍历整个工程树（实测三工程十几秒），所以做成你主动点、而不是每次编译都偷偷扫一遍；结论会同时标在依赖链的对应行上，点完看到「哪个工程该重编」就够，不用自己在两个列表里对照
- 设置页新增「配置迁移」：把调好的设置（工作区、NC home、数据库连接、代码智能开关等 15 项）导出成一个 json 文件，在新机器上导入时路径可以逐个改、文件里没有的项目保留本机原值；口令不随文件走——换机器本来也解不开，到新机器自己填一遍即可
- 退出前提醒没提交的事务：点 × 时如果还有改到一半没提交的数据，会列清是哪个库、几条语句、影响几行、已经挂了多久，让你一次选全部提交 / 全部回滚 / 取消退出；没有未提交的改动就直接退，不会多问一句
- 悬停表名弹出的字段卡片底部多了「在数据库中打开」：点一下跳到数据库页、自动连上那张表所在的库并打开它的数据（没存口令才需要输一次）
- 数据库连接可以选择执行引擎：「JVM 桥」（默认，能力最全）或「纯 Rust 驱动」（不占 Java 进程，一条连接只几 MB，同时开很多库时更省）。两种引擎都能中途停止、都能连 NC prop.xml 里的数据源；纯 Rust 驱动还差的只是 `open :1 for` 那种 OUT 绑定形态的存储过程（那类语句要用 JVM 桥），用 `dbms_sql.return_result` 返回结果的能正常出表
- 存储过程一次返回好几个结果集时能逐个看了：结果区上方出现「结果集 1 / 2 …」小标签，点一下换一张表，列名和行都跟着换；每张表各自按「每次取 N 行」截断，取不下会在底栏提示调大行数再执行
- 查询可以中途停止：执行时「执行」按钮变成「停止」，点一下数据库侧就取消那条语句（以前只能干等 30 秒超时或杀掉应用）
- 数据库多连接：NC prop.xml 里的数据源自动列出、点一下就连（口令由 NC 自带解密现解，不用再输）；也能手动填写或导入 .properties 新增连接，标开发 / 测试 / 生产 / 其他四种环境色，可编辑、复制、删除、拖动排序
- SQL 控制台：多标签、草稿自动保存；Monaco 编辑器带表名 / 字段补全（含 NC 中文名）；Ctrl+Enter 执行光标所在语句、Alt+X 执行整个脚本（出错即停并定位）、Ctrl+Shift+F 格式化；执行计划、执行历史（单击填回、双击执行）、DBMS_OUTPUT
- 事务：默认手动提交，未提交时黄条显示几条语句 / 影响几行 / 持续多久，一键提交或回滚；关标签、切连接、断开前会提醒；生产库执行写语句前确认一次
- 结果表：几千行流畅滚动、排序、筛选、拖列宽、单元格详情；「加载下 N 行」接着翻；复制为 TSV / CSV / INSERT / in 列表 / Markdown，导出 CSV（Excel 打开不乱码）
- 表页：数据（WHERE / ORDER BY + 分页，双击单元格编辑、预览 SQL 后按主键写回）、结构（含 NC 中文名）、索引、DDL；侧栏可展开看字段、收藏常用表
- Java 编辑器右键「在数据库中执行此 SQL」/「查看执行计划」/「复制为纯 SQL」：把 `sql.append(…)` 拼接的 SQL 拼回来，中间的变量变成参数先填值
- 快速面板：转到文件、类型、符号、命令四种模式（Eclipse 方案 Ctrl+Shift+R / Ctrl+Shift+T / Ctrl+O / Ctrl+Shift+P，IDEA 方案另有键位）；Ctrl+B / Ctrl+J 收起侧栏与底部面板
- 编辑器上方新增面包屑（路径与光标所在类、方法），空编辑器页显示最近打开的文件
- 设置中可选择 Eclipse 或 IntelliJ IDEA 快捷键方案，默认 Eclipse；工程搜索、跳行、注释、删除行和重做等操作随方案切换
- 壳子首发：Tauri 2 技术架构 + 自动更新闭环 + 设计系统三层资产
- 全工程搜索页（M2）：正则 `.*`、区分大小写、整词、文件掩码过滤（`*.java,*.xml,!test*`）、结果按文件分组可折叠、命中行内高亮、点结果直接跳到该行、最近 10 条搜索词历史；切到别的页面再回来，结果、折叠与滚动位置都还在
- 搜索后端：正则走线性时间引擎（能匹配空串的表达式直接拒绝）、掩码按 IDEA 语义（`!` 取反）、逐行回 UTF-16 高亮区间、自动跳过 .svn/.git/.idea/node_modules 与二进制文件、按 GBK/UTF-8 识别解码，结果 500 条与耗时 20 秒双上限（超出标「已截断」）
- 文件树右键菜单：新建文件 / 新建文件夹、重命名、删除、复制路径、刷新；标题栏也放了两个 ＋ 按钮
- 新建与重命名在树里原地输入（Enter 确认、Esc 或点别处取消），名字非法或重名就在输入行下方红字提示，不弹窗
- 删除前先确认，文件夹会先数清里面有多少个文件、提示有几个正开在标签里；删掉的文件标签一并关闭
- 文件或目录改名后，已打开的标签、编辑器内容、展开状态都跟着挪到新路径，未保存的修改不会丢
- 选中文件树的行后可按 F2 重命名、Del 删除
- 文件树上给「Eclipse 会读错编码的 .java」挂 `U8` 标记：磁盘上是 UTF-8 含中文、但工程里没登记成 UTF-8 的文件，用 Eclipse 编出来中文字符串常量是乱码，挂上标记才看得出哪些文件两边产物会对不上
- 打开超过 2000 行的文件时，顶部提示已关掉括号对着色、代码折叠与小地图（这几项每次输入都要全文件重算，几千行的 BO/BP 里打字会掉帧），提示可关掉；语法高亮、搜索、编译不受影响
- NC 服务页（M5）：一键启动 / 停止 / 重启开发态中间件，显示进程号、监听端口是否就绪、跑了多久、classpath 装了多少条
- 服务状态以「端口是不是我们的进程在听」为准：进程活着但模块没加载完显示「启动中」，不会出现「显示运行中、实际连不上」
- 端口跟着 NC 自己的配置走（`ierp/bin/prop.xml` 的 `<http><port>` / `<address>`），不再写死 80：同事把端口改成 8080 或监听地址改成 `0.0.0.0` 时，状态判断、占用提示、端口冲突检查全部自动对齐
- 点状态卡上的端口就能改监听端口：先列出「哪个文件、从几改成几」，确认后才落笔；`ierp/bin/prop.xml` 与 web 端 `system.ejb.port` **一起改**，不会出现「服务起来了、网页打不开」
- 改端口会自动留 `*.ncforge-bak` 备份（已存在则不覆盖，保住最早的原件）；写完全量复核，读回来不是目标端口就报错
- 服务运行中不允许改端口（已经在跑的 JVM 不会重读配置，否则会出现「界面显示新端口、服务还在旧端口」）；客户端 `-Dnc.jstart.port` 与生成客户端安装包的端口列在弹窗里提醒手工同步
- 日志面板实时跟随中间件控制台输出：按全部 / 警告 / 错误筛选、关键字过滤（Ctrl+F）、跟随最新、自动换行、复制、清空；「日志位置」直接在资源管理器里定位日志文件
- 启动前先查端口：被残留的 java 占着会说清是哪个进程、可一键结束；被别的程序占着只提示、不动手
- 服务页可以直接改 NC 安装目录（默认 `D:\ncc\1909home`）与工程目录；没选工程也能起服务，但会明确提示改的代码不会生效
- 「命令行」按钮列出真正会执行的 java 命令、classpath 条目数和工作目录，排错时与 Eclipse 的启动配置逐项对照
- 服务页可以直接改堆内存上限（默认 4G，`-Xmx`）：点「修改」就地输入，带 2G / 4G / 8G 快捷档，改完回车生效于下次启动；服务在跑时会明确提示「重启后生效」。Eclipse 那套 1G 老配置跑 245 个模块不够，`prop.xml` 里的 80G 又是生产机的值，默认取 4G
- 版本控制页（M6）：左边列本地改动（按模块分组、M/A/D/?/C 徽标、搜索与「已改 / 未纳管 / 冲突」筛选），右边看双栏差异
- 改动列表默认滤掉噪音：`classes/`、`out/`、`.nc-compile`、`*.class/jar/log`、冲突残留 `*.mine` / `*.rN`，页脚显示藏了多少条并可一键展开；未纳管目录合一行显示，不展开成十几行
- 逐文件审查：标「已审」后按 `Alt`+`↓` 直接走下一个，页脚有进度条；已审标记绑 BASE 版本 + 修改时间 + 大小，别人提交或你一更新就自动失效，不会拿旧结论骗人
- 提交面板在右栏原地展开（不弹窗）：勾选要提交的文件、写说明、`Ctrl`+`Enter` 提交；未纳管文件自动 `add`，冲突文件自动从清单里剔除
- 冲突文件：我的 / 基线 / 服务器三选一，再点「已解决」才生效——不假装能做三路合并，选文件也不等于你确认过内容
- 更新与撤销：更新完列出还有几个文件冲突；撤销是唯一不可恢复的操作，所以先把文件备份到工作副本旁边的 `.ncforge-revert-<时间戳>`（不放工作副本里面，免得凭空多一个未纳管目录被顺手提交），并告诉你备份在哪
- 历史与 blame：单个文件分页看提交记录（`r` 号 / 作者 / 时间 / 说明可展开），或看每一行是谁在哪一版改的（按作者配色条）
- SVN 账号零配置：直接复用 Eclipse 存在本机的 SVN 账号（Windows DPAPI 解密），缓存里没有才弹一次登录框，输一次记住
- 补丁打包页（M7）：左边列出未提交改动（按模块分组、M/A/未纳管徽标、`hyext` / `标准` / `upm` / `网页` 标签），右边实时预览这个 zip 打开后长什么样——目录树里能直接看到每个 class 落在 `replacement/modules/<模块>/...` 的哪一层，以及 `.java` 与 `$1` 内部类是不是并排进了包
- 每个文件都标出「能不能真打进去」：`2 class` 是好的、`未编译` 说明还没编译（打进去是空目录）、`过期` 说明 class 比源码旧（打进去的是旧行为）；勾了也打不进去的会单独计数，不让你带着红点出包
- 打包前会把 `CHANGES.md` 写出来：功能说明 / 问题现象 / 原因 / 修改点 / 影响范围五节手写，落位层与增删行数在出包时自动追加；挂的 SQL 放 zip 根，运维执行时一眼看得到
- 补丁包名就是「改动描述 + 日期」（`库存借出借入跨组织改造_20261028.zip`），覆盖旧包前自动备份成 `.bak-<时间戳>`，生成完可以直接在资源管理器里定位
- 输出目录不用每次填：优先用你设过的；第一次用会继承 nc-patch 脚本缓存里的「待上线补丁」；脚本也没用过就在工作副本附近和常见位置找现成的同名目录；一个都没有才给建议路径，并在目录框旁标出「建议目录 · 还不存在」（出包时才创建）——不会悄悄把包发到一个陌生位置
- 数据库页（M7）：连测试库跑只读 SQL，结果表带列类型、NULL 标成斜体灰字（与空串分开）、数字列右对齐、可一键复制成 TSV 粘进 Excel
- SQL 只读是三层拦的：只放行单条 `select` / `with`（写操作当场拒绝并说明是工作台拦的）、查询跑在 Oracle 只读事务里、执行后无条件 `rollback`——三层任何一层漏了另两层也拦得住
- 表名写错（ORA-00942）会顺手给出相近表名；连不上库和口令错分开提示，口令错停在输密码框而不是甩一句 ORA 号
- 数据库连接串与用户名直接从 NC 的 `ierp/bin/prop.xml` 读，不用手填；口令是 NC 自己的加密格式解不开，第一次输一次，之后用 Windows DPAPI 存在本机
- 出包前能核对表结构（补丁页「表结构核对」）：把勾中文件里所有 SQL 字符串解析一遍，看引用的表和字段在库里是不是真的存在。表不存在标红（发上去必然报 ORA-00942，出包按钮要连点两次才放行），字段找不到标黄只提醒不看门——判定从严，多表 join 的裸列、别名对不上、表名是变量的一律不报，宁可漏也不误报
- 库里两千多张表的结构拉一次存本机（约 3 秒），之后核对与悬停都走缓存；缓存按「连接串 + 用户名」分文件，换库调试不会互相覆盖，页面上显示「哪次拉的、多少张表」并可手动刷新
- 编辑器里把鼠标停在 SQL 字符串的表名上，直接看这张表的字段与类型（见 `docs/交接清单-2026-10-27.md` 关于「只能认字符串字面量里的表名」的限制说明）
- 版本控制页新增「维护」面板（顶部齿轮图标）：列出撤销与冲突二选一留下的备份目录（时间、文件数、体积），可单个删或一次清空；同时显示已审标记的总数 / 有效 / 已失效，并提供「清理失效标记」
- 表被谁锁住了、谁在跑长查询：SQL 控制台点「会话」出一张只读清单（SID / 用户与机器 / 状态 / 等待事件与已等秒 / 锁住的对象 / 正在跑的 SQL），被阻塞的行整行标色并指出阻塞源，每行可复制 SQL 或复制 `alter system kill session` 语句（只复制，不代执行）；账号读不到锁视图时明说「锁信息不可见」并给出授权语句，不会显示成「没有锁」
- 编辑器里能查「这个类 / 方法 / 字段都用在哪儿了」：右键选「找引用」或在命令面板（`Ctrl+Shift+P`）敲「引用」，列出每一处调用点、点一下就跳过去；改公共方法之前先看影响面，不用再全工程搜类名猜。同一处还能格式化当前文件、快速修复（`Alt+Enter`，补 import、改类型、生成方法）、跳到实现或父类——这些都没有额外快捷键，靠右键和命令面板就能找到
- 编译日志里的报错行能直接点过去：输出区那行 `1. ERROR in D:\…\Foo.java (at line 42)` 现在是个链接，点一下打开那个文件的第 42 行，不用照着路径自己去树上翻
- 编辑器上方多了「结构」按钮：当前文件的类 / 方法 / 字段列成一个树，点一条就跳到那一行；也可以按名字过滤，几千行的类里找方法不用再滚屏幕
- 代码智能（jdt.ls）报的问题现在也进底部「问题」面板了：和编译错误列在一处，标题栏显示一共几条，按 F2 或在命令面板敲「下一处问题」在报错点之间挨个跳——以前只有编译器报错会进面板，编辑时就看到的红线只在行内有提示、关掉文件就找不到了
- 编辑器能「后退 / 前进」了：找引用、跳定义、点报错行之后，左上角两个箭头像浏览器一样带你回上一个位置、再前进回去；跳得再远也记得刚才在哪儿
- 重命名可以跨文件了：光标放到方法名或类名上按 F2（或命令面板敲「重命名」），先列出这个符号在哪些文件、哪一行被用到，确认后逐文件改——不会只改当前打开的文件、别的文件留着旧名字
- 全局搜索页能直接替换了：搜索框旁边填替换内容，先列出「将改哪几个文件、共几处」和被改行的前后对照，确认后一次改完；写不进去的文件（编码特殊、换行混杂）会跳过并说明几个，不会把文件改坏
- 导出和导入都能中途停下来了：导出一段很长时，结果上方多了一个「取消」，点了会等当前这一页写完就停，已经写进文件的部分保留；导入 CSV 时按钮从「导入中…」变成「取消导入」，当前这批写完后停下，界面上照常显示已经写进去多少行
- 连着报一串错的时候，通知区右上角会多一个「复制全部错误」，一下把所有错误文字拷走，不用一条条点
- 结果表格补上了读屏标注：读屏软件能念出「共几行几列、当前选中哪一格」，按方向键移动时会跟着播报
- 每个文件自动留着最近 20 个历史版本：保存前、切换文件时、以及每 5 分钟都会把磁盘上的内容存一版；编辑器上方点「历史」就能按时间挑一版，看它和现在的差异（哪几行加了、哪几行删了），改坏了点「恢复此版本」就能退回去——没提交 SVN 的改动误删了也有处可找。恢复前会先把当前内容也存一版，所以恢复本身也能反悔；磁盘被别的程序动过时会拒绝覆盖并说明
- 按 Alt+Insert 生成样板代码：构造器、getter / setter、toString、equals、hashCode 勾哪样生成哪样，一次生成后插到光标处；顺带「覆盖父类方法…」「实现接口方法…」两个入口。字段从当前类的源码里读，类里没有字段时会说清楚「没有字段可生成」，不会弹一个空对话框
- 敲 `sout` 回车打出 `System.out.println()`，`fori` / `forr` / `iter` / `psvm` / `ifn` 判空 / `tryc` 等 19 个模板同理，生成的占位符可以按 Tab 一个个跳着填；模板排在语义补全之后，敲半截想要的是变量、敲完整才想要模板
- 按 Ctrl+Alt+O 一键整理导入：没用的 import 清掉、缺的补上，一次只动当前文件
- 按 Ctrl+Alt+H 看调用层级：当前方法被谁调用、它又调用了谁，各列一层，点某一行跳过去；结果在底部面板的「调用层级」标签里
- 文件树把 `com → aier → erp → vo` 这种一层一个的目录合成一行 `com.aier.erp.vo`（点开仍是逐层展开）；右侧打开哪个文件，左边自动展开并滚到那一行，不用一层层点；标签右键多了「在文件树中显示」
- 文件树上直接敲字就能按名字筛选（Esc 清除），7000 个文件的工程里不用再靠点目录找文件
- 代码折叠改按方法和代码块来（不再只按缩进猜）；光标下的方法 / 变量，它在本文件里的其它出现处会语义级高亮；按 Ctrl+W 一层层扩大选区（从标识符到表达式到语句到整个方法）
- Ctrl+K 浮层多了「工作区符号」模式（Ctrl+Alt+N）：搜方法名、字段名，整个工作区加依赖 jar 一起搜，命中直接跳到那一行
- 底部面板多了「TODO」标签：扫出工程里的 TODO / FIXME / XXX / HACK 和它所在的行，点一下跳过去；按工作区缓存，不会每次打开都全盘重扫
- 按 F11 给当前行加书签、Shift+F11 看书签列表：书签按工程分开存，本机有效，不跟着配置导出跑到同事机器上
- 按 Ctrl+Shift+Backspace 回到上一次打字的位置（区别于「后退」：那个记的是跳转，这个记的是你改过哪儿）；Ctrl+Shift+T 在当前文件和它的测试类之间来回跳，找不到时会说清找过哪些名字
- 删除文件前会先查一下别处还有没有提到这个类（按类名搜整个工作区），确认框里写清「别处还有 N 处提到它（如 …）」，删除后那些地方会编译不过；同时列出会连带关闭几个标签、其中几个还有没保存的修改
- 编辑器偏好进了设置页「编辑器」卡：字号、字体、自动换行、缩进宽度与制表符/空格、小地图、粘性滚动、行尾内联报错（Error Lens）、自动保存（默认关，NC 常「改一半就编译」）与保存延迟
- 「编译全部」：按依赖顺序把工作区里的模块从头编一遍（被依赖的先编），一个模块编不过就停下并说明后续模块依赖它的产物；过程可取消，问题仍汇总到问题列表
- 标签可以拖着排序了；多光标支持 Alt+J（选下一个相同词）

### 修复
- 编译输出里的报错以前只是死文字：底部「问题」列表能点，但切到「输出」标签看完整编译日志时，那些写了一行行文件名和行号的错误点了全没反应，只能手工去找
- 编辑器里引用太多时不说一声：同一个公共方法在 NC 里可能有上千处调用，现在只显示前 400 处并明确提示「还有更多」，不会让人以为某个调用点没被算进来
- 用纯 Rust 引擎连库时，PL/SQL 里写「打开游标 for 查询」（`open :1 for …`，或声明了 `sys_refcursor` 却没把结果返回）以前直接报 `PLS-00707`、或者语句不报错却一行都拿不到，只能自己切回 Java 引擎重来：现在这类语句会自动改在一条临时 JVM 会话上执行并照常出结果表，输出区会写明「这次换了引擎跑、不受本连接事务条管理」；判定不出来的写法（游标从包里返回、动态拼出来的 `open`）仍按原文报错，并把「换成 JVM 桥也没成」的原因一起列出来，不假装成功
- 服务显示「启动成功」但前端页面打开是 404：开发模式下只挂载软件指定的那几个前端应用，本机安装里一共有 18 个，其中 `iwebap`（主前端）和 `eyeapp`（业务前端）一直被悄悄跳过，日志里只有一句 warn。现在按安装目录里实际存在的前端应用全部挂载
- 用官方脚本停不掉软件起的服务：软件的启动参数里漏了服务器名，运行时按默认名建了 `work/server`，而配置里写的是 `xuyserver`，官方停止脚本按配置名找端口自然找不到。现在启动前读配置、把服务器名带上，`work/` 下的目录名与配置一致
- 装在 NC 安装目录里的两类覆盖类在软件启动时完全不生效：`external/classes`（33 个二开业务类）和 `resources/`（框架热修复类）以前根本不进类路径；后者还必须排在 `lib` 之前才能压过原来的 jar，顺序错了等于没加
- 工程一次都没编译过时启动，报错只有一句「start tomcat error」，看不出是缺 jar 还是别的原因：现在直接提示「类路径里一个目录条目都没有，先编译一次工程」
- 在关联工程里改了代码却总不生效：以前判断「用哪份编译产物」靠猜目录——会把你没在 Eclipse 里引用的兄弟工程也无条件收进来，谁生效只看目录名字母序（实测 `newar` 的 18 个同名类压过 `pm`），还会漏掉 Eclipse 默认输出目录（实测 `pm/bin` 里 339 个类从没进过类路径）。现在按工程自带的 Eclipse 配置决定「依赖谁、谁先谁后」，改了哪个工程就是哪个工程生效
- 装过补丁的机器上，补丁里的覆盖类编译时找不到、启动时也加载不到：NC 安装目录里其实有六处散类目录（`hyext/classes`、`client/classes`、`META-INF/classes` 等），以前只扫了其中一处，本机实测漏 148 个类。现在六处都收，且散类排在 jar 之前——补丁覆盖产品类这条路才算通
- 全应用的通知（toast）从来没显示过：通知容器没挂到应用根上，所有「已复制」「保存失败」这类提示都静默消失，操作成不成功只能靠看界面猜
- 点问题列表只打开文件、不跳到出错行
- 切到搜索页再回文件页，已打开的标签页全部消失（标签元数据随页面卸载被清掉）
- 从搜索页跳回文件页，文件树的展开层级与已加载目录被重置，得重新一层层点开
- 设置页的两个开关（开机自启、关窗时释放内存）读的是不存在的字段名，每次打开都显示成关闭、改了也写不进配置
- 搜索读盘太慢导致结果不全：冷缓存下顺序读只有 70~80 文件/秒，15 秒只扫到 956 个文件（工作区的 1/8），明明存在的词搜不到。改为八线程并行读 + 按扩展名跳过 `.class` 等二进制（本地一半候选是编译产物），同一份工作区从 956 个文件提升到全量 7953 个、2.7 秒
- 停止服务在「启动还在准备」的那一秒会误报「已停止」：进程其实还不存在，服务随后照旧起来，用户以为自己停了。改成三态结果（已停止 / 正在取消 / 没有在运行），重启时也会等取消完成再起
- 改端口弹窗可能按过期方案落笔：预览之后又把端口号改成别的数，点「应用」写进去的仍是预览时那份。现在应用前会校验「方案端口 = 当前输入」，对不上就拒绝
- 堆上限连按回车会保存两次：后一次覆盖前一次，显示的生效值可能和刚填的数不一致。Enter 与 ✓ 现在共用一道保存中闸门；改过的值旁边多了一个「恢复默认」，不用再手改 config.json
- 服务崩溃时日志看不到最后的堆栈：停止后轮询立刻停，而堆栈往往写在最后一拍之后。现在停止后会补拉两拍（第二拍排在第一拍读完之后，慢盘上才抓得到）
- 窄窗口（1024px）下「堆上限」被挤压成「堆上 6…」：行内项目加了防收缩，三项配置在窄窗下完整可读
- NC 配置里没有 `<http>` 块时，端口回落会全文搜到 `<https>` 的 443：现在明确要求真实的 `<http>` 块，读不到就说读不到，不猜
- 「已审」标记只看文件改动时间、不看版本号：别人提交了这个文件、或你更新过之后，只要本地文件没被重新写过，旧结论照样显示「已审」。现在 BASE 版本一变标记立刻失效（版本 + 修改时间 + 长度 + 路径四项全等才算数）
- 撤销与冲突解决的备份目录只增不删：一个工程干久了下来旁边能堆几十个 `.ncforge-*`，界面里既看不到也没法删。现在「维护」面板能盘点与清理（删除前二次确认，后端只认自己生成的那个目录名）
- 资源包清单里的 `id` / `version` 原本只查非空就拼进安装目录名，形如 `x/../../../evil` 的版本号能把下载内容写到配置目录之外（本地实测可复现）。现在清单解析期就拒绝含路径分隔符或 `..` 的取值，`pack_dir` 另有一道兜底
- 只读查询的「自治事务」提醒会漏：SQL 里第一处带括号的调用如果是 `dbms_random.value()` 这类系统包，后面自定义包的 `my_pkg.do_write()` 就不再提示了。现在扫完全部调用再判断
- 一次删多个备份目录时，中间某个被占用会让前面已经删掉的数字全部消失，提示只剩一句失败。现在逐个删：删成功的照样报出数量与释放体积，失败的单独说是哪个、为什么
- 表数据页读取失败时只有一行红字、没法重试：现在报错旁边有「重试」，库忙或连接抖一下导致的读取失败不用切走页面再回来
- 补丁页「表不存在」的二次确认能被切页绕开：核对出缺表、点第一次按钮进入确认态后，切到别的页再回来，核对结果被清掉但确认态还留着，下一次点「生成补丁包」一次就出包。现在结果一清，确认态同步退回
- 日志面板的「复制」只拷屏幕上渲染的最后 500 行：大日志里更早的关键报错被悄悄丢掉，粘出来以为全了。现在复制已加载的全部匹配行，并提示其中多少行当前没显示
- 同时开着两页结果各导各的时，点其中一页的「取消」偶尔会把另一页也停掉、进度条也会串到别的一页：现在每次导出有自己的编号，取消和进度只认自己那一页
- 补丁包出到一半没有反馈也停不下来：现在显示「正在写入第几个、共几个条目」，可以中途取消；写到一半失败或取消都不会毁掉旧包，原来的包原样留着
- 文件树以前只能用鼠标点：现在方向键上下选、左右展开收起、Enter 打开、Home / End 跳到首尾，读屏软件能念出层级与当前选中项
- 数据库上下的分栏线只能用鼠标拖：聚焦后用方向键微调、按住 Shift 走大步、Home / End 直接到底
- 表结构核对换过文件之后，上一份结果晚到会盖掉新结果、或者显示已经不对的旧结论：现在过期的结果直接丢弃
- 编译输出行数一多，界面被逐行刷新拖慢、日志也会无限增长：现在每 80 毫秒合并刷新一次，最多保留最近 5000 行并提示前面已截断
- 导出或复制的 CSV 里，以空格开头再跟 `=`、`@` 的值仍可能被当公式执行：现在先去掉前导空白再判断；负数和带空格的数字不受影响
- 工作副本地址解析不出服务器名时，SVN 凭据会从本机缓存里随便挑一条账号去连：现在这种情况宁可让你自己输一次密码
- 开窗第一屏的骨架屏画的还是旧布局（左侧 200px、顶部 52px），真实界面是 148px / 36px，每次启动都先跳一下：现在按真实尺寸画

### 变更
- 搜索后端改成「匹配器」抽象，纯文本与正则共用同一条结果路径；`SearchHit` 增加 `ranges`（UTF-16 偏移）供前端画高亮，前端不再自己 `indexOf`
- 搜索改为「先收集候选、再并行匹配」两段式，结果按（路径, 行号）排序，同一份代码反复搜顺序固定
- 搜索超时不再说「没有找到」：明确告知已扫多少文件、后面还没看，并建议加过滤或重搜（二次搜走系统缓存只要 1~2 秒）
- 文件页的标签、激活项、面板与编译结果移入模块级仓库（`lib/workspaceSession`），切页卸载不再丢；切工作区时才重置
- `productName` 改为显示名 `NCForge`，同时用 `mainBinaryName` 固定 exe 名，安装后开始菜单显示正确
- 项目更名为 NCForge：窗口标题、托盘提示、侧栏品牌、关于卡片、安装包与产物名、应用标识（`com.aier.ncforge`）一并更换
- 换用新图标（白底方块 + 渐变铁砧 + 火花），安装包头图与侧图同步重做
- 托盘改用专用简化图标（单色砧体、无底），避免白底方块缩到 16px 后糊成一团
- 修复启动骨架屏、侧栏品牌、更新弹框里的应用图标一直加载不出来（`/icon.png` 缺 public 目录）

### 技术细节
- 2026-11-01 对标 IDEA 的能力补齐（P0 七项 + P1 主体），设计与证据见
  `docs/NCForge-对标IDEA-能力缺口-20261101.md` §7。几个决定与坑：
  - **代码生成不走 jdt.ls**：LSP 没有代码生成能力，且红线是 jdt.ls 不写用户文件。
    字段来源是自研的极简源码模型（`lib/javaModel.ts`：先 `blankLiterals` 把注释/字符串抹成空格，
    再只采类体第一层成员），生成是纯函数（`lib/javaCodeGen.ts`），结果作为文本插进 model，
    用户自己 Ctrl+S。两个生成细节必须钉住：`toString` 每行以 `+` 结尾（Java 不允许操作数后换行）、
    `equals` 逐字段 `Objects.equals(a, that.a)`（没有多参数重载，一次比多个会退化成引用比较）。
  - **snippetSupport 打开后前端必须认 `insertTextFormat`**：`lsp.rs` 改 true 后，
    jdt.ls 与内置模板都会下发 `${1:x}`；`langProviders.ts` 按 `=== 2` 映射 Monaco 的
    `InsertAsSnippet`，否则占位符原样进代码。内置模板用 `sortText: "zz-<prefix>"` 排在语义补全之后。
  - **调用层级要回传服务端原始 item**：prepare 拿到的 `CallHierarchyItem` 带 `data` 字段，
    incoming/outgoing 请求必须原样带回；自己转成精简结构第二步会失败。
  - **压缩中间包的展开/收起要写/删链上每一层**（`lib/treeCompact.ts::chainFor`）：
    只动链尾，上一层仍开着，下一帧又压回去，表现为「点了没反应」。
    `flattenTree` 与 `TreeRows` 渲染共用同一份计算，否则方向键会停在看不见的行上。
  - **编译顺序 = 类路径顺序的倒序**（`eclipse_cp::compile_order`）：类路径是「主工程 → 依赖」，
    反过来就是「最底层先编」。模块名保留原始大小写（调用方拿它拼 `<root>/<module>`）；
    直接挂在工作区根下的那一层不是模块（追加目录、根工程自己的 `classes`）。
    首个模块失败即停：后续模块依赖它的产物，继续编只会刷一串二级错误。
  - **自动定位与筛选互斥**：`reveal()` 前先清 filter，否则「定位成功但那一行被筛掉了」。
  - **Error Lens 的装饰集合只有 `clear()` 没有 `dispose()`**（Monaco 0.52），类型上别写成后者。
  - 单文件体量门禁（≤300 行）倒逼拆件：`FileTree.tsx` 抽出 `TreeRows.tsx`（递归行渲染）
    与 `TreeChrome.tsx`（筛选条 + 删除确认），删除确认的文案进 `lib/treeDeleteText.ts` 以便单测。
- 2026-10-31 编辑器动作（找引用 / 格式化 / 快速修复 / 跳实现）：**要注册的是 provider，不是右键菜单**。
  Monaco 在 `registerReferenceProvider` / `registerCodeActionProvider` / `registerDocumentFormattingEditProvider`
  注册之后，会自己往右键与命令面板里加项；再 `addAction` 一遍就是「右键里中英各一条」。
  所以 `lib/langProvidersExtra.ts` 只做 LSP → Monaco 的类型翻译（`changes` / `documentChanges`
  两种 WorkspaceEdit 都认），UI 一律不碰。`lib/editorActions.ts` 只补两件 Monaco 给不了的事：
  命令面板里的中文条目（`EDITOR_COMMANDS`，`enabled` 用 `currentIsJava()`）与 `Alt+Enter`
  （Monaco 内置是 `Ctrl+.`，IDEA 迁过来的人按的是 Alt+Enter）。
  三个坑：① `ask()` 的第三参从「超时」改成「params」后，`langProviders` 里补全那一处要跟着改成
  `ask(method, ctx, {}, TIMEOUT)`，否则数字被当成 params 静默丢掉超时；② `provideCodeActions`
  新版必须返回 `CodeActionList`（`{actions, dispose}`），直接返回数组是类型错；③
  `editor.addCommand` 返回的是 **command id 不是 disposable**，别写成返回值去 `dispose()`。
  引用结果截断在 400 条并 toast 说明：NC 的公共方法全工作区上千处，静默少给比慢更糟。
- 2026-10-31 日志行跳转（`lib/logLink.ts`）：只认两种写法——ecj 的 `N. ERROR in <路径> (at line M)`
  与前端追加的 `路径:行号`；**Java 堆栈 `at x.y.Z(Foo.java:42)` 刻意不认**（只有文件名没目录，
  同名类可能多个，猜必错）。`路径:行号` 那条正则的路径段排除空格与括号，否则堆栈行会被当成
  一个叫 `at com.nc.Foo.bar(Foo.java` 的文件（这一条是单测逼出来的，不是想出来的）。
  日志解析用 `useMemo` 整批算一次：编译时会连续推几百行，逐行在 JSX 里跑正则没必要。
- 2026-10-31 P0 能力路由（`open :1 for …` 自动降级到 JVM 桥）：**估算先被真库证伪**——原假设
  「桥天然支持 OUT 绑定、只改 Rust 侧 ~150 行」，实测桥用普通 `Statement` 执行，`:1` 被按输入
  绑成空串，回 `ORA-01008`，所以真正的成本是「先让桥自己能跑」再谈路由（实际 ~420 行，两侧都改）。
  桥侧四个坑：必须 `prepareCall` + `registerOutParameter(CURSOR)`；`oracle.jdbc.OracleTypes`
  不能 import（classpath 只有 JDK 标准库），走反射、取不到退回历史值 `-10`（`java.sql.Types.REF_CURSOR`
  在 NC 自带 Java 7 上编译不过）；PL/SQL 块的结尾分号**不能**去掉（去了 `PLS-00103 end-of-file`）；
  `ResultSetMetaData` 必须在 `closeCursor()` 之前读（否则 `ORA-17009 关闭的语句`，`readRows` 拆成
  `columnsJson` / `pageOf` 两个静态函数把顺序钉死）。
  Rust 侧 `db_engine::refcursor_need` 只认能安全识别的两种形态（`open :N for` → `OutBind`；
  有 `sys_refcursor` 但既无 `return_result` 也无 `fetch` → `CursorWithoutResultSet`），
  先 `strip_literals` 去字符串与注释再按 word boundary 扫，认不出就 `None` 交原引擎报错——
  **误判比不判更糟**。第二道网：Rust 引擎报 `PLS-00707` 也兜一层，两条都失败把两个原因一起报。
  兜底会话三条纪律：① 键 `{引擎键}#java`，`live_slots` 只认纯数字后缀所以不占 3 个槽，
  `split_slot_key` 先 `strip_suffix` 再切 `#N`；② 不做假的无感，结果带
  `fallback: {engine, reason}`，`dbStore` 写进输出区；③ **绝不静默提交**——执行后 `ping` 看
  `tx.statements > 0` 就 `rollback` 并报 `fallback-tx`。`db_disconnect` / `db_slot_release` /
  `sweep_idle_slots` 都要连带 `drop_bridge(java_key(…))`。
  真库（19c）验证：单游标 3 行、双游标「顶层 + `sets[0]`」、取满 `hasMore` 后 `more` 再 3 行，
  `tests/db_refcursor_probe.rs::R5` 由「打印」改成断言版回归守卫。`Caps::RUST.refcursor`
  **仍是 `false`**：能力位说的是「本引擎自己能不能跑」，路由是兜底换引擎，两码事。
- 2026-10-31 B 档 B4（片段库 + 历史全文检索，B 档收工）：片段存 localStorage
  （`ncforge-db-snippets`，上限 200 条），作用域只有「`connId = null` 全局 / 某连接」两种，
  不做工作区级——数据库这块本来没有工作区分组，多一层只会让人找不到刚存的片段。
  **两处 `useSyncExternalStore` 陷阱**：① `listSnippets()` 每次 filter+sort 都出新数组，
  直接当快照会「每次都不一样」→ 无限重渲染直到卡死，所以 `snippetsSnapshot()` 按
  「连接 + 版本号」缓存，单测断言「没写入时两次调用同一个引用」；
  ② 历史那边 `getHistoryMap()` 直接返回内部 cache 对象（引用天然稳定），摊平与筛选挪到
  `historyHits` / `filterHits` 纯函数里做，组件只剩壳。
  历史检索的口径变了：**SQL 与结果摘要一起搜**（「哪次报了 ORA-00942」只能靠摘要），
  命中高亮走 `matchRanges`（自己扫 `indexOf` 再合并重叠区间，**不用正则**——关键词里的
  `(` `*` `.` 会让正则要么炸要么匹配错，单测里专门钉了 `.` 不匹配任意字符）。
  行内按钮的坑：片段每行右侧有「改名 / 删除」，所以整行**不能**做成 `<button>`（button 套
  button 非法，点删除会连带触发「填入」）——外层改 `div`，左边独立 `button` 负责填入。
- 2026-10-31 B 档 B3（CSV / TSV 导入）：后端 `commands/db_import_cmds.rs` 的 `db_import_rows`
  **走独立会话 + 手动事务**（`connect_args(..., false, engine)` + `bridge_for`，会话键
  `__import:{连接id}:{seq}`），不碰用户 primary 上未提交的改动；每批（前端 200 行）自成事务，
  `skip_errors=false` 时遇错整批 `rollback` 并返回 `committed:false`，前端据此停下不再发后续批。
  两引擎的 `exec` 只收 SQL 文本、没有绑定参数，所以字面量复用 `sql_export::literal`
  （与「导出 INSERT」同一实现）——同一个值在导出和导入里必须长得一样。前端 `lib/csvParse.ts`
  只管解析（引号内分隔符/换行、`""` 还原、BOM、空行计数），`lib/csvImport.ts::planImport`
  只管切批与**行号换算**（表头算第 1 行 ⇒ 第 i 条数据在 i+2 行，分批后每批起点都 +2）；
  把它拆成纯函数是因为行号算错**不会报错**，只会让用户拿着对不上的行号去改数据，配了 6 条单测
  （含故意去掉 `+2` 的反向验证：2 红 → 恢复即绿）。`ImportDialog.tsx` 因此只剩壳，
  useState+useEffect 从 9 降到 7（文件选择从 `useRef` + `click()` 改成 `<label>` 包
  `<input type="file">`），组件体量门禁才过。
- 2026-10-31 B 档 B1+B2（对象树 + 库内源码只读）：`db_meta` 新增 `objects`（无参）与 `source`
  （参数=对象名）两个 kind，双引擎同形。来源 `user_objects`（不是 `all_objects`：二开账号通常
  只有自己 schema 的权限，`all_objects` 会扫到别人的几千张表且要额外授权），`generated='N'`
  排掉回收站等系统生成对象；源码读 `user_source`，`order by type, line` 恰好是「规范在前、
  实现在后」的阅读顺序。`ddl` 新增 `arg2` = 对象类型，**类型名是 SQL 字面量、绑不进去只能拼**，
  所以先过 `OBJECT_TYPES` 白名单（`object_type_of()` 返回 `&'static str`，让「拼进 SQL 的值
  只可能来自常量表」在类型上成立；单测覆盖 `PACKAGE'; drop table t --` 这类注入载体）。
  前端复用 `TableTab`（加可选 `otype`）而不是新开一种 tab：关闭 / 切换 / 持久化 / 退出确认
  四条链路都按 `kind` 分派，多一种 kind 就要在四处各加一支，漏一处就是「关不掉的标签」；
  对象页只显示「源码 / DDL」，不去读字段（包在 `user_tab_columns` 里根本不存在，读只会白跑
  一次并报错）。源码视图拆到 `components/db/SourceView.tsx`：`TablePage` 的
  useState+useEffect 数撞上组件体量门禁的上限 8（门禁按文件统计，不看组件边界）。
- 2026-10-31 数据库 A 档五项一次落地（A2 Autotrace / A0 多标签独立会话 / A3 排序口径 /
  A5 XPLAN 树 / A4 流式导出）。**A2**：执行前后各读一次 `v$mystat` 取差值
  （`db_block_gets` / `consistent_gets` / `physical_reads` / `execute_count`），
  `Caps.stats` 两个引擎都置 true；读不到 stat 时 `stats: null`——前端 `statsText` 见到 null
  就不渲染，**绝不显示 0**（假 0 比不显示更误导）。**A0**：会话槽键 `连接id#N`，每连接
  `MAX_SLOTS=3`、`SLOT_IDLE=600s`；不启后台线程回收，在申请与执行前顺手 sweep
  （`commands/db_cmds.rs`）；`db_exec`/`db_more`/`db_tx`/`db_cancel` 都带 `slot` 参数，
  前端 `dbStore.ensureSlot` 首次执行时申请、`slot-gone` 自动重开重试一次；退出确认的
  多会话合并放后端 `merge_sessions`（同连接任一条 unknown 整体 unknown，语句/行数相加）；
  `db_tx_all` 逐个提交，一个失败不中断其余。**A5**：`explain()` 的 `cost`/`rows` 从字符串改
  `Option<f64>`（不改前端成本条全是 NaN）。**A4**：`db_file_export::RowWriter<W: Write>` 边读边写，
  每 5000 行发一次 `db:export-progress`，上限 200 万行（超出标 truncated 而不是静默截断）；
  `db_export_reveal` 先 canonicalize 再验 `starts_with(export_dir)`，只认自己生成的目录。
  文件名安全化用 `is_alphanumeric()` 而非 ASCII 白名单——否则 `员工表` 会被压成 `____`
  （单测反向验证过）。前端新增 `lib/serverSort.ts` / `planTree.ts` / `dbStats.ts` /
  `dbResultActions.ts`（后者从 `dbActions` 拆出：`dbActions → sqlModels → monacoSetup`
  会把 Monaco 拖进 jsdom，整片测试挂掉）。
- 2026-10-31 类路径改读 Eclipse `.classpath`（`src/eclipse_cp.rs`，9 个单测）：四条规则——①src 条目
  缺 `output=` 时回落 `kind="output"`（该行在文件末尾，必须两遍扫描）；②同一 output 被多条 src 共享时去重
  （`newar` 223 条 src → 35 个目录）；③`path="/X"` 先按兄弟目录名匹配、再按 `.project` 的 `<name>`、
  最后按 `.metadata` 的 `.projects/X/.location`（`newar/.project` 自称 `ar`，顺序写反就解析失败）；
  ④`exported="true"` 才继续传递（`EyePortal` 有 95 个类只能经 `pm → newar` 拿到）。`launch::project_class_dirs`
  签名不变，`compile.rs` / `shadow.rs` / `launch.rs` 三处调用零改动；无 `.classpath` 的老工程回落旧启发式
  （补扫 `<根>/bin`）。真机验收 `tests/eclipse_cp_live.rs`：`EyePortal → pm → newar` 共 52 个目录
  = 9 + 8 + 35，`pm/bin`（15 位）压过 `newar/out/uapbd`（46 位）
- 2026-10-31 NCHOME 散类目录六段全收（`nc_index::MODULE_CLASS_DIRS`）：本机 49 + 60 + 50 + 0 + 1 = 160 个
  目录、406 个 class（旧实现只收第一段 49/258，漏 148 个二开覆盖类）。`MODULE_JAR_DIRS` 段序改
  public → client → private（旧序把 client 排最前，实测让 1 个类被标准层抢先），并与 `launch.rs` 收敛成
  一份 `pub const`——两份各写一套时改一处漏另一处，表现是「编译找得到、启动加载不到」。真机 `tests/nc_class_dirs_live.rs`
- 2026-10-31 退出前检查未保存文件：`lib/saveAllDirty.ts`（从 `workspaceSession` 取标签，
  挑 `dirty || eolChanged`、跳过 `readOnly` 与 `jdt://` 虚拟标签）+ `lib/fileSave.ts`
  （写盘逻辑从 `useFileSave` 抽成模块级 `saveOne`，退出流程复用同一份，不会两边漂移）。
  保存失败不自动 force 覆盖：冲突就中止退出、切到文件页并定位到第一个失败文件
- 2026-10-31 退出检查走 `quitGuard` 的顺序：先文件后事务（本地写盘几十毫秒，事务探测要过网络）；
  `saveAllDirty` 用**动态 import** 引入——`fileSave → editorStore → monacoSetup` 会把整个
  Monaco 拉进来，静态引入会让 node 环境的单测在加载时报 `window is not defined`
- 2026-10-31 补丁草稿：`lib/patchDraft.ts` 按工作区存 localStorage（勾选与改判层都是绝对路径，
  共用一份会串），`hooks/usePatchDraftPersist` 防抖 400ms 落盘。依赖必须传原始 `Set`/`Map`，
  传现场构造的数组会让 effect 每拍重跑、计时器永远重置，草稿一次都写不下去
- 2026-10-31 关窗即退出：删掉托盘常驻（`main.rs` 的 `TrayIconBuilder` / 菜单 / 状态圆点 / `branding::tray_tip_*`，以及随之无用的 `png` 依赖）、删掉「关窗时释放界面内存」的两模式开关（`AppConfig.release_webview_on_close` 与 `patch_config` 对应字段）、删掉 `RunEvent::ExitRequested{code:None}` 的 `prevent_exit()`（留着就成了关不掉的幽灵进程）与 macOS 点 Dock 重建窗口分支；`show_or_create_main_window` 退化成 single-instance 里的 `show + unminimize + focus`。旧的 `config.json` 里残留的 `release_webview_on_close` 会被 serde 忽略，不用迁移
- 2026-10-31 退出前事务确认：`commands/quit_cmds.rs` 三个原子位（`quit_approved` / `quit_acked` / `quit_checking`）+ 四个命令（`db_pending_tx` / `quit_check_acked` / `quit_cancel` / `app_quit`）。`CloseRequested` 同步回调不能 await，所以 `prevent_close()` 后发 `app:quit-request`，前端 ack 后才查；**5 秒没 ack 视为界面卡死直接放行**（否则 `prevent_close` 会让应用永远关不掉）。`db_pending_tx` 逐个连接发 `ping`（2 秒超时），`alive:false` 与超时一律标 `unknown` 而不是「干净」——后者会静默丢数据。前端 `lib/quitGuard.ts` 把后端（权威）与 `dbStore.rt.tx`（更及时）按连接取并集、语句数取大、开始时间取早；确认框宿主 `DbConfirmHost` 从 `DbTab` 上移到 `App`（否则在文件页点 × 看不见框），并自己 `import "../../db-console.css"`（它比数据库页先加载）
- 2026-10-31 悬停卡片「在数据库中打开」：`tableHover.openTableLink` 生成 `command:ncforge.openTable?<encodeURIComponent(JSON.stringify([表]))>`（Monaco 的 `CommandOpener` 把 query `decodeURIComponent` 后按 JSON 解析，且必须是数组）；`isTrusted` 用**白名单** `{ enabledCommands: [...] }` 而不是 `true`（`toAllowCommandsOption` 支持数组形式），命令用 `monaco.editor.addCommand` 注册——`run` 的第一个参数是服务访问器，命令参数从第二个开始（写成 `(table) => …` 会拿到对象、表现为"点了没反应"）。连接用 `db_schema_status` 回的 `connId`（悬停显示的就是那个库的字段），没连上走 `ensureConnected`（要口令弹全局框），切页复用已有的 `ncforge-navigate` 事件
- 2026-10-31 多工程后端（关联工程 + 覆盖表）：`eclipse_cp` 在「摊平目录」之外新增结构化视图 `graph() -> LinkedGraph{projects,extraDirs,notes,…}`——`name` 取 `.classpath` 里 `/X` 的写法而非 `.project` 自称名（`newar` 自称 `ar`，界面要能和 Eclipse 对得上号）；`root=null` = 声明了但磁盘上找不到；`disabled` 条目留壳（看得见被剪掉谁）只是不产目录。覆盖表 `AppConfig.linked_overrides`（`config.rs`，camelCase，缺省空 = 不影响既有路径）三个动作：`disable`（连同**只有它能传递到的**依赖一起连带剪掉）、`front`（排到主工程之后、其余依赖之前，标 `origin="front"`，主工程不可重复插入）、`add`（追加类目录/jar，不存在时写进 `notes` 而非报错）。`class_roots_with` 与 `graph()` 输出**逐项一致**（有测试断言，防「视图与真实类路径漂移」）；`launch.rs` / `compile.rs`(CompileEnv) / `shadow.rs`(ShadowSpec) 三处 spec 带 `overrides`，`server_cmds` 预览（:260）与启动（:461）共用同一份。命令 `commands/linked_cmds.rs`：`linked_projects(root?)`（不传用配置里的工作区，传了 = 切换工作区前的预演，不必先改配置）、`set_linked_overrides`（全量替换 + 落盘，坏条目**整体拒绝**——保存路径上的静默丢弃会让用户以为存上了、改半天不生效还找不到原因）；`config_io` schema 1→2 纳入导入导出。`nc_index` 模块层收敛成单一真源 `LAYERS[15] × SCOPES[3] = module_layers()` 45 条（extension → hyext → 标准，jar 紧跟本层），删掉 `MODULE_JAR_DIRS` / `MODULE_CLASS_DIRS` 两份各写一套的常量；`is_runtime_jar()` 排除 `_src.jar` / `_doc.jar`（与官方 `JarFilter` 一致）。`cargo test` 364 passed / 0 failed（默认 feature，16 个测试二进制）。前端「工程关联」页同日落地（依赖链只读视图 / 覆盖编辑 / 切换工作区预演），施工与坑见 `docs/交接-未完成功能-多工程前端与后续批次-20261031.md` §2
- 2026-10-30 双执行引擎：`db_engine.rs` 抽成「命令 + 参数 → JSON」的引擎接口（`EngineKind` + `Caps{cancel,refcursor,prop_decrypt,multi_session}`），命令层不感知底下是 JVM 还是驱动；`db_rust.rs` 用 Oracle 官方纯 Rust 驱动 `oracledb =26.0.0-beta.5`（thin）实现同一套命令（connect / exec / more / 事务 / tables / ncNames / columns / indexes / ddl / explain / schema / DBMS_OUTPUT），结果 JSON 与 JVM 桥逐字段对齐（日期 `yyyy-MM-dd HH:mm:ss`、**NUMBER 一律给字符串**——JDBC 那边是 BigDecimal，转 double 会掉精度；CLOB 截 1M、RAW 转十六进制）。引擎是**连接级**配置（`DbConnConfig.engine`，缺省 `java`）。取消：上游驱动没有 `break/cancel`（oracle/rust-oracledb#24），我们在 `desktop/vendor/oracledb`（`[patch.crates-io]` 挂到 26.0.0-beta.5，改动原因写在 `FORK.md`）里补了 `BreakHandle`——`AtomicBool` 标志 + 把阻塞读切成 100ms 片 + 持锁线程收到置位后发 `MARKER_TYPE_INTERRUPT` 再 `reset()`，`Caps.cancel` 因此为 `true`；另用 `set_call_timeout` 兜「语句在服务端排队」的情况。**#63** 也在同一份 vendor 里修：按 python-oracledb thin 的算法补齐 11G 密码验证器（`SHA1(password‖vfr)` 补 4 个零当 AES-192 key，会话密钥 MD5 拼 24 字节），12C 走 PBKDF2-SHA512 + `AUTH_PBKDF2_SPEEDY_KEY`；未知验证器类型与认证参数缺失不再 `unwrap()`，改为返回 `Error`（`catch_unwind` 保留作兜底）。prop.xml 来源不再强制 JVM：首次连接由 `NcDbBridge` 的 `propCred` 解一次口令 → `DPAPI` 加密落进连接配置（`db_cmds::prop_password_ready`），之后该连接可纯 Rust 直连。同引擎多连接合并、换引擎时旧句柄自动重建
- 2026-10-30 真库验收（19c @ 10.200.22.144）：新增 `tests/db_rust_live.rs`（纯 Rust 引擎全命令）与 `tests/db_engine_equiv.rs`（**同一批 SQL 两个引擎逐行对照**，含分页连取三页）。对照抓出并修掉 4 处与 JVM 桥不一致：NUMBER 取了数字（JDBC 给字符串）、`BINARY_FLOAT/DOUBLE` 读不出来、字符列精度没按 COLUMN_SIZE 给、驱动把 CLOB 列描述成 `LONG`；另有 2 处 SQL 写错（`explain` 的 `:1` 用两次只绑一次；`as size` 撞 19c 保留字）
- 2026-10-30 取消与 prop.xml 真库实测（同一台 19c）：`begin dbms_lock.sleep(30); end;` 执行中调 `cancel()`，**2.01 秒**返回错误、整条 3.01 秒结束，之后 `select 1 from dual` 正常——是语句中断不是把连接弄死；`propCred` 解出 url/user/口令后 `RustEngine` 直连成功（0.55 秒），即「解一次 → 之后不依赖 JVM」成立。11G 验证器只有单测（三组常量与 JCE 逐字节比对：`key24` / AES-192 密文 / MD5），本机建不出只有 11G 验证器的账号，真机暂未验
- 2026-10-30 数据库升级：`NcDbBridge` 重写（connect / connectProp / exec / more / commit / rollback / autocommit / 元数据 / explain，DBMS_OUTPUT、事务计数）；Rust 侧每个连接一个常驻 JVM（`AppState.db` 按连接 id 存桥），连接配置 `db_conns`（口令 DPAPI，前端只拿 `hasPassword`），首次启动把旧的单连接配置与 prop.xml 数据源迁移进来；prop.xml 口令改用 NC 的 `PropXMLReader` 解密（需 `basic.jar` + `fwcheck.jar` 上类路径），只在 Java 桥里出现明文。前端 `dbStore`（模块级状态）/ `dbActions`（流程）/ `dbConfirm`（提交回滚、生产确认、口令统一成 Promise），结果表手写虚拟滚动；桥里每连接只有一个游标，用 `claimCursor` 记归属，防止「加载更多」接错查询。移除旧的三层只读（语句白名单 / 只读事务 / 执行后回滚）与自治事务提醒
- 服务启停：`server.rs` 只做起进程 / 判活 / 杀进程树 / 增量读日志；classpath 与 VM 参数在 `launch.rs`；命令层 `commands/server_cmds.rs` 负责取配置、组装状态
- 停止用 `taskkill /T /F`：不带 `/F` 对控制台进程发的是 WM_CLOSE，java 没有窗口去收，会白等 3 秒
- 日志走「offset → 新增字节」，前端每 0.5 秒拉一次增量；状态 1 秒一次，窗口收进托盘时全停
- classpath 用 pathing jar：7230 个条目拼成字符串约 500KB，超 Windows 命令行 32767 字符上限；写成只有 `META-INF/MANIFEST.MF` 的空 jar，命令行只传 `-cp <jar>`
- 编译与启动服务共用 `launch::project_class_dirs`（工程 `.classpath` 声明的依赖闭包 → NC home 的六段散类目录 → jar；规则在 `eclipse_cp.rs`，见 2026-10-31 那条），否则会出现「编译过了、启动后加载的还是 jar 里的旧类」
- `AppConfig` 字段是 snake_case（没做 `rename_all`），前端类型与读写统一走 `lib/appConfig.ts`
- 版本控制页的工作副本是 **format 10**（SVN 1.6 时代每目录一份元数据）：命令行 svn 1.7+ 与 SVNKit 1.8+ 都拒绝打开、只肯让你 upgrade，而 upgrade 不可逆（升完 Eclipse 与同事都打不开）。所以只能内置 **SVNKit 1.3.5**（`ncsvn.jar` + 4 个依赖，共 3.0MB，随包资源）+ 一个 Java 桥
- 补丁落位规则不是重新发明的：`patch_view.rs` 把 `build-nc-patch.sh`（363 行、已出过十几个正式包）逐条落成纯函数——`ic/pu/so/arap` 四模块一律 hyext 不查 jar，其余模块只查该模块的 hyext jar，命中才升 hyext；并用真实工作副本比对过现有正式包，落位逐条一致
- **产物根断层**：真实 class 在 `<工程根>/out/<模块>/...`（实测 7424 个），而 M3 编译写的是 `<模块>/classes`。补丁页逐文件探测「配置根 → `<根>/out` → `<根>/<模块>/classes`」，并把实际用的根回报到界面——否则会把一个空目录打进包，服务器上「改了却没生效」
- 只读 SQL 不靠 Rust 拦：语句白名单、`SET TRANSACTION READ ONLY`、执行后 `rollback` 都在 Java 桥里（`ncdb.jar`，7.6KB，驱动复用 NC home 的 `driver/oracle_11g/ojdbc6.jar`，不随包发 2MB）
- ojdbc6 是 2010 年的驱动，没带 `META-INF/services/java.sql.Driver`，JDBC 4 的自动加载认不到，必须 `Class.forName("oracle.jdbc.OracleDriver")`——否则报「No suitable driver」，很容易被当成连不上库
- `prop.xml` 声明 gb2312，密码是 8 字节 DES 块、密钥在核心技术 jar 里（这台机器的 NC home 找不到对应类），**解不开就承认解不开**：URL / 用户名零配置读，密码首次手输 + DPAPI 记住，界面把这个取舍写清楚
- SVN 桥的常驻 JVM + 行协议抽成了 `java_bridge.rs`（`BridgeEnv` 带 `main_class` / `label` / `xmx_mb`），数据库桥只提供 env，不再复制一份进程管理
- 桥是**常驻进程**（stdin/stdout 行协议、JSON 逐行响应），不是一次一进程：JVM 启动 0.4s，审查时连点十几个 diff 无法接受。子进程带 `CREATE_NO_WINDOW`，不会闪黑框
- 桥**必须**传 `--config <自有目录>`：不传时 SVNKit 会改写用户 `%APPDATA%\Subversion\auth` 缓存（实测两次把口令密文抹成 95 字节）
- `doLog` 必须走 `SVNURL` 版：`File` 版在这个工作副本上静默返回 0 条（`Probe6/7` 定位），URL 由 `doInfo` 反查
- `svn status` 只报改动 7.6s／报全部条目 61.5s（12757 条），所以页面**不轮询**：进页面扫一次、手动刷新、写操作后重扫；已审勾选只更新本地覆盖表，不 invalidate 整条 status 查询
- 忽略规则在 Rust 里判定、但**只打标记不删条目**：页脚那个「显示全部」是纯前端过滤（实测 40ms），否则点一下要再等一轮 7.6s 全量扫描，而扫出来的东西完全一样；审查进度分母也固定不计构建产物
- 差异面板不解析 unified patch：BASE 从 SVNKit 取、工作副本从磁盘读，两份正文交给 Monaco diff editor 算词级差异，少一层 GBK/UTF-8 与换行往返；并关掉 `renderSideBySideInlineBreakpoint`（默认 900px 以下自动退化成单栏）
- 版本控制页样式前缀是 `vc-`：`services.css` 已占用 `sv-`，两份全局样式里 `.sv-page` / `.sv-head` / `.sv-btn` / `.sv-badge` 同名不同义，同时加载会互相污染
- 2026-10-28 代码智能（M4，**代码完成、待真机验收**）：内置 jdt.ls 0.57.0（跑在 NC 自带 JDK 1.8 上）提供补全 / 悬停 / 参数提示 / 跳转 / 实时诊断。`lsp.rs` 是带分帧与超时取消的 JSON-RPC 客户端，`shadow.rs` 为当前模块生成影子工程（junction + `.project` / `.classpath` / 编码 prefs，不写工作副本），`lang.rs` + `commands/lang_cmds.rs` 管会话与真实路径↔影子 URI 映射。关键实测：客户端必须声明 `classFileContentsSupport`，否则 jar 内类跳转一律为空；jar 源码靠 `.classpath` 的 `sourcepath="..._src.jar"`（约 62% 的 jar 没有配对，只显示方法签名）。真实 gl 模块首次打开约 40 秒、656MB，诊断与 ecj/Eclipse 一致。M4e 设置项：总开关 / 内存上限（512~4096 MB）/ 自动启动 / 重新生成影子工程；关掉后退回轻量模式，跳转用全文搜索按 `类名.java` 找声明行（不自建源码索引）。jdt.ls 随安装包分发：`scripts/fetch-jdtls.mjs` 在 predev / prebuild 时按固定版本（0.57.0）+ SHA-256 拉取并解压，只裁其它平台插件（约 55MB，不入库，仓库里只留占位 README）；运行时把 `config.ini` 拷到用户数据目录再用，安装目录保持只读，升级时按启动 jar 版本号清旧缓存。裁剪版已在真实 gl 模块上复测（就绪 31s，诊断与未裁剪一致）。设计与实测见 `docs/NCForge-代码智能-M4-方案设计-20261028.md`
- 2026-10-28 组件体量存量清空（三个文件都拆到 300 行门禁内，至此 `BASELINE` 全空）：`FileTree` 714 → 271（`useTreeLoad` 取数展开 / `useTreeEdit` 就地输入 / `useTreeDelete` 删除 / `TreeRow`+`TreeEditRow` 行 / `treeMenu` 菜单项）、`FilesTab` 589 → 258（`useFileSession` 标签生命周期 / `TreeHeader` `TabStrip` `EditorBanners` `EditorStatus` `NoWorkspace`）、`SearchTab` 430 → 101（`search/SearchBar` + `search/SearchResults`）。拆的全是搬运，DOM 结构与 `wb-*` 类名逐字保留，行为靠 FileTree 原有 9 个用例 + 新增的文件页/搜索页 6 个用例兜住
- 2026-10-28 审查修复（11 项，探针实测定位）：
  - 改端口半途失败不再留双份不一致配置：`nc_port::apply` 改成「全部算好 → 全部备份 → 逐个写 → 任一失败用备份回滚」，回滚自身再失败时错误里说清要去摸哪个 `.ncforge-bak`
  - `server_status` 整体移入 `spawn_blocking`：原来 `netstat` + `tasklist`（实测 247ms）每秒钉在 async 线程上，会把点按钮、拉日志全排在后面；端口占用者的进程名加 10 秒缓存，`tasklist` 从每秒一次降到按需
  - 配置读改写串行化：`AppState::update_config` 一把写锁圈住「读全量 → 改字段 → 落盘 → 更新内存」，设置页与服务页同时改配置不会再互相覆盖（旧行为是两边都显示保存成功，其实后写的把前一次的整个抹掉）
  - 日志轮询加「代」机制（`epochRef`）：换一代日志时在途的旧响应整份丢弃（内容和偏移都不能要），并补上新一代的第一拉——否则旧内容串台、offset 被旧文件长度带偏
  - 端口改派发依据从中文 label 换成 `PortEdit.kind`（`httpPort` / `ejbPort`），不再靠界面文案匹配
  - 堆上限规则单一出处：越界校验收在 `launch::validate_heap_mb`（报错，不夹边），`effective_heap_mb` 只给手改坏的配置兜底（夹边），两个目的分开各有单测
  - 「运行中不改端口」的守卫抽成 `port_edit_blocked`，预览与执行共用同一句判断与文案（旧实现两条文案分家，会出现预览放行、执行被拒）
  - 清理死代码 `CLIENT_MAIN_CLASS` / `default_client_vm_args`（端口写死 80 的客户端启动路径，从未接线）
  - 组件体量门禁：`ServicesTab` 的两个确认弹窗抽成 `ServiceConfirms.tsx`（289 行回到 300 上限内）；`FileTree` / `FilesTab` / `SearchTab` 三个 M4 存量文件按棘轮登记基线（只许变小）
  - 新增回归单测：`useServerLog`（换代丢弃 / 停止补拉）、`HeapField`（双保存守卫 / 恢复默认 / 越界拦截）、`launch::validate_heap_mb`、`port_edit_blocked`；后端 145 个、前端 100 个测试全过
- 2026-10-28 组件外置（方案 B，安装包 63.8MB → 实测 5,298,001 字节）：jdtls / ecj / svnkit 三个资源移出 `bundle.resources`，改为首次启动按需下载到 `config_dir/resources/`
  - Rust：`resource_pack.rs`（`ALL_PACKS` 清单 / 状态机 / SHA-256 校验 / 原子解压 / zip-slip 两遍式防护）+ `commands/resource_cmds.rs`（`resources_status` / `resources_ensure`，启动自检在 `main.rs` setup 内异步 spawn 不阻塞启动，8 个 `resource:*` 事件推进度）；jdtls / ecj / svnkit 三个 finder 先查外部资源根（`active_dir`），未命中再回退旧安装目录与源码树
  - 可重现 zip：`scripts/lib/zip-store.mjs` 零依赖 writer（store 模式 + `node:zlib` 的 `crc32`，zip 内写死 DOS 1980 时间戳）⇒ 同输入同字节 ⇒ version 取 sha256 前 12 位内容寻址；`pack-resources.mjs` 产 manifest（version / size / sha256 / platforms / title / notes，与 `ALL_PACKS` 一一对应），`generate-resources-json.mjs` 渲染多源 `resources.json`（url 模板 `{tag}/{filename}`，env 可覆盖）；zip 可读性经 Rust `zip` crate 真实解包逐字节验证
  - 安全：下载后逐字节比对 SHA-256、解压前全量校验条目名（`enclosed_name()`，`../` 与绝对路径当场拒绝）、临时目录解压完成后才 rename；`tests/resource_flow.rs` 覆盖正常全链路 / 坏 sha / zip-slip 三场景
  - CI 解耦：predev / prebuild 不再拉 54MB（应用构建与资源彻底分离），发版时才打包 + 生成清单，zip 与 `resources.json` attach 到 Release；Gitee 镜像同步 `resources-gitee.json`，raw 校验 url 必须为 `https://gitee.com/*`（gh-pages 源当前未启用、实测 404，保留只为哪天启用了 Pages 就自动活）
  - 前端：`ResourceContext`（镜像 UpdateContext：先注册 8 个监听再拉快照，规避 listen 异步竞态）+ `ResourceSetupDialog`（首启引导，Esc / 遮罩可关、会话级抑制）+ 设置页「组件」卡（状态徽章 / 版本 / 大小 / 重新下载）；纯逻辑层 `lib/resource.ts` 有单测
- 2026-10-29 资源链路审查修复（中危 2 + 低危 5，均有测试兜底）：
  - dev 构建默认跳过启动自检（M1）：`debug_assertions` 下不自动置备——开发期资源走源码树（`npm run jdtls:fetch` + finder 回退），首次 `tauri dev` 不再真下 63MB 也不再强制联网；设 `APP_RESOURCES_ENDPOINT` 或手动「重新下载组件」可强制启用
  - 多源修正（M2）：`resourcePacks.endpoints` 补 Gitee raw 镜像为第二源（此前实际只有 Release 一个可达——gh-pages 站点实测 404，国内直连 GitHub 慢时退化成单源）；测试断言「≥3 源、Release 打头、必须含 Gitee」防回归（2026-10-29 审查事故：Gitee 镜像推了但客户端 endpoints 里没有）
  - 错误路径带已完成部分（L2）：`ensure_packs` 失败返回 `EnsureFailure{outcome, message}` 而非裸字符串，`resource:error` 事件带 `installed` / `adoptedLegacy`，对话框显示「已就绪 N/3，重试将跳过已完成的包」
  - 设置页显示真实体积（L1）：`InstalledPack` 新增 `size`（下载成功 = 实收字节；legacy 认领 = 旧目录实测合计；`serde(default)` 兼容老状态文件，读成 None 不阻断）
  - 下载预分配上限 1GB → 64MB（L3）：防源声明超大 Content-Length 时一次性吃满内存；当前最大的 jdtls 约 54MB，超出上限后 Vec 自然增长，不影响下载
  - 对话框文案纠偏（L5）：「正在连接组件源…」→「正在准备组件…」（available 之后连接早已建立，旧文案在列表出现后失真）
  - 补测试（L4）：`resource_flow.rs` 场景 4 换源续传（源 1 坏 sha → 重试 2 次 → 换源 2 装对版本）；`resource_pack.rs` legacy 认领单测（认领生效、不下载、state 记实测大小、发 uptodate 不发 available）

- 2026-11-01 第 10~13 批加固要点（均有测试或门禁兜底）：
  - `java_bridge` 加「代数」（`Shared.gen`）：杀进程与读线程 EOF 收尾只清**自己那一代**的 `pending`。旧进程的读线程可能晚于新进程启动才走到 EOF，无条件 `clear()` 会把新进程上正在等的调用判成「桥已退出」——`clear_pending_for(gen)` 有单测覆这条时序。
  - 导出取消改为按实例 id：前端 `dbResultActions` 的 `activeExports: Map<tabId, exportId>`，Rust `export_cancels: HashMap<u64, AtomicBool>`，进度事件带 `exportId`，`finally` 只摘自己的登记（单测：取消 A 不影响 B、旧导出收尾不抹掉新的登记）。
  - 补丁出包「临时 zip → 备份旧包 → rename」：中途失败/取消不留半截包；`patch_build` 两个单测分别钉「取消先于读文件生效」与「备份路径返回且旧包原样保留」。
  - `AppState::update_config` 落盘移进 `spawn_blocking`：`fs::write` + `rename` 在杀软/机械盘上几十毫秒，会钉住 async 工作线程；写盘闸门照旧罩着，写入顺序不变。
  - `lang_request` 超时夹在 1~120 秒：0 会让请求发出去就判超时，过大则让卡死的 jdt.ls 调用长期占线程。
  - `svn_cred::find_cached` 空主机直接 `None`：`realm.contains("")` 恒真，等于退化成「取第一条」。
  - CSV 公式防护前后端同改（`db_file_export::formula_risk` / `lib/resultExport.formulaRisk`）：剥掉前导空白再判，挡住「导入器去前导空格后再求值」。
  - `editorStore` 的脏标记通知抽成 `lib/dirtyBus.ts`：`workspaceSession` 不再静态 import `editorStore`（它把 Monaco 拖进会话模块的依赖链），两处失效的测试 mock 一并删掉。
  - `useTableCheck` 代次守卫：换文件后晚到的旧请求结果直接丢弃；`useModuleCompile` 日志 80ms 合并 + 5000 行上限（截断行固定在最上面）；两处各有单测。
  - 门禁实跑：`cargo fmt --check` / `cargo clippy -D warnings` / `cargo test`（426 passed，1 ignored）、`tsc`、`eslint`、`vitest`（631 passed）、组件体量门禁、真实浏览器动效检查（10 项全过，含减弱动效与主题切换）、`node --test` 脚本测试（5 项）全绿。

### 改端口（`nc_port.rs`）
- 按**字节**替换，不重新编码：`prop.xml` 是 gb2312、`system.properties` 是 UTF-8，解码再编码会把中文注释搞成乱码；被改的标签与端口号都是 ASCII，字节级替换两头都不碰
- 只认 `<http>` 块里的 `<port>`；`<https>` 前缀相同，靠「下一个字符必须是 `>` 或空白」区分；值不是纯数字（`${nc.port}`）就拒绝，不猜
- `nc_port_apply` 内部**重新生成一次方案**再写：预览到点「应用」之间文件可能被 `sysConfig.bat` 改过，照旧方案写会把用户的改动盖掉
- 写完重读 `prop.xml` 复核，`verified=false` 时前端报错而不是谎报成功
- 实测真实配置：还原端口值后与原文件**逐字节完全一致**（2475→2477 字节，只多出 `8081` 比 `80` 多的 2 字节）

### 堆上限（`-Xmx`）
- `launch.rs`：`DEFAULT_HEAP_MB = 4096`、`HEAP_MIN_MB = 512`、`HEAP_MAX_MB = 65536`；
  `effective_heap_mb(Option<u32>)` 统一收口（`None` → 4G，越界夹边），只在拼参数时收口、不改配置
- 配置字段 `AppConfig.server_heap_mb: Option<u32>` 存 **MB 整数**，不存 `"4G"` 字符串：单位只在前端显示层换算（`formatHeapMb`：整 G 显示 `4 GB`，非整 G 保留 `3072 MB`），避免三处解析歧义
- `middleware_spec` 增加第 5 个参数 `heap_mb`，启动与「命令行预览」共用同一份入参——否则会出现「预览是 4G、真起的是 1G」这种查不出来的错位
- `server_heap_set(mb | null)`：越界报错不静默夹边；只写配置不动运行中的 JVM（堆是启动参数，必须重启）
- 顺带修掉通知容器未挂载：`main.tsx` 里 `<ToastProvider>` 从未包住 `<App />`，而 `toast()` 是模块级单例、靠 provider 的 effect 注入实现，没挂就是彻底的空操作——本次界面核对时「保存成功」一声不响才发现

## [0.0.9] - 2026-10-25

### 更新摘要
壳子预览版：三层资产初版拼齐，复制流程跑通。

### 新增
- 技术架构层：托盘/单实例/关窗销毁 webview/DWM 圆角
- 更新架构层：单飞闸 + 多源回退 + 可撤销自动重启

### 修复
- 修复设计预览页残留业务引用导致类型检查失败

## [0.1.0] - 2026-10-26

### 更新摘要
desktop-app-shell 壳子基线：复制即可开始新的桌面应用。

### 新增
- 三层架构资产：技术壳（托盘/单实例/窗口重建）、更新闭环（检查→下载→重启）、设计系统（token + 30+ 组件）
- rename-app.mjs 一键改名（11 处产品标识一次改齐）
- 示例页 HomeTab / SettingsTab 演示业务页写法

### 技术细节
- 版本真源为 src-tauri/Cargo.toml，另两处由 sync-version.mjs 同步
