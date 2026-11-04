import { useCallback, useEffect, useRef, useState } from "react";
import { beginOperation, trackOperation } from "./operations";
import { dbTaskSpec } from "./dbOperations";
import { invoke } from "./tauri";
import { friendlyDbError } from "./db";

/**
 * 重置操作员密码：列 `sm_user`（只读）+ 生成 `update` SQL（不执行）。
 *
 * 哈希由后端算（见 `nc_password.rs`，带公开向量单测），前端只负责选人、选方案、
 * 把生成的文本给用户复制 / 保存。明文密码不进日志、不进 SQL。
 */

export type PwdScheme = "nc65" | "ncc";

export interface NcUserRow {
  cuserid: string;
  userCode: string;
  userName: string;
  /** NC 的启停用编码：1 未启用 / 2 已启用 / 3 已停用。 */
  enableState: string;
  /** 从现有密文前缀认出来的方案；认不出为 null。 */
  scheme: PwdScheme | null;
}

export interface UserListOut {
  users: NcUserRow[];
  truncated: boolean;
  sharedSession: boolean;
}

export interface ResetSqlOut {
  sql: string;
  count: number;
}

export const SCHEMES: { v: PwdScheme; label: string; hint: string }[] = [
  { v: "nc65", label: "NC65 / NC6.x", hint: "U_U++--V + MD5(cuserid + 密码)" },
  { v: "ncc", label: "NCC / NC Cloud", hint: "S_S++ + Base64(SHA-256(cuserid + 密码))" },
];

export const ENABLE_STATE_LABEL: Record<string, string> = {
  "1": "未启用",
  "2": "已启用",
  "3": "已停用",
};

export function enableStateText(code: string): string {
  return ENABLE_STATE_LABEL[code.trim()] ?? (code.trim() || "—");
}

export function listUsers(connId: string, filter: string): Promise<UserListOut> {
  return invoke("db_user_list", { id: connId, filter: filter.trim() || null });
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function resetSql(
  scheme: PwdScheme,
  password: string,
  users: NcUserRow[],
): Promise<ResetSqlOut> {
  return invoke("db_password_reset_sql", {
    req: {
      scheme,
      password,
      users: users.map((u) => ({ cuserid: u.cuserid, userCode: u.userCode })),
      generatedAt: stamp(),
    },
  });
}

/** 从现有密文推断默认方案：两种都有时按多的走；一个都认不出返回 null。 */
export function detectScheme(users: NcUserRow[]): PwdScheme | null {
  let nc65 = 0;
  let ncc = 0;
  for (const u of users) {
    if (u.scheme === "nc65") nc65++;
    else if (u.scheme === "ncc") ncc++;
  }
  if (nc65 === 0 && ncc === 0) return null;
  return ncc > nc65 ? "ncc" : "nc65";
}

export function useNcUsers(connId: string) {
  const [users, setUsers] = useState<NcUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [sharedSession, setSharedSession] = useState(false);
  /** 筛选连续改：只认最后一次请求的结果。 */
  const seq = useRef(0);

  const load = useCallback(
    async (filter: string) => {
      const n = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const out = await trackOperation(dbTaskSpec(`users:${connId}:${n}`,"读取 NC 操作员",connId,"NC 操作员"),()=>listUsers(connId, filter),out=>({state:"success",detail:`已读取 ${out.users.length} 个账号${out.truncated ? "，已到读取上限" : ""}`}));
        if (n !== seq.current) return;
        setUsers(out.users);
        setTruncated(out.truncated);
        setSharedSession(out.sharedSession);
      } catch (e) {
        if (n !== seq.current) return;
        setUsers([]);
        setTruncated(false);
        setError(friendlyDbError(e));
      } finally {
        if (n === seq.current) setLoading(false);
      }
    },
    [connId],
  );

  useEffect(() => {
    void load("");
  }, [load]);

  return { users, loading, error, truncated, sharedSession, load };
}

export function usePasswordReset() {
  const [selected, setSelected] = useState<Record<string, true>>({});
  const [password, setPassword] = useState("");
  const [scheme, setScheme] = useState<PwdScheme | null>(null);
  const [result, setResult] = useState<ResetSqlOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revision=useRef(0),lock=useRef(false);
  const toggle = (cuserid: string) => {
    revision.current++;
    setSelected((s) => {
      const next = { ...s };
      if (next[cuserid]) delete next[cuserid];
      else next[cuserid] = true;
      return next;
    });
    // 选人变了，之前生成的脚本就过期了：留着会让人复制到错误的一份
    setResult(null);
  };

  const clear = () => {
    revision.current++;
    setSelected({});
    setResult(null);
  };

  // 密码或方案改了，脚本里的哈希就不再对应当前输入：留着会被复制走一份错的
  const changePassword = (v: string) => {
    revision.current++;
    setPassword(v);
    setResult(null);
  };
  const changeScheme = (v: PwdScheme) => {
    revision.current++;
    setScheme(v);
    setResult(null);
  };

  const generate = async (users: NcUserRow[], effective: PwdScheme) => {
    if(lock.current) return;
    const picked = users.filter((u) => selected[u.cuserid]);
    const task=beginOperation(dbTaskSpec("users.reset.sql","生成 NC 密码重置脚本",null,"仅生成脚本"));
    if(!task) return;lock.current=true;const version=revision.current;setBusy(true);
    setError(null);
    try {
      const out=await resetSql(effective, password, picked);
      if(version!==revision.current) {task.finish("cancelled","表单已修改，生成结果未展示");return;}
      task.finish("success",`已生成 ${out.count} 条语句，未执行数据库写入`);setResult(out);
    } catch (e) {
      task.finish("failed","生成脚本失败，返回操作员面板查看原因");
      if(version!==revision.current) return;
      setResult(null);
      setError(String(e));
    } finally {
      lock.current=false;setBusy(false);
    }
  };

  return {
    selected,
    toggle,
    clear,
    password,
    setPassword: changePassword,
    scheme,
    setScheme: changeScheme,
    result,
    busy,
    error,
    generate,
  };
}
