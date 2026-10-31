#!/usr/bin/env python3
"""取消延迟对照探针：用 python-oracledb thin 在同一台库上测 cancel() 延迟。

为什么要它：Rust 探针测出的 2 秒无法说明是「19c 服务端慢」还是「我们的实现差」。
python-oracledb thin 是 Oracle 官方同协议实现（v26.1.0，方案文档 7.3 的参考对象），
它对 cancel() 的实现是 `_break_external()`：服务端协商支持 OOB 就发 TCP urgent data，
否则退回 in-band interrupt marker。两边数字一对比，归属立刻清楚。

    python desktop/scripts/probe-cancel-python.py

默认连测试库 aier260824 @ 10.200.22.144，账号 aier633。
"""

import os
import sys
import threading
import time

import oracledb

URL = os.environ.get("NC_RUST_URL", "10.200.22.144:1521/aier260824")
USER = os.environ.get("NC_RUST_USER", "aier633")
PASS = os.environ.get("NC_RUST_PASS", "aier633")


def probe(conn, sql, cancel_after, label):
    """在 cancel_after 秒后从另一个线程调 cancel()，返回 (耗时 ms, 结果)。"""
    result = {}

    def worker():
        time.sleep(cancel_after)
        result["t0"] = time.perf_counter()
        try:
            conn.cancel()
            result["cancel_err"] = None
        except Exception as exc:  # noqa: BLE001
            result["cancel_err"] = exc

    t_start = time.perf_counter()
    th = threading.Thread(target=worker, daemon=True)
    th.start()
    err = None
    try:
        conn.cursor().execute(sql).fetchall()
    except Exception as exc:  # noqa: BLE001
        err = exc
    elapsed_ms = (time.perf_counter() - t_start) * 1000
    th.join(timeout=5)

    cancel_to_return = ""
    if "t0" in result and err is not None:
        # cancel() 调用到语句报错之间的间隔：这才是「取消真正生效」的部分
        cancel_to_return = f"，cancel→报错 {(elapsed_ms - (result['t0'] - t_start) * 1000):.0f}ms"
    print(
        f"[{label}] 总耗时 {elapsed_ms:.0f}ms{cancel_to_return}"
        f" | cancel 报错={result.get('cancel_err')} | 语句报错={err}"
    )

    # 会话必须还能用
    try:
        v = conn.cursor().execute("select 1 from dual").fetchone()[0]
        print(f"    中断后会话仍可用：select 1 from dual = {v}")
        assert v == 1
    except Exception as exc:  # noqa: BLE001
        print(f"    !! 中断后会话不可用：{exc}")


def main():
    print(f"python-oracledb {oracledb.__version__}，"
          f"{'thin' if oracledb.is_thin_mode() else 'thick'} 模式，连接 {USER}@{URL}")
    conn = oracledb.connect(user=USER, password=PASS, dsn=URL)
    print(f"服务端版本：{conn.version}\n")

    probe(conn, "begin dbms_lock.sleep(30); end;", 1.0, "P1 sleep(30) 1s 后 cancel")
    print()
    probe(
        conn,
        "select count(*) from (select 1 from dual connect by level <= 30000000)",
        1.0,
        "P2 长查询 1s 后 cancel",
    )
    print()
    probe(conn, "begin dbms_lock.sleep(20); end;", 0.05, "P3 sleep(20) 50ms 后 cancel")
    print()
    probe(conn, "begin dbms_lock.sleep(20); end;", 1.5, "P4 sleep(20) 1.5s 后 cancel")

    print("\n判读：若 python 侧也是秒级 ⇒ 19c 服务端对 interrupt 响应慢，客户端无解；")
    print("      若 python 侧是几十毫秒 ⇒ 我们的实现有改进空间（多半是 OOB 没做）。")


if __name__ == "__main__":
    sys.exit(main())
