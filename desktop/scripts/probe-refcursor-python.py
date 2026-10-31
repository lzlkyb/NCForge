#!/usr/bin/env python3
"""REF CURSOR 对照探针（python-oracledb thin）：给 Rust 侧的实现拿「标准答案」。

为什么要它：Rust 侧 R2/R3 只做到「报 UnknownTtcMessageType(27)」，证明服务端发了消息、
客户端不认。但「认了之后行从哪来」还没验证过：可能是同一次响应里内联下来，也可能是
客户端拿 cursor_id 再发一次 fetch。这两种情况在 Rust 里是两套完全不同的改动量，必须先定死。

python-oracledb thin 26.1.0 是 Oracle 官方同协议实现（方案文档 7.3 的参考对象）：

- 消息 27 的解析在 `impl/thin/messages/base.pyx` 的 `_process_implicit_result`：
  ub4 结果集个数 → 每个结果集 {ub1 len + len 字节, describe 块, ub2 cursor id}
- 对外 API 是 `cursor.getimplicitresults()`，返回**子游标**列表，子游标自己 fetch

本探针用「execute 耗时 vs fetch 耗时」把上面两种可能分开：若 fetch 走网络，1000 行
必然有可观测的额外耗时（一次 round trip 至少 ~0.3ms 局域网 + 解包），若内联则接近 0。

    python desktop/scripts/probe-refcursor-python.py

默认连测试库 aier260824 @ 10.200.22.144，账号 aier633。
"""

import os
import sys
import time

import oracledb

URL = os.environ.get("NC_RUST_URL", "10.200.22.144:1521/aier260824")
USER = os.environ.get("NC_RUST_USER", "aier633")
PASS = os.environ.get("NC_RUST_PASS", "aier633")


def ms(t0):
    return (time.perf_counter() - t0) * 1000


def dump_cursor(cur, label):
    """打印一个（子）游标的结构，返回 (列名, 行)。"""
    desc = cur.description or []
    cols = [d[0] for d in desc]
    t0 = time.perf_counter()
    rows = cur.fetchall()
    fetch_ms = ms(t0)
    print(f"    {label}: {len(cols)} 列 {cols}，{len(rows)} 行，fetch 耗时 {fetch_ms:.2f}ms")
    if rows[:3]:
        print(f"      前几行 {rows[:3]}")
    return cols, rows, fetch_ms


def case_implicit(conn, label, sql, expect_sets):
    """隐式结果集：dbms_sql.return_result。"""
    print(f"[{label}] {sql[:60]}...")
    cur = conn.cursor()
    t0 = time.perf_counter()
    try:
        cur.execute(sql)
    except Exception as exc:  # noqa: BLE001
        print(f"    !! execute 失败：{type(exc).__name__}: {exc}")
        return
    exec_ms = ms(t0)

    children = cur.getimplicitresults()
    print(f"    execute 耗时 {exec_ms:.2f}ms，拿到 {len(children)} 个子游标（期望 {expect_sets}）")
    total_fetch = 0.0
    for i, child in enumerate(children):
        cols, rows, f = dump_cursor(child, f"结果集#{i + 1}")
        total_fetch += f
        # 子游标自身还能再 fetch 吗（fetchmany 续取）
        try:
            more = child.fetchmany(5)
            print(f"      续取 fetchmany(5) → {len(more)} 行")
        except Exception as exc:  # noqa: BLE001
            print(f"      !! 续取失败：{exc}")
    print(f"    合计 fetch {total_fetch:.2f}ms（远大于 execute 说明行是**另外发 fetch 拉的**）")

    v = conn.cursor().execute("select 1 from dual").fetchone()[0]
    print(f"    之后 select 1 from dual = {v}\n")


