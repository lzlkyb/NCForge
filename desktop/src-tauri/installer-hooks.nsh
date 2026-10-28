; NSIS 安装器钩子模板（壳子默认空实现）。
;
; 这个文件是「安装/卸载期需要管理员权限才能做的事」的挂点。壳子默认什么都不做；
; 业务需要时（典型：写 Windows 防火墙入站规则、注册 URL协议、装字体）在此展开，
; 并把 tauri.conf.json 的 bundle.windows.nsis.installerHooks 指向它。
;
; 承自 cc-bridge 的三条经验，照做前先读：
; 1. program 必须用 ${MAINBINARYNAME}（Tauri 模板顶部已 !define），不得写死 exe 名——
;    productName 与 Cargo package 名可能不同，写死会让规则指向不存在的文件，
;    netsh 照样返回 0、规则看着也在，却永远不生效。
; 2. netsh 规则要 profile=any（省略实测只落到 Public，域/专用网络下完全不生效），
;    且「先 delete 再 add」保证幂等，重装/升级不堆积重复规则。
; 3. 失败不能中止安装：Tauri 默认 installMode 是 currentUser（不提权），netsh 会因
;    权限不足失败。这是可接受的—— DetailPrint 说明即可，应用内提供「一键修复」兜底。
;
; 可用宏：NSIS_HOOK_POSTINSTALL / NSIS_HOOK_PREUNINSTALL
;        （Tauri 在构建时把本文件内容注入生成的安装器脚本）

!macro NSIS_HOOK_POSTINSTALL
  ; 示例（默认注释掉）：为 7823/TCP 写入防火墙入站规则
  ; DetailPrint "配置 Windows 防火墙入站规则 (7823/TCP)..."
  ; nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="MyApp" dir=in'
  ; Pop $0
  ; nsExec::ExecToLog 'netsh advfirewall firewall add rule name="MyApp (7823/TCP)" dir=in action=allow protocol=TCP localport=7823 profile=any enable=yes program="$INSTDIR\${MAINBINARYNAME}.exe"'
  ; Pop $0
  ; ${If} $0 == 0
  ;   DetailPrint "防火墙规则已写入。"
  ; ${Else}
  ;   DetailPrint "写入防火墙规则未成功（通常是安装器未提权）。"
  ; ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 示例（默认注释掉）：卸载时清理同名规则
  ; nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="MyApp (7823/TCP)" dir=in'
  ; Pop $0
!macroend
