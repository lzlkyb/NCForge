import { useEffect, useState } from "react";
import "../../db-console.css";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { settle, usePending, type Pending } from "../../lib/dbConfirm";
import { connOf } from "../../lib/dbStore";
import { dbNameOf, ENV_LABEL } from "../../lib/dbApi";
import { FilesBody } from "./QuitFilesBody";

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
      ariaLabel="数据库确认"
      zIndex={1100}
      // 退出确认不靠点遮罩关：用户想点「保存」却点到旁边，框没了、应用还在，
      // 他多半会以为「取消成功了」而不知道刚才那一下什么都没决定。ESC 仍然可以取消。
      closeOnOverlay={p?.kind !== "unsavedFiles"}
    >
      {p?.kind === "tx" && <TxBody p={p} />}
      {p?.kind === "quit" && <QuitBody p={p} />}
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
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" onClick={() => settle((x) => x.kind === "tx" && x.resolve("cancel"))}>
          取消
        </button>
        <button type="button" className="dbx-btn" onClick={() => settle((x) => x.kind === "tx" && x.resolve("rollback"))}>
          回滚
        </button>
        <button type="button" className="dbx-btn pri" onClick={() => settle((x) => x.kind === "tx" && x.resolve("commit"))}>
          提交
        </button>
      </div>
    </>
  );
}

/**
 * 退出前的未提交事务确认。
 *
 * 连接名/环境来自 `quitGuard` 合并好的行（不查 store）：连接可能刚从配置里删掉，
 * 那时 `connOf` 查不到，列表会凭空少一行——恰恰是最该提醒的那种。
 */
function QuitBody({ p }: { p: Extract<Pending, { kind: "quit" }> }) {
  return (
    <>
      <div className="hd">
        <Icon name="alertTriangle" size={16} />
        退出前还有未提交的事务
      </div>
      <div className="bd one">
        <p style={{ marginBottom: 6 }}>现在退出，下面这些改动会被数据库回滚，跟没执行过一样。</p>
        <ul style={{ margin: "0 0 8px", paddingLeft: 18, display: "grid", gap: 6 }}>
          {p.rows.map((r) => {
            const mins = r.since ? Math.max(1, Math.round((Date.now() - r.since) / 60_000)) : 0;
            return (
              <li key={r.connId}>
                <span className={`e-${r.env}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span className="dbx-edot" />
                  <b>{r.name}</b>
                  <span className="dbx-echip">{ENV_LABEL[r.env]}</span>
                </span>
                <div className="dbx-muted" style={{ marginTop: 2 }}>
                  {r.kind === "unknown" ? (
                    <>状态未知（{r.message ?? "探测超时"}），退出后由数据库回滚</>
                  ) : (
                    <>
                      {r.statements} 条写语句 / 影响 {r.rows} 行
                      {mins > 0 && <> · 已持续约 {mins} 分钟</>}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="dbx-muted">「全部提交」只对状态已知的连接生效；状态未知的那些退出后仍会回滚。</p>
      </div>
      <div className="ft">
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" onClick={() => settle((x) => x.kind === "quit" && x.resolve("cancel"))}>
          取消
        </button>
        <button type="button" className="dbx-btn" onClick={() => settle((x) => x.kind === "quit" && x.resolve("rollback"))}>
          全部回滚
        </button>
        <button type="button" className="dbx-btn pri" onClick={() => settle((x) => x.kind === "quit" && x.resolve("commit"))}>
          全部提交
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
        <button type="button" className="dbx-btn" onClick={() => settle((x) => x.kind === "prod" && x.resolve(false, false))}>
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
        <label className="dbx-chk" style={{ justifySelf: "start" }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          记住口令（Windows 加密存本机）
        </label>
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
