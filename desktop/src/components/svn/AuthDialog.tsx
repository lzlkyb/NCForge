import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { Modal } from "../ui/Modal";

/**
 * 账号对话框：只在「Eclipse 缓存里也拿不到」时才出现。
 *
 * 正常路径是零配置的——从 %APPDATA%\Subversion\auth 读 realm+用户，
 * 密码用 DPAPI 解密直接喂桥。走到这里说明缓存没有或密码错了。
 * 输入的密码经 DPAPI 加密后存本机配置，不写明文、不进日志。
 *
 * 外壳用统一 <Modal> 原语（P2-1）：Esc / 点遮罩 / 焦点陷阱与其它弹窗一致
 * （以前自建 vc-mask，有 Esc 但没有焦点陷阱，Tab 可逃逸；Esc 监听也删了，
 * Modal 的 useFocusTrap 在节点级处理 Esc 并停止冒泡，嵌套弹窗优先关自己）。
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

  const canSubmit = !busy && user.trim().length > 0 && password.length > 0;

  return (
    <Modal open={open} onClose={onClose} ariaLabel="SVN 账号" className="vc-dialog">
      <form
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
    </Modal>
  );
}
