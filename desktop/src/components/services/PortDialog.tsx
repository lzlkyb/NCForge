import { useEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { Modal } from "../ui/Modal";
import { ncPortApply, ncPortPreview, type PortPlan } from "../../lib/server";

/**
 * 改中间件监听端口。
 *
 * 为什么做成「先预览再应用」而不是直接写：改端口要动 NC home 里两份配置
 * （`ierp/bin/prop.xml` 的 `<http><port>`、web 端的 `system.ejb.port`），
 * 用户看不见改了什么就只能盲信。这里把每个文件的原值/新值逐条列出来，
 * 签收后才落笔——写坏了排查成本远高于多点一次。
 *
 * NC 安装目录是本机独立的（各人自己装），所以代劳写它没有问题；
 * 但客户端 `-Dnc.jstart.port` 不在 NC home 里，改不到，只能列出来提醒。
 */
export function PortDialog({
  open,
  currentPort,
  onClose,
  onApplied,
}: {
  open: boolean;
  /** 当前生效的端口（读自配置），打开时用来给建议值。 */
  currentPort: number;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<PortPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // 打开时给一个建议值并清空上次的预览：80 被 IIS 之类占着是最常见的原因，
  // 直接推到 8081，用户不改也能一键确认。
  useEffect(() => {
    if (!open) return;
    setText(String(currentPort === 80 ? 8081 : currentPort + 1));
    setPlan(null);
    setError(null);
    setApplying(false);
  }, [open, currentPort]);

  // 预览请求：输入停下 300ms 再发，避免每敲一位数字都跑一次读盘 + 查端口。
  useEffect(() => {
    if (!open) return;
    const raw = text.trim();
    if (!raw) {
      setPlan(null);
      setError(null);
      return;
    }
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPlan(null);
      setError("端口要填 1~65535 之间的整数");
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      ncPortPreview(port)
        .then((p) => {
          if (stale) return;
          setPlan(p);
          setError(null);
        })
        .catch((e) => {
          if (stale) return;
          setPlan(null);
          setError(String(e));
        });
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, text]);

  const port = Number(text.trim());
  // 只有「读到了现值且与目标不同」才算真要写。`current === null` 表示文件在、
  // 但找不到那条配置项——后端那时 todo 为空、apply 必然失败。前端以前按
  // 「exists 就算有待写入」判，于是「应用」亮着、点了必错。
  const pending = !!plan && plan.edits.some((e) => e.current !== null && e.current !== e.next);
  const canApply = pending && !plan?.blocked && !applying;

  const apply = async () => {
    if (!plan) return;
    setApplying(true);
    try {
      const r = await ncPortApply(plan.newPort);
      if (r.verified) {
        toast(`端口已改为 ${r.verifiedPort}`, "success");
      } else {
        // 写进去了但读回来不是目标端口：文件可能被别的进程锁着写了一半，
        // 或者被 sysConfig 同时改了。必须说出来，不能让用户以为成功。
        toast(`已写入，但复核读到端口 ${r.verifiedPort}，请打开配置文件确认`, "error");
      }
      onApplied();
      onClose();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      className="modal-surface w-[620px] max-w-[92vw] p-5"
      ariaLabel="改监听端口"
    >
      <div className="flex items-center gap-2">
        <Icon name="settings" size={15} />
        <h2 className="text-sm font-semibold">改监听端口</h2>
        <span className="text-xs text-muted-foreground">当前 {currentPort}</span>
        <span className="flex-1" />
        <button type="button" className="sv-icon-btn" onClick={onClose} title="关闭">
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="sv-port-input">
        <label htmlFor="sv-port-field">新端口</label>
        <input
          id="sv-port-field"
          value={text}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value.replace(/[^\d]/g, "").slice(0, 5))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canApply) void apply();
          }}
        />
        <div className="sv-port-quick">
          {[8080, 8081, 9090].map((p) => (
            <button
              key={p}
              type="button"
              data-active={port === p}
              onClick={() => setText(String(p))}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="sv-port-err">{error}</p>}

      {plan && (
        <>
          <div className="sv-port-list">
            {plan.edits.map((e) => (
              <div className="sv-port-item" key={e.path} data-skip={!e.exists}>
                <div className="sv-port-what">
                  <span className="sv-port-label">{e.label}</span>
                  <span className="sv-port-path" title={e.path}>
                    {e.path}
                  </span>
                </div>
                {!e.exists ? (
                  <span className="sv-port-miss">文件不存在，跳过</span>
                ) : e.current === null ? (
                  // 文件在但配置项不在：这条不会被改，不能让「— → 8081」暗示会改
                  <span className="sv-port-miss">读不到现有端口配置，这条不会修改</span>
                ) : (
                  <div className="sv-port-diff">
                    <code className="sv-port-old" title="改前">
                      {e.current}
                    </code>
                    <span className="sv-port-arrow">→</span>
                    <code className="sv-port-new" title="改后">
                      {e.next}
                    </code>
                  </div>
                )}
              </div>
            ))}
          </div>

          {plan.blocked && (
            <p className="sv-port-blocked">
              <Icon name="alert" size={13} />
              {plan.blocked}
            </p>
          )}

          {plan.warnings.length > 0 && (
            <ul className="sv-port-warn">
              {plan.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <div className="sv-port-manual">
            <span>这两处本工具改不到，需要你自己同步：</span>
            <ul>
              {plan.manual.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        </>
      )}

      <div className="sv-port-foot">
        <span className="sv-port-hint">
          改动会留下 <code>.ncforge-bak</code> 备份；服务运行中不能改（要先停止）。
        </span>
        <span className="flex-1" />
        <button type="button" className="sv-btn" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="sv-btn sv-btn-primary"
          disabled={!canApply}
          onClick={() => void apply()}
        >
          {applying ? "写入中…" : "应用"}
        </button>
      </div>
    </Modal>
  );
}
