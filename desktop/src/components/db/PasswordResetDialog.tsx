import { useState } from "react";
import "../../db-console.css";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { copyText } from "../../lib/utils";
import { downloadText } from "../../lib/resultExport";
import { connOf } from "../../lib/dbStore";
import { ENV_LABEL } from "../../lib/dbApi";
import {
  SCHEMES,
  detectScheme,
  enableStateText,
  useNcUsers,
  usePasswordReset,
  type NcUserRow,
  type PwdScheme,
} from "../../lib/dbUsers";

const schemeLabel = (s: PwdScheme | null) =>
  s ? (SCHEMES.find((x) => x.v === s)?.label ?? s) : "—";

/**
 * 重置操作员密码：列 `sm_user` → 选人 → 输入新密码 → **只生成** `update` 脚本。
 *
 * 为什么不做「一键改密」：这是让整个账套登录不进去的操作，执行的时机、目标库、
 * 提交与否都该由人确认。工具能做的是把算法算对（两套 NC 方案按密文前缀自动认），
 * 把脚本拼好，剩下的交给人。
 */
export function PasswordResetDialog({ connId, onClose }: { connId: string; onClose: () => void }) {
  const conn = connOf(connId);
  const { users, loading, error, truncated, sharedSession, load } = useNcUsers(connId);
  const reset = usePasswordReset();
  const [filter, setFilter] = useState("");
  const [showPwd, setShowPwd] = useState(false);

  /** 没手选方案时看现有密文：一个都认不出就默认 NC65（NC6.x 最常见）。 */
  const effective: PwdScheme = reset.scheme ?? detectScheme(users) ?? "nc65";
  const picked: NcUserRow[] = users.filter((u) => reset.selected[u.cuserid]);
  const canGen = picked.length > 0 && reset.password.length > 0 && !reset.busy;

  const search = (f: string) => {
    setFilter(f);
    void load(f);
  };

  const copySql = () => {
    if (!reset.result) return;
    void copyText(
      reset.result.sql,
      () => toast("已复制 SQL", "success"),
      (e) => toast(`复制失败：${String(e)}`, "error"),
    );
  };

  const saveSql = () => {
    if (!reset.result) return;
    downloadText(`${conn?.name ?? "sm_user"}-密码重置.sql`, reset.result.sql, "text/plain", false);
    toast(`已保存 ${reset.result.count} 条 update 的脚本`, "success");
  };

  return (
    <Modal open onClose={onClose} className="modal-surface dbx-dlg wide dbx-pr" ariaLabel="重置操作员密码">
      <div className="hd">
        <Icon name="key" size={16} />
        重置操作员密码
        <span className="dbx-muted" style={{ fontWeight: 400, fontSize: 12 }}>
          {conn?.name ?? "连接"} · {conn?.user ?? ""} · {conn ? ENV_LABEL[conn.env] : ""}
        </span>
      </div>

      <div className="bd one">
        <div className="dbx-pr-alert" data-tone={conn?.env === "prod" ? "warn" : "info"}>
          <Icon name={conn?.env === "prod" ? "alert" : "shield"} size={14} />
          <span>
            <b>只生成 SQL，不会执行</b>：本工具只读 <code className="dbx-mono">sm_user</code>
            ，脚本拿走后请确认目标库再手动运行。
            {conn?.env === "prod" && " 当前是生产库，改密前先想清楚影响范围。"}
          </span>
        </div>

        <div className="dbx-pr-row">
          <input
            className="dbx-inp"
            aria-label="筛选账号"
            value={filter}
            placeholder="按账号 / 姓名筛选（留空 = 全部）"
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) search(filter);
            }}
          />
          <button type="button" className="dbx-btn" disabled={loading} onClick={() => search(filter)}>
            <Icon name="search" size={12} />
            查询
          </button>
          {loading && <Icon name="spinner" size={12} />}
          <span className="dbx-sp" />
          <span className="dbx-muted">已选 {picked.length} 人</span>
          {picked.length > 0 && (
            <button type="button" className="dbx-btn ghost" onClick={reset.clear}>
              清空选择
            </button>
          )}
        </div>

        {error && (
          <div className="dbx-pr-alert" data-tone="bad">
            <Icon name="alertTriangle" size={14} />
            <span>{error}</span>
          </div>
        )}
        {sharedSession && (
          <p className="dbx-pr-note dbx-muted">
            没能开独立会话（口令未记住），本次复用了控制台会话：控制台的「加载更多」可能失效。
          </p>
        )}
        {truncated && (
          <p className="dbx-pr-note dbx-muted">
            账号太多，只列了前 501 个——用筛选缩小范围。
          </p>
        )}

        <div className="dbx-pr-users">
          {!loading && users.length === 0 && !error ? (
            <p className="dbx-pr-note dbx-muted">没有匹配的账号。</p>
          ) : (
            <table className="dbx-pr-table">
              <thead>
                <tr>
                  <th aria-label="选择" />
                  <th>账号</th>
                  <th>姓名</th>
                  <th>状态</th>
                  <th>现有方案</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.cuserid} data-on={reset.selected[u.cuserid] ? "" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        checked={!!reset.selected[u.cuserid]}
                        aria-label={`选择 ${u.userCode || u.cuserid}`}
                        onChange={() => reset.toggle(u.cuserid)}
                      />
                    </td>
                    <td className="dbx-mono">{u.userCode || u.cuserid}</td>
                    <td>{u.userName || "—"}</td>
                    <td>{enableStateText(u.enableState)}</td>
                    <td className="dbx-muted">{schemeLabel(u.scheme)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="dbx-pr-row">
          <label className="dbx-pr-label" htmlFor="pr-pwd">
            新密码
          </label>
          <input
            id="pr-pwd"
            className="dbx-inp mono"
            type={showPwd ? "text" : "password"}
            value={reset.password}
            autoComplete="new-password"
            spellCheck={false}
            placeholder="给选中的账号统一设这个密码"
            onChange={(e) => reset.setPassword(e.target.value)}
          />
          <button
            type="button"
            className="dbx-ibtn"
            title={showPwd ? "隐藏密码" : "显示密码"}
            aria-label={showPwd ? "隐藏密码" : "显示密码"}
            onClick={() => setShowPwd((v) => !v)}
          >
            <Icon name={showPwd ? "eyeOff" : "eye"} size={12} />
          </button>
          <select
            className="dbx-inp"
            aria-label="密码方案"
            value={effective}
            onChange={(e) => reset.setScheme(e.target.value as PwdScheme)}
          >
            {SCHEMES.map((s) => (
              <option key={s.v} value={s.v}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <p className="dbx-pr-note dbx-muted">
          {SCHEMES.find((s) => s.v === effective)?.hint}。默认值按现有密文推断，两种都有时按多的走。
          含中文的密码在服务端可能按 GBK 校验而登录失败——临时密码建议用纯 ASCII。
          账号被锁定时重置密码不会解锁，<code className="dbx-mono">sm_user_ex</code> 的锁定记录要另行处理。
        </p>

        {reset.error && (
          <div className="dbx-pr-alert" data-tone="bad">
            <Icon name="alertTriangle" size={14} />
            <span>{reset.error}</span>
          </div>
        )}

        {reset.result && (
          <div className="dbx-pr-result">
            <div className="dbx-pr-sum">
              <b>{reset.result.count}</b> 条 update（{schemeLabel(effective)}）
              <span className="dbx-sp" />
              <button type="button" className="dbx-btn ghost" onClick={copySql}>
                <Icon name="copy" size={12} />
                复制 SQL
              </button>
              <button type="button" className="dbx-btn ghost" onClick={saveSql}>
                <Icon name="download" size={12} />
                保存 .sql
              </button>
            </div>
            <pre className="dbx-mono dbx-pr-sql">{reset.result.sql}</pre>
            <p className="dbx-pr-note dbx-muted">
              脚本里只有密文，没有明文密码，可以安全地转给别人执行。
            </p>
          </div>
        )}
      </div>

      <div className="ft">
        <span className="dbx-muted">只读账号列表 · 生成的脚本不会自动执行</span>
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" onClick={onClose}>
          关闭
        </button>
        <button
          type="button"
          className="dbx-btn pri"
          disabled={!canGen}
          title={picked.length === 0 ? "先勾选要重置的账号" : reset.password ? "" : "先输入新密码"}
          onClick={() => void reset.generate(users, effective)}
        >
          <Icon name="key" size={12} />
          {reset.busy ? "生成中…" : "生成 SQL"}
        </button>
      </div>
    </Modal>
  );
}
