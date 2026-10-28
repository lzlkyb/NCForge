import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/icon";

/**
 * 账号对话框：只在「Eclipse 缓存里也拿不到」时才出现。
 *
 * 正常路径是零配置的——从 %APPDATA%\Subversion\auth 读 realm+用户，
 * 密码用 DPAPI 解密直接喂桥。走到这里说明缓存没有或密码错了。
 * 输入的密码经 DPAPI 加密后存本机配置，不写明文、不进日志。
 */
export function AuthDialog({
  open,
  host,
  defaultUser,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  host: string;
  defaultUser: string;
  busy: boolean;
  error: string | null;
  onSubmit: (user: string, password: string) => void;
  onClose: () => void;
}) {
  const [user, setUser] = useState(defaultUser);
  const [password, setPassword] = useState("");
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setUser(defaultUser);
    setPassword("");
    userRef.current?.focus();
  }, [open, defaultUser]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const canSubmit = !busy && user.trim().length > 0 && password.length > 0;

  return createPortal(
    <div className="vc-mask" role="dialog" aria-modal="true" aria-label="SVN 账号">
      <form
        className="vc-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(user.trim(), password);
        }}
      >
        <h3>
          <Icon name="key" size={14} /> SVN 账号
        </h3>
        <div className="vc-hint">
          这台机器的 SVN 缓存里没有 <b>{host || "服务器"}</b> 的口令，输一次就记住（Windows DPAPI 加密）。
        </div>
        {error && (
          <div className="vc-alert" data-tone="bad">
            <Icon name="alert" size={13} />
            <span>{error}</span>
          </div>
        )}
        <label className="vc-field">
          用户名
          <input
            ref={userRef}
            className="vc-input"
            value={user}
            autoComplete="username"
            spellCheck={false}
            onChange={(e) => setUser(e.target.value)}
          />
        </label>
        <label className="vc-field">
          密码
          <input
            className="vc-input"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <div className="vc-dialog-foot">
          <button type="button" className="vc-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="vc-btn vc-btn-primary" disabled={!canSubmit}>
            {busy ? "验证中…" : "保存并重新扫描"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
