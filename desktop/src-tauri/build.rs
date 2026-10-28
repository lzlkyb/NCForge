fn main() {
    tauri_build::build();

    // ─── Windows：给测试目标补嵌 comctl32 v6 manifest ───
    //
    // 背景（2026-10-27 实测定位，0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND）：
    // 一旦测试代码构建 mock 应用（tauri::test::mock_builder + generate_context!），
    // 链接器会把 wry 运行时（tauri-runtime-wry）的原生对话框代码拉进测试二进制，
    // 其导入表含 comctl32.dll!TaskDialogIndirect —— 该入口点只存在于 comctl32 v6。
    // app 二进制有 tauri-build 内嵌的 Common-Controls v6 manifest，加载器给 v6，
    // 相安无事；但 tauri-build 经 embed_resource 只对 bin 目标嵌 manifest
    // （cargo:rustc-link-arg-bins），测试目标不是 bin，拿不到 manifest，
    // 加载器便给 comctl32 v5 ⇒ TaskDialogIndirect 缺失 ⇒ 进程启动即崩，
    // 连 libtest 的 "running tests" 都打不出来。
    //
    // 修复：给测试目标单独嵌一份同样的 comctl32 v6 依赖 manifest。
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

        embed_resource::compile_for_tests(&rc_path, embed_resource::NONE)
            .manifest_required()
            .unwrap();
    }
}
