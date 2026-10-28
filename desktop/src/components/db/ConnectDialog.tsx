import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/icon";
import { splitJdbcUrl } from "../../lib/db";

/**
 * 连接对话框：只在「首次」或「存着的口令解不开」时出现。
 *
 * 为什么默认路径也要输一次密码：NC 的 `prop.xml` 里那串口令是它自己的加密格式
 * （8 字节 DES 块，密钥在核心技术 jar 里，这台机器的 NC home 找不到对应类）——
 * 连接串和用户名可以零配置读出来，口令不行。输一次后用 Windows DPAPI 加密存本机，
 * 换机器 / 换 Windows 用户都要重输。
 */
export function ConnectDialog({
  open,
  url,
  user,
  source,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  url: string;
  user: string;
  /** 连接串来源（`prop.xml` 的路径），让用户知道连的是哪个库。 */
  source: string;
  busy: boolean;
  error: string | null;
  onSubmit: (password: string) => void;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const pwRef = useRef<HTMLInputElement>(null);
  const { host, database } = splitJdbcUrl(url);

  useEffect(() => {
    if (!open) return;
    setPassword("");
    pwRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const canSubmit = !busy && password.length > 0;

  return createPortal(
    <div className="dq-mask" role="dialog" aria-modal="true" aria-label="数据库连接">
      <form
        className="dq-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(password);
        }}
      >
        <h3>
          <Icon name="database" size={14} /> 连接数据库
        </h3>
        <div className="dq-hint">
          <div className="dq-conn-line">
            <span className="k">实例</span>
            <code>{host}</code>
          </div>
          <div className="dq-conn-line">
            <span className="k">库</span>
            <code>{database || "—"}</code>
          </div>
          <div className="dq-conn-line">
            <span className="k">用户</span>
            <code>{user || "—"}</code>
          </div>
          <div className="dq-conn-line">
            <span className="k">来源</span>
            <code title={source}>{source || "工作台配置"}</code>
          </div>
        </div>
        <p className="dq-hint-text">
          <code>prop.xml</code> 里的口令是 NC 自己的加密格式，工作台解不开——输一次，之后用 Windows
          DPAPI 加密存在本机。<b>换机器或换 Windows 用户要重输。</b>
        </p>
        {error && (
          <div className="dq-alert" data-tone="bad">
            <Icon name="alert" size={13} />
            <span>{error}</span>
          </div>
        )}
        <label className="dq-field">
          口令
          <input
            ref={pwRef}
            className="dq-input"
            type="password"
            value={password}
            autoComplete="current-password"
            spellCheck={false}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <div className="dq-dialog-foot">
          <button type="button" className="dq-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="dq-btn dq-btn-primary" disabled={!canSubmit}>
            {busy ? "连接中…" : "连接"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
