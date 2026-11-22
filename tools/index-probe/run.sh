#!/usr/bin/env bash
# 声明索引探针 —— 复现 docs/NCForge-智能代码-实施方案-2026-11-21.md §4.1 的实测数字。
#
# 🔴 只用 1909home 自带的 1.8.0_202，**不需要另装 JDK**。这是本探针的第二个结论：
#    「context-free 声明索引」的成本与 JVM 版本无关，java-ls 要 JDK 17 是因为它自己的运行时。
#
# 用法（Git Bash）：
#   tools/index-probe/run.sh                 # 全工作区，源码 + jar
#   tools/index-probe/run.sh ic              # 只跑子目录（快速自检）
#   NC_HOME=/d/ncc/1909home NC_WS=/c/work/aier/newar NC_THREADS=8 tools/index-probe/run.sh
#
# S0 binding resolve 探针（窗口期精确解析的止损门，见
# docs/NCForge-窗口期精确解析-设计方案-2026-11-21.md §6.1）——上面 run.sh 顺带编译它，单跑：
#   CP=$(cygpath -w <plugins/*.jar 逐个拼上，分号分隔>)
#   java -Xmx768m -cp "out;$CP" ResolveProbe \
#        "$NC_WS" "<config_dir>/lang/shadow/.classpath" \
#        "$NC_WS/ct/src/private/nc/bs/ct/aier/daily/AierPrintCtDailyBO.java" 892 3 \
#        nc.bs.ct.aier.daily.BaseSignCtDaily
#   归因开关：RESOLVE_PROBE_NO_BOOT=1（去 VM boot）/ RESOLVE_PROBE_MINIMAL=1（只留 1 源根）
#   I/O 施压（另起进程）：java -cp "out;$CP" ResolveProbe pressure <jars.txt> 75 4
#
# 另有两个一次性排障探针，结论已沉淀进 desktop/src-tauri/ecj-bridge/BindingResolver.java
# 的注释（QNR 逐 token 归属、ClassScope 重载两处「TraverseDump 探针坐实」）——默认流程
# 不跑它们，但 javac 会带上（保证不过期腐烂），按需单跑：
#   java -cp "out;$CP" FsProbe <源根>...                       # 名字环境找类型（GBK）
#   java -cp "out;$CP" TraverseDump <srcRoot> <file.java> [offset...]
#                                                                  # dump traverse 实际访问的节点
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NC_HOME="${NC_HOME:-/d/ncc/1909home}"
NC_WS="${NC_WS:-/c/work/aier/newar}"
NC_THREADS="${NC_THREADS:-8}"
JDK_BIN="$NC_HOME/ufjdk/bin"
OUT="$ROOT/desktop/target/index-probe"
TARGET="${1:-}"

[ -x "$JDK_BIN/javac.exe" ] || { echo "缺 NC 自带 JDK: $JDK_BIN/javac.exe"; exit 1; }
mkdir -p "$OUT/out"
cd "$OUT"

# 70 个插件 jar 全进 classpath：ASTParser 只依赖 jdt.core，但 core.runtime 会一路拽 osgi/equinox
CP=""
for f in "$ROOT"/desktop/src-tauri/resources/jdtls/plugins/*.jar; do
  CP="$CP;$(cygpath -w "$f")"
done
CP="${CP#;}"

echo "== 编译探针 =="
# 源文件路径也要过 cygpath：javac.exe 是 Windows 程序，拿到 /d/... 会解析成 \d\...
# FsProbe / TraverseDump 是一次性排障探针（默认不跑，带上只为不过期腐烂）
MSYS2_ARG_CONV_EXCL='*' "$JDK_BIN/javac.exe" -encoding UTF-8 -nowarn -cp "$CP" -d out \
  "$(cygpath -w "$ROOT/tools/index-probe/IndexProbe.java")" \
  "$(cygpath -w "$ROOT/tools/index-probe/JarProbe.java")" \
  "$(cygpath -w "$ROOT/tools/index-probe/ResolveProbe.java")" \
  "$(cygpath -w "$ROOT/tools/index-probe/FsProbe.java")" \
  "$(cygpath -w "$ROOT/tools/index-probe/TraverseDump.java")"

SRC="${NC_WS}${TARGET:+/$TARGET}"
echo "== 源码侧：$SRC =="
MSYS2_ARG_CONV_EXCL='*' "$JDK_BIN/java.exe" -Dfile.encoding=UTF-8 -cp "out;$CP" -Xmx3g \
  IndexProbe "$(cygpath -w "$SRC")" "$NC_THREADS"

# jar 侧只取 external/lib：这是第三方库主体；modules/*/lib 是每模块一份的重复副本，
# 全扫会虚高约 6 倍（2026-11-21 实测 6930 vs 589）。
echo "== jar 侧：external/lib =="
find "$NC_HOME/external/lib" -maxdepth 2 -name '*.jar' 2>/dev/null \
  | while read -r f; do cygpath -w "$f"; done > jars-ext.txt
echo "jars=$(wc -l < jars-ext.txt)"
MSYS2_ARG_CONV_EXCL='*' "$JDK_BIN/java.exe" -Dfile.encoding=UTF-8 -cp "out;$CP" -Xmx3g \
  JarProbe jars-ext.txt "$NC_THREADS"
