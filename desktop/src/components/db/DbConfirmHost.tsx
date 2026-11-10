import { useEffect, useState } from "react";
import "../../db-console.css";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { settle, settleTx, usePending, type Pending } from "../../lib/dbConfirm";
import { connOf } from "../../lib/dbStore";
import { dbNameOf, ENV_LABEL } from "../../lib/dbApi";
import { FilesBody } from "./QuitFilesBody";
import { QuitTxBody } from "./QuitTxBody";

/**
 * 确认弹框宿主：退出前未保存文件 / 未提交事务 / 生产库写语句 / 补输口令
 * （见 lib/dbConfirm）。
 *
 * **挂在 `App` 上而不是数据库页里**：退出确认要在任何页面都能弹——用户在文件页
 * 点 X 也得看见它。顺带让「悬停卡片里打开表」缺口令时的弹框也变成全局的。
 *
 * **样式自己引**：`db-console.css` 原来只在 `DbTab` 里 import，而本组件现在挂在
 * App 上、比数据库页先加载。不自己引的话，文件页弹退出框会是一堆裸元素。
 */
export function DbConfirmHost() {
  const p = usePending();
  const close = () =>
    settle((x) => {
      if (x.kind === "tx") x.resolve("cancel");
      else if (x.kind === "quit") x.resolve("cancel");
      else if (x.kind === "unsavedFiles") x.resolve("cancel");
      else if (x.kind === "prod") x.resolve(false, false);
      else if (x.kind === "ask") x.resolve(false);
      else x.resolve(null);
    });
  return (
    <Modal
      open={p !== null}
      onClose={close}
      className="modal-surface dbx-dlg sm"
      ariaLabel={p?.kind === "unsavedFiles" ? "未保存文件确认" : "数据库确认"}
      zIndex={1100}
      // 危险确认一律不靠点遮罩关：用户想点「提交 / 执行」却点到旁边，框没了、
      // 应用还在，他多半以为「取消成功了」而不知道刚才那一下什么都没决定。
      // 只有非破坏性的普通询问与口令框允许点遮罩取消；ESC 始终可以取消。
      closeOnOverlay={p?.kind === "ask" ? !p.danger : p?.kind === "password"}
    >
      {p?.kind === "tx" && <TxBody p={p} />}
      {p?.kind === "quit" && <QuitTxBody p={p} />}
      {p?.kind === "unsavedFiles" && <FilesBody p={p} />}
      {p?.kind === "prod" && <ProdBody p={p} />}
      {p?.kind === "password" && <PasswordBody p={p} onCancel={close} />}
      {p?.kind === "ask" && (
        <>
          <div className="hd">{p.title}</div>
          <div className="bd one">{p.message}</div>
          <div className="ft">
            <span className="dbx-sp" />
            <button type="button" className="dbx-btn" onClick={close}>
              取消
            </button>
            <button type="button" className={`dbx-btn ${p.danger ? "bad" : "pri"}`} onClick={() => settle((x) => x.kind === "ask" && x.resolve(true))}>
              {p.ok}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ConnLine({ connId }: { connId: string }) {
  const c = connOf(connId);
  if (!c) return null;
  return (
    <span className={`e-${c.env}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className="dbx-edot" />
      <b>{c.name}</b>
      <span className="dbx-echip">{ENV_LABEL[c.env]}</span>
      <span className="dbx-muted dbx-mono">{c.user}@{dbNameOf(c.url)}</span>
    </span>
  );
}

function TxBody({ p }: { p: Extract<Pending, { kind: "tx" }> }) {
  const mins = p.tx.since ? Math.max(1, Math.round((Date.now() - p.tx.since) / 60_000)) : 0;
  return (
    <>
      <div className="hd">
        <Icon name="alertTriangle" size={16} />
        还有未提交的事务
      </div>
      <div className="bd one">
        <p style={{ marginBottom: 8 }}>
          <ConnLine connId={p.connId} />
        </p>
        <p>
          {p.reason}前要先处理：<b>{p.tx.statements}</b> 条写语句，影响 <b>{p.tx.rows}</b> 行
          {mins > 0 && <>，已持续约 {mins} 分钟</>}。
        </p>
        <p className="dbx-muted" style={{ marginTop: 6 }}>不处理的话行锁会一直挂着，别人改同一批数据会卡住。</p>
      </div>
      <div className="ft">
        {p.busy && (
          <span className="dbx-muted" role="status">
            {p.busy === "commit" ? "正在提交…" : "正在回滚…"}
          </span>
        )}
        <span className="dbx-sp" />
        <button
          type="button"
          className="dbx-btn"
          disabled={!!p.busy}
          onClick={() => settle((x) => x.kind === "tx" && x.resolve("cancel"))}
        >
          取消
        </button>
        <button type="button" className="dbx-btn" disabled={!!p.busy} onClick={() => void settleTx("rollback")}>
          {p.busy === "rollback" ? "回滚中…" : "回滚"}
        </button>
        <button type="button" className="dbx-btn pri" disabled={!!p.busy} onClick={() => void settleTx("commit")}>
          {p.busy === "commit" ? "提交中…" : "提交"}
        </button>
      </div>
    </>
  );
}

function ProdBody({ p }: { p: Extract<Pending, { kind: "prod" }> }) {
  const [quiet, setQuiet] = useState(false);
  return (
    <>
      <div className="hd" style={{ color: "hsl(var(--destructive-ink))" }}>
        <Icon name="alertTriangle" size={16} />
        在生产库上执行写语句
      </div>
      <div className="bd one">
        <p style={{ marginBottom: 8 }}>
          <ConnLine connId={p.connId} />
        </p>
        <pre className="sql">{p.sql}</pre>
        <label className="dbx-chk" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
          本标签 10 分钟内不再询问
        </label>
      </div>
      <div className="ft">
        <span className="dbx-muted">能不能写由数据库账号权限决定</span>
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" data-autofocus onClick={() => settle((x) => x.kind === "prod" && x.resolve(false, false))}>
          取消
        </button>
        <button type="button" className="dbx-btn bad" onClick={() => settle((x) => x.kind === "prod" && x.resolve(true, quiet))}>
          执行
        </button>
      </div>
    </>
  );
}

function PasswordBody({ p, onCancel }: { p: Extract<Pending, { kind: "password" }>; onCancel: () => void }) {
  const [pw, setPw] = useState("");
  const [remember, setRemember] = useState(true);
  const [show, setShow] = useState(false);
  // 同一个框重弹（口令错了重输）时清空上一次的输入
  useEffect(() => setPw(""), [p]);
  const c = connOf(p.connId);
  const submit = () => {
    if (pw) settle((x) => x.kind === "password" && x.resolve({ password: pw, remember }));
  };
  return (
    <>
      <div className="hd">
        <Icon name="key" size={16} />
        输入口令
      </div>
      <div className="bd">
        <label>连接</label>
        <ConnLine connId={p.connId} />
        <label>用户</label>
        <span className="dbx-mono">{c?.user}</span>
        <label>口令</label>
        <span style={{ display: "flex", gap: 6 }}>
          <input
            className="dbx-inp"
            type={show ? "text" : "password"}
            value={pw}
            autoFocus
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button type="button" className="dbx-ibtn" title={show ? "隐藏" : "显示"} onClick={() => setShow(!show)}>
            <Icon name={show ? "eyeOff" : "eye"} size={14} />
          </button>
        </span>
        <span />
        {!p.temporary && <label className="dbx-chk" style={{ justifySelf: "start" }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          记住口令（Windows 加密存本机）
        </label>}
        {p.error && (
          <div className="dbx-badline">
            <Icon name="alert" size={13} />
            <span>{p.error}</span>
          </div>
        )}
      </div>
      <div className="ft">
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="dbx-btn pri" disabled={!pw} onClick={submit}>
          连接
        </button>
      </div>
    </>
  );
}
