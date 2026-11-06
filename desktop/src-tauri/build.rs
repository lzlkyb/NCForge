fn main() {
    // bin 的 manifest 统一由下面这段 embed_resource 嵌入（rustc-link-arg 覆盖所有目标）。
    // 这里关掉 tauri-build 的默认 app manifest，否则 bin 会同时链接两份
    // RT_MANIFEST/ID 1，CVTRES 报 CVT1100「资源重复」直接链接失败。
    let attrs = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attrs).expect("tauri-build failed");

    // ─── Windows：给测试目标补嵌 comctl32 v6 manifest ───
    //
    // 背景（2026-10-27 实测定位，0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND）：
    // 一旦测试代码构建 mock 应用（tauri::test::mock_builder + generate_context!），
    // 链接器会把 wry 运行时（tauri-runtime-wry）的原生对话框代码拉进测试二进制，
    // 其导入表含 comctl32.dll!TaskDialogIndirect —— 该入口点只存在于 comctl32 v6。
    // app 二进制有 Common-Controls v6 manifest，加载器给 v6，相安无事；测试二进制
    // 没有 manifest，加载器给 comctl32 v5 ⇒ TaskDialogIndirect 缺失 ⇒ 进程启动即崩，
    // 连 libtest 的 "running tests" 都打不出来。
    //
    // 2026-11-06 追加：compile_for_tests 只发 rustc-link-arg-tests，覆盖不到 lib 自身
    // 的单元测试二进制（cargo test --lib 编的是 lib 目标），而增量重编时链接器同样可能
    // 把 wry 拉进去 —— 实测 lib 测试二进制也崩在 0xc0000139。所以改用
    // compile_for_everything（rustc-link-arg），bin 也一起嵌。manifest 内容与
    // tauri 默认的 windows-app-manifest.xml 完全一致（仅 CC v6 依赖），行为不变。
    //
    // （PE 导入表实测：故障二进制 253 个导入过程，唯一解析失败的就是
    // comctl32.dll!TaskDialogIndirect。）非 Windows 平台自动跳过。
    if std::env::var("CARGO_CFG_WINDOWS").is_ok() {
        let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR not set");
        let manifest_path = std::path::Path::new(&out_dir).join("tests-comctl32.manifest");
        std::fs::write(
            &manifest_path,
            r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#,
        )
        .expect("failed to write tests manifest");

        // RC 语法：资源名 1、类型 24（RT_MANIFEST）、引用上面的 manifest。
        // 写绝对路径，避开 rc.exe 相对路径解析的不确定性；
        // 反斜杠必须翻倍——RC 字符串里 \t 是 TAB 等转义，单杠会被吃掉（RC2135）。
        let rc_path = std::path::Path::new(&out_dir).join("tests-comctl32.rc");
        let manifest_in_rc = manifest_path.display().to_string().replace('\\', "\\\\");
        std::fs::write(
            &rc_path,
            format!("#pragma code_page(65001)\n1 24 \"{}\"\n", manifest_in_rc),
        )
        .expect("failed to write tests rc");

        embed_resource::compile_for_everything(&rc_path, embed_resource::NONE)
            .manifest_required()
            .unwrap();
    }
}