def case_out_bind(conn):
    """OUT 绑定形态：open :1 for，用 DB_TYPE_CURSOR 声明。这是方案 B 的对照。"""
    print("[B] open :1 for（OUT 绑定，DB_TYPE_CURSOR）")
    cur = conn.cursor()
    rc = cur.var(oracledb.DB_TYPE_CURSOR)
    t0 = time.perf_counter()
    try:
        cur.execute(
            "begin open :1 for select table_name from all_tables where rownum <= 3; end;",
            [rc],
        )
    except Exception as exc:  # noqa: BLE001
        print(f"    !! execute 失败：{type(exc).__name__}: {exc}\n")
        return
    exec_ms = ms(t0)
    child = rc.getvalue()
    print(f"    execute 耗时 {exec_ms:.2f}ms，OUT 值类型 {type(child).__name__}")
    if child is None:
        print("    !! OUT 绑定拿回 None（协议上没回填 cursor id）\n")
        return
    dump_cursor(child, "OUT 游标")
    v = conn.cursor().execute("select 1 from dual").fetchone()[0]
    print(f"    之后 select 1 from dual = {v}\n")


def case_large(conn):
    """大结果集：判断「行是否内联」的关键样本。"""
    print("[L] 2000 行隐式结果集（判断行是否内联）")
    sql = (
        "declare rc sys_refcursor; "
        "begin open rc for select object_name, object_id from all_objects where rownum <= 2000; "
        "dbms_sql.return_result(rc); end;"
    )
    cur = conn.cursor()
    t0 = time.perf_counter()
    cur.execute(sql)
    exec_ms = ms(t0)
    children = cur.getimplicitresults()
    if not children:
        print("    !! 没有子游标\n")
        return
    t1 = time.perf_counter()
    rows = children[0].fetchall()
    fetch_ms = ms(t1)
    print(f"    execute {exec_ms:.2f}ms / fetch {fetch_ms:.2f}ms / {len(rows)} 行")
    print("    判读：fetch 远大于 execute ⇒ 行是单独 fetch 拉的（需要 cursor_id 再发请求）；")
    print("          fetch ≈ 0 ⇒ 行随 execute 响应内联到达（实现更简单）\n")


def case_sysrefcursor_num(conn):
    """边界：结果集 0 行。确认 0 行时 describe 元数据仍然完整（列名要有）。"""
    print("[Z] 0 行结果集（列元数据在不在）")
    sql = (
        "declare rc sys_refcursor; "
        "begin open rc for select table_name, tablespace_name from all_tables where 1 = 0; "
        "dbms_sql.return_result(rc); end;"
    )
    cur = conn.cursor()
    cur.execute(sql)
    children = cur.getimplicitresults()
    print(f"    子游标数 {len(children)}")
    for i, child in enumerate(children):
        dump_cursor(child, f"空结果集#{i + 1}")
    print()


def main():
    print(
        f"python-oracledb {oracledb.__version__}，"
        f"{'thin' if oracledb.is_thin_mode() else 'thick'} 模式，连接 {USER}@{URL}"
    )
    conn = oracledb.connect(user=USER, password=PASS, dsn=URL)
    print(f"服务端版本：{conn.version}\n")

    case_implicit(
        conn,
        "A1",
        "declare rc sys_refcursor; "
        "begin open rc for select 111 as a, 'abc' as b from dual; "
        "dbms_sql.return_result(rc); end;",
        1,
    )
    case_implicit(
        conn,
        "A2",
        "declare rc sys_refcursor; "
        "begin "
        "open rc for select 1 as n from dual; dbms_sql.return_result(rc); "
        "open rc for select 'x' as s from dual; dbms_sql.return_result(rc); "
        "end;",
        2,
    )
    case_out_bind(conn)
    case_large(conn)
    case_sysrefcursor_num(conn)

    print("结论要点（回写方案文档用）：")
    print("  1) 消息 27 的字节布局；2) 行是内联还是二次 fetch；3) OUT 绑定形态 python 能不能跑通")


if __name__ == "__main__":
    sys.exit(main())
