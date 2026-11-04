# jdt.ls 扩展 bundle

jdt.ls 0.57 没有 LSP 的 TypeHierarchy（类清单里没有对应 handler），但提供
`org.eclipse.jdt.ls.core.delegateCommandHandler` 扩展点。这里用一个小 bundle
在 jdt.ls 进程内补上：

| 命令 | 作用 |
|---|---|
| `ncforge.typeHierarchy` | 参数 `[{uri, line, character}]`，返回 `{type, supertypes, subtypes}`（含 `depth` / `direct` / `kind` / `location`） |
| `ncforge.includeType` | 参数 `[{uri, jars, order, projectRoot}]`，按 NC 全局覆盖顺序加入 Rust 索引选出的 jar 与源码附件；同步核对并只修改生成的影子工程 |
| `ncforge.completionMetadata` | 参数 `[completionItem.data]`，通过 JDT model 查询废弃标记；仅在候选 resolve 时调用 |

类型层级客户端走 `workspace/executeCommand`；按需依赖仅经 Rust 的
`ncforge/resolveTypeCompletion` 受控入口调用，客户端不能直接传 jar 路径。
影子工程的 URI 映射由 Rust 侧（`LangSession::to_server / from_server`）负责。

## 目录

- `src/ncforge/jdt/TypeHierarchyHandler.java` —— 类型层级（JDT 的 `IType.newTypeHierarchy`）
- `src/ncforge/jdt/IncludeTypeHandler.java` —— 补全选中未加载的 NC 类后，同步扩充 JDT 类路径
- `src/ncforge/jdt/CompletionMetadataHandler.java` —— 补齐旧版 JDT LS 未返回的废弃标记
- `MANIFEST.MF` / `plugin.xml` —— OSGi bundle 声明（`Require-Bundle` 带 jdt.ls core，
  与微软的 java-debug 同一写法；`Import-Package` 会被 `x-friends` 挡住）
- 成品在 `../resources/jdtls-ext/ncforge-jdt-ext.jar`（约 10KB，跟 ncdb.jar 一样入库）；bundle 版本 1.1.0，避免复用旧 OSGi 缓存

## 构建

```bash
node scripts/build-jdtls-ext.mjs        # 需要先 fetch-jdtls.mjs（编译 classpath 来自 jdt.ls 的 plugins/）
node scripts/build-jdtls-ext.mjs --dry  # 只编译，不覆盖 jar
```

改了 Java 源码必须重新打包，否则会出现「源码改了、行为没变」。字节码必须是
Java 8（`major version 52`）——本机 `JAVA_HOME` 可能指向 NC65 自带的 JDK 7，
脚本会自己挑 ≥8 的 javac。

## 挂载

`lang_start` 把 jar 的绝对路径放进 `initializationOptions.bundles`
（和 java-debug 一起）。装不上时语言服务照常起，只是类型层级入口会报「没有模型」。
