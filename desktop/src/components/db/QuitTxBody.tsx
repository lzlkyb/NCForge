import { Icon } from "../ui/icon";
import { settle, type Pending, type QuitRow } from "../../lib/dbConfirm";
import { ENV_LABEL } from "../../lib/dbApi";

/**
 * 退出前的未提交事务 / 断连确认（`DbConfirmHost` 的弹框体，单独成文件是为了守住
 * 300 行体量门禁）。
 *
 * **只有 `pending` 才提供提交/回滚**：`unknown` 的会话已经断开或探不到，根本没法
 * 提交或回滚，再给「全部提交」只会让用户以为改动保住了。全是 unknown 时退化成一次
 * 纯确认，不再弹第二个框。
 */
const UNKNOWN_TEXT: Record<string, string> = {
  disconnected: "会话已经结束，若有未提交改动，数据库已经回滚。",
  unreachable: "连接探测失败，无法确认会话是否还在；退出后若有未提交改动会被数据库回滚。",
  timeout: "探测超时，无法确认事务状态；退出后若有未提交改动会被数据库回滚。",
  "probe-error": "读取会话状态失败；退出后若有未提交改动会被数据库回滚。",
};

function UnknownRow({ r }: { r: QuitRow }) {
  const what = UNKNOWN_TEXT[r.reason ?? "timeout"] ?? UNKNOWN_TEXT.timeout;
  return (
    <>
      {r.statements > 0 && <>断开前记录到 {r.statements} 条写语句 / 影响 {r.rows} 行。</>}
      {what}
    </>
  );
}

export function QuitTxBody({ p }: { p: Extract<Pending, { kind: "quit" }> }) {
  const pending = p.rows.filter((r) => r.kind === "pending");
  const unknown = p.rows.filter((r) => r.kind === "unknown");
  const onlyUnknown = pending.length === 0;
  return (
    <>
      <div className="hd">
        <Icon name="alertTriangle" size={16} />
        {onlyUnknown ? "有连接无法确认事务状态" : "退出前还有未提交的事务"}
      </div>
      <div className="bd one">
        <p style={{ marginBottom: 6 }}>
          {onlyUnknown
            ? "下面这些连接已经断开或暂时探测不到，无法在这里提交或回滚。"
            : "现在退出，下面这些已知事务的改动会被数据库回滚，跟没执行过一样。"}
        </p>
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
                    <UnknownRow r={r} />
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
        {unknown.length > 0 && !onlyUnknown && (
          <p className="dbx-muted">
            另有 {unknown.length} 个连接无法确认：它们不能在这里提交或回滚，退出后若有未提交改动会被数据库回滚。
          </p>
        )}
        {onlyUnknown && (
          <p className="dbx-muted">重新连接会建立一条新会话，原来的未提交改动不会恢复；需要重做的话可以取消退出后重连。</p>
        )}
      </div>
      <div className="ft">
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn" onClick={() => settle((x) => x.kind === "quit" && x.resolve("cancel"))}>
          取消
        </button>
        {onlyUnknown ? (
          <button type="button" className="dbx-btn bad" onClick={() => settle((x) => x.kind === "quit" && x.resolve("exit"))}>
            仍要退出
          </button>
        ) : (
          <>
            <button type="button" className="dbx-btn" onClick={() => settle((x) => x.kind === "quit" && x.resolve("rollback"))}>
              {unknown.length > 0 ? "回滚已知事务" : "全部回滚"}
            </button>
            <button type="button" className="dbx-btn pri" onClick={() => settle((x) => x.kind === "quit" && x.resolve("commit"))}>
              {unknown.length > 0 ? "提交已知事务" : "全部提交"}
            </button>
          </>
        )}
      </div>
    </>
  );
}
