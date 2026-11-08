# 数据库 JVM 组件（占位）

这个目录在仓库里**只有这份说明**。真正的内容（`jre/`、`ojdbc/`）按需下载，约 100MB，
由 `desktop/scripts/fetch-ncdb.mjs` 准备：

```bash
cd desktop
node scripts/fetch-ncdb.mjs            # 下载 JRE + ojdbc 并校验 SHA-256
node scripts/fetch-ncdb.mjs --force    # 重新下载解压
```

发版打包时 `scripts/pack-resources.mjs` 会自动调用它（检测到 `ojdbc/` 缺失就补），
打成 `ncdb.zip` 作为资源包分发，客户端在「设置 → 组件」里按需下载。

## 里面是什么

| 路径 | 内容 | 为什么是它 |
|---|---|---|
| `jre/` | Zulu 8（OpenJDK 8u512）JRE，不带 JavaFX | `NcDbBridge` 按 1.8 编译；ojdbc6 在 JDK 11+ 会碰到被移除的内部 API |
| `ojdbc/ojdbc6.jar` | Oracle JDBC 驱动 11.2.0.4 | 与 11g 库配套；驱动版本跟着数据库走 |
| `LICENSE-oracle.txt` | Oracle FUTC 许可证副本 | FUTC 要求随附许可证才能再分发未修改的程序 |
| `jre/LICENSE` | Zulu 分发包自带的 GPLv2 + Classpath Exception | 驱动包原样分发，不动里面的声明 |

## 客户端怎么用它

`src-tauri/src/jvm_runtime.rs` 按 **NC home → 本组件 → 系统 Java** 的顺序找一套
「Java + Oracle 驱动」。装了 NC 的机器行为完全不变；没有 NC 但下了本组件，
JVM 桥（REF CURSOR、多会话等）照样可用；两样都没有时连接会**自动降级到纯 Rust
驱动**并在界面上说明原因，不会直接连不上。

## 为什么要外置

JRE 解压后 97MB，而绝大多数用户（纯 Rust 驱动够用）根本不需要它。塞进安装包会让
每次自动更新都重下这 100MB —— 与 jdtls / ecj / svnkit 外置是同一个理由。
