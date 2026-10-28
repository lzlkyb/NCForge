# jdt.ls（构建时生成，不入库）

这个目录的内容由 `desktop/scripts/fetch-jdtls.mjs` 在 `predev` / `prebuild` 时生成：按固定版本（0.57.0）
从 Eclipse 下载、校验 SHA-256、解压并裁掉其它平台的插件。

它跟 `resources/ecj` 不同：那个只有 6.7MB 直接入库，这里裁剪后仍约 55MB，不适合进 git。
这个 README 留着是为了让 `tauri.conf.json` 的 resources 映射在还没拉取时（比如只跑 `cargo test`）也不报「资源不存在」。

手动准备：`node scripts/fetch-jdtls.mjs`（离线机器用 `NCFORGE_JDTLS_TARBALL` 指定本地 tar.gz）。
