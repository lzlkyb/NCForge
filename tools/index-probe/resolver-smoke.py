# -*- coding: utf-8 -*-
#!/usr/bin/env python3
# BindingResolver 协议冒烟测试（S2 验收：协议编解码 + 真实工程解析）。
#
# 驱动 ncecj.jar 的第三个入口（BindingResolver），走与 java_bridge.rs 完全相同的
# 行协议：`id \t cmd \t argsFile`。断言：
#   ① init 拿到影子工程同一份 classpath（154 源根 + 1204 jar + 167 类目录）
#   ② resolve 继承成员案例：AierPrintCtDailyBO.getBaseDAO() →
#      nc.bs.ct.aier.daily.BaseSignCtDaily#getBaseDAO（S0/S2a 的期望值）
#   ③ 同文件二次 resolve（CU 缓存命中）结果一致
#   ④ invalidate 后冷走全流程，结果仍一致
#   ⑤ resolve 参数缺字段 → ok:false（协议健壮性）
#
# 跑法（与同目录 run.sh 同一套环境变量，换机/换工程不用改文件）：
#   python tools/index-probe/resolver-smoke.py
#   NC_HOME=/d/ncc/1909home NC_WS=/c/work/aier/newar \
#   NCFORGE_CONFIG_DIR="/c/Users/me/AppData/Roaming/io.github.lzlkyb.ncforge" \
#     python tools/index-probe/resolver-smoke.py
import json
import os
import re
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))  # tools/index-probe → 仓库根

# 只有 NC 安装根与工作区是「每台机器不同」的，走环境变量；其余从仓库根/配置目录推导。
NC_HOME = os.environ.get("NC_HOME", r"D:\ncc\1909home")
WS = os.environ.get("NC_WS", r"C:\work\aier\newar")
CONFIG_DIR = os.environ.get(
    "NCFORGE_CONFIG_DIR",
    os.path.expandvars(os.path.join("%APPDATA%", "io.github.lzlkyb.ncforge")),
)
SHADOW_CP = os.path.join(CONFIG_DIR, "lang", "shadow", ".classpath")
JAVA = os.path.join(NC_HOME, "ufjdk", "bin", "java.exe")
JAR = os.path.join(_REPO, "desktop", "src-tauri", "resources", "ecj-bridge", "ncecj.jar")
PLUGINS = os.path.join(_REPO, "desktop", "src-tauri", "resources", "jdtls", "plugins")
CU = os.path.join(WS, r"ct\src\private\nc\bs\ct\aier\daily\AierPrintCtDailyBO.java")
OFFSET = 892  # getBaseDAO() 的 offset（S0 探针同款）

ENTRY = re.compile(r'<classpathentry\b(.*?)/>', re.DOTALL)
KIND = re.compile(r'kind="([^"]+)"')
PATH = re.compile(r'path="([^"]+)"')


def build_cp_file(dst):
    """影子工程 .classpath → 扁平 classpath 清单：源根在前（workspace 相对 → 绝对），jar/类目录随后。"""
    xml = open(SHADOW_CP, encoding="utf-8").read()
    srcs, libs = [], []
    for m in ENTRY.finditer(xml):
        a = m.group(1)
        km, pm = KIND.search(a), PATH.search(a)
        if not km or not pm:
            continue
        kind, path = km.group(1), pm.group(1)
        if kind == "src":
            srcs.append(os.path.join(WS, path.replace("/", os.sep)))
        elif kind == "lib":
            libs.append(path)
    entries = srcs + libs
    with open(dst, "w", encoding="utf-8") as f:
        f.write("\n".join(entries))
    return len(srcs), len(libs)


def write_json(dst, obj):
    with open(dst, "w", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False))


def esc(s):
    """与 java_bridge.rs 的 escape 完全一致：\ → \\，制表/换行/回车转义。"""
    return (
        s.replace("\\", "\\\\")
        .replace("\t", "\\t")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
    )


def call(proc, cid, cmd, argfile):
    line = "%d\t%s\t%s\n" % (cid, cmd, esc(argfile))
    proc.stdin.write(line.encode("utf-8"))
    proc.stdin.flush()
    resp = proc.stdout.readline().decode("utf-8")
    return json.loads(resp)


def main():
    tmp = tempfile.mkdtemp(prefix="bindres-")
    cp_file = os.path.join(tmp, "cp.txt")
    n_src, n_lib = build_cp_file(cp_file)
    print("classpath: 源根=%d lib=%d（jar+类目录）" % (n_src, n_lib))

    arg_file = os.path.join(tmp, "resolve.json")
    write_json(arg_file, {"path": CU, "offset": OFFSET})

    cp = [JAR] + [
        os.path.join(PLUGINS, f) for f in os.listdir(PLUGINS) if f.endswith(".jar")
    ]
    proc = subprocess.Popen(
        [JAVA, "-Dfile.encoding=UTF-8", "-Xmx768m", "-cp", ";".join(cp), "BindingResolver"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    fails = []

    def check(name, cond, detail=""):
        print("  [%s] %s %s" % ("PASS" if cond else "FAIL", name, detail))
        if not cond:
            fails.append(name)

    try:
        r = call(proc, 1, "init", cp_file)
        print("init →", json.dumps(r, ensure_ascii=False))
        check("init ok", r.get("ok") is True)
        d = r.get("data") or {}
        check("init entries", d.get("entries") == n_src + n_lib, str(d.get("entries")))
        check("init rtJar", d.get("rtJar") is True, "rtFound=%s" % d.get("rtJar"))

        # ② 冷查询（环境预热 + 闭包构建，S2a 实测 ~1s）
        r = call(proc, 2, "resolve", arg_file)
        print("resolve#1 →", json.dumps(r, ensure_ascii=False))
        d = r.get("data") or {}
        check("resolve#1 ok", r.get("ok") is True)
        check(
            "resolve#1 继承成员",
            d.get("kind") == "method"
            and d.get("fqcn") == "nc.bs.ct.aier.daily.BaseSignCtDaily"
            and d.get("name") == "getBaseDAO",
            "kind=%s fqcn=%s name=%s problems=%s" % (d.get("kind"), d.get("fqcn"), d.get("name"), d.get("problems")),
        )

        # ③ CU 缓存命中（同文件同内容）
        r = call(proc, 3, "resolve", arg_file)
        d = r.get("data") or {}
        check(
            "resolve#2 缓存命中一致",
            d.get("fqcn") == "nc.bs.ct.aier.daily.BaseSignCtDaily" and d.get("name") == "getBaseDAO",
            json.dumps(d, ensure_ascii=False),
        )

        # ④ invalidate（整体 reset + 清缓存）后冷走全流程
        path_file = os.path.join(tmp, "paths.txt")
        with open(path_file, "w", encoding="utf-8") as f:
            f.write(CU + "\n")
        r = call(proc, 4, "invalidate", path_file)
        print("invalidate →", json.dumps(r, ensure_ascii=False))
        check("invalidate ok", r.get("ok") is True)
        check("invalidate cachedCleared", (r.get("data") or {}).get("cachedCleared") == 1)

        r = call(proc, 5, "resolve", arg_file)
        d = r.get("data") or {}
        check(
            "resolve#3 冷重建一致",
            d.get("fqcn") == "nc.bs.ct.aier.daily.BaseSignCtDaily" and d.get("name") == "getBaseDAO",
            json.dumps(d, ensure_ascii=False),
        )

        # ⑤ 协议健壮性：缺 offset → ok:false
        bad_file = os.path.join(tmp, "bad.json")
        write_json(bad_file, {"path": CU})
        r = call(proc, 6, "resolve", bad_file)
        check("缺 offset 报错", r.get("ok") is False, json.dumps(r, ensure_ascii=False))

        # offset 落在空白处 → data:null（不报错，调用方退回内容搜索）
        blank_file = os.path.join(tmp, "blank.json")
        write_json(blank_file, {"path": CU, "offset": 0})
        r = call(proc, 7, "resolve", blank_file)
        check("offset=0 回 null", r.get("ok") is True and r.get("data") is None,
              json.dumps(r, ensure_ascii=False))

        # quit 不回帧（与 NcEcjBridge 一致）：只发不等
        proc.stdin.write(("%d\tquit\n" % 8).encode("utf-8"))
        proc.stdin.flush()
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.wait(timeout=10)
        err = proc.stderr.read().decode("utf-8", "replace")
        if err.strip():
            print("--- stderr ---")
            print(err[:2000])

    print()
    if fails:
        print("FAILED: %s" % ", ".join(fails))
        sys.exit(1)
    print("ALL PASS（真实工程）")
    synthetic()


PARENT = """package probe;

public class Parent {
    protected String label = "p";
    public static final String TAG = "t";

    public String greet(String who) {
        return label + who;
    }
}
"""

# 纯 ASCII ⇒ 字节偏移 == UTF-16 code unit 偏移，可直接用 str.find 定位。
CHILD = """package probe;

public class Child extends Parent {
    public void run() {
        String local = "x";
        Child p = new Child();
        System.out.println(p.greet(local));
        System.out.println(p.label);
        System.out.println(p.label.length());
        System.out.println(Parent.TAG);
    }
}
"""

# (说明, 要找的串, 标识符在串内的起始下标, 期望 kind, 期望 fqcn, 期望 name)
# 纯 ASCII ⇒ 字节偏移 == UTF-16 code unit 偏移，offset = find(needle) + 下标。
# QNR 逐 token 归属（2026-11-21 TraverseDump 坐实）：c.inst 点 c → 局部，点 inst → 字段；
# 类型.静态字段 点字段 → 字段（binding 即最终答案），点类型名 → null（交回内容搜索兜底）。
SYN_CASES = [
    ("extends 的类型引用", "extends Parent", 8, "type", "probe.Parent", "Parent"),
    ("局部变量用法", "greet(local)", 6, "local", None, "local"),
    ("继承方法调用", "p.greet(", 2, "method", "probe.Parent", "greet"),
    ("继承字段访问", "p.label", 2, "field", "probe.Parent", "label"),
    ("QNR 接收段点局部", "p.label", 0, "local", None, "p"),
    ("静态字段链点字段", "Parent.TAG", 7, "field", "probe.Parent", "TAG"),
    ("静态字段链点类型名走兜底", "Parent.TAG", 0, None, None, None),
    ("链式调用点方法名", "p.label.length()", 7, "method", "java.lang.String", "length"),
    ("new 的构造器归一到类", "new Child()", 4, "type", "probe.Child", "Child"),
    ("方法声明名不是引用", "public void run()", 12, None, None, None),
]


def synthetic():
    """合成小工程：一个 src 根、零 jar，用确定性 offset 钉住五种 kind 的归属。"""
    tmp = tempfile.mkdtemp(prefix="bindres-syn-")
    src = os.path.join(tmp, "src", "probe")
    os.makedirs(src)
    child_path = os.path.join(src, "Child.java")
    # 🔴 newline="\n"：Windows 文本模式会把 \n 写成 \r\n，offset 全偏（2026-11-21 踩过：
    # 六个用例全错但现象酷似「traverse 不下降」，实际是每行 +1 的偏移错位）。
    with open(os.path.join(src, "Parent.java"), "w", encoding="utf-8", newline="\n") as f:
        f.write(PARENT)
    with open(child_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(CHILD)

    cp_file = os.path.join(tmp, "cp.txt")
    with open(cp_file, "w", encoding="utf-8", newline="\n") as f:
        f.write(os.path.join(tmp, "src"))

    jar = r"D:\AItool\winapp\nc-workbench\desktop\src-tauri\resources\ecj-bridge\ncecj.jar"
    plugins = r"D:\AItool\winapp\nc-workbench\desktop\src-tauri\resources\jdtls\plugins"
    cp = [jar] + [os.path.join(plugins, f) for f in os.listdir(plugins) if f.endswith(".jar")]
    proc = subprocess.Popen(
        [r"D:\ncc\1909home\ufjdk\bin\java.exe", "-Dfile.encoding=UTF-8", "-Xmx512m",
         "-cp", ";".join(cp), "BindingResolver"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    fails = []

    def check(name, cond, detail=""):
        print("  [%s] %s %s" % ("PASS" if cond else "FAIL", name, detail))
        if not cond:
            fails.append(name)

    try:
        r = call(proc, 1, "init", cp_file)
        check("syn init ok", r.get("ok") is True, json.dumps(r, ensure_ascii=False))
        for i, (desc, needle, char_pos, kind, fqcn, name) in enumerate(SYN_CASES):
            # offset 从**落盘文件**回读计算（而不是内存字符串）——防任何换行/编码改写
            with open(child_path, "rb") as bf:
                on_disk = bf.read().decode("utf-8")
            start = on_disk.find(needle)
            assert start >= 0, "用例串没找到：" + needle
            offset = start + char_pos  # 标识符首字符
            arg_file = os.path.join(tmp, "r%d.json" % i)
            write_json(arg_file, {"path": child_path, "offset": offset})
            r = call(proc, 10 + i, "resolve", arg_file)
            d = r.get("data")
            if kind is None:
                check("syn %s → null" % desc, r.get("ok") is True and d is None,
                      json.dumps(d, ensure_ascii=False))
            else:
                check(
                    "syn %s" % desc,
                    d is not None and d.get("kind") == kind and d.get("fqcn") == fqcn
                    and d.get("name") == name,
                    json.dumps(d, ensure_ascii=False),
                )
        proc.stdin.write(b"99\tquit\n")
        proc.stdin.flush()
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.wait(timeout=10)
        err = proc.stderr.read().decode("utf-8", "replace")
        if err.strip():
            print("--- stderr ---")
            print(err[:2000])
    print()
    if fails:
        print("SYNTHETIC FAILED: %s" % ", ".join(fails))
        sys.exit(1)
    print("ALL PASS（合成工程）")


if __name__ == "__main__":
    main()
