import { useEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { copyText } from "../../lib/utils";
import type { SessionRow } from "../../lib/dbApi";
import { useSessionList } from "../../hooks/useSessionList";
import { SessionTable } from "./SessionTable";
import { SessionDetail } from "./SessionDetail";

/** 读不到 `v$locked_object` 时给用户看的授权语句（**不代执行**，权限是 DBA 的事）。 */
const GRANT_HINT = "grant select on v$locked_object to <你的账号>;";

/**
 * 会话与锁（只读）。对标 PL/SQL Developer 的 Session/Lock 窗口。
 *
 * 定位只有一句：**30 秒内搞清楚"谁锁了这张表、在跑什么、该找谁"**。
 * 所以这里只读、只生成语句，不提供「一键杀」——`ALTER SYSTEM KILL SESSION` 二开账号
 * 通常没权限，生产库误杀还会打断别人的补丁执行。
 *
 * `granted: false` 时必须显式提示缺授权：把"看不见锁"显示成"没有锁"是这类面板最坏的 bug。
 * 取数与轮询在 `useSessionList`，表格与详情弹框各自成组件。
 */
export function SessionDrawer({ connId, onClose, visible = true }: { connId: string; onClose: () => void; visible?: boolean }) {
  const { rows, granted, err, at, loading, auto, setAuto, load } = useSessionList(connId, visible);
  const [query,setQuery]=useState("");
  const [onlyBlocked,setOnlyBlocked]=useState(false);
  const [selected,setSelected]=useState<SessionRow|null>(null);
  useEffect(()=>{setSelected(null);setQuery("");setOnlyBlocked(false);},[connId]);

  const copy = (text: string, what: string) => {
    if (!text) return;
    void copyText(text, () => toast(`已复制${what}`, "success"), (e) => toast(`复制失败：${e}`, "error"));
  };

  const blocked = (rows ?? []).filter((r) => r.blocker != null).length;
  const shown=(rows ?? []).filter(row=>(!onlyBlocked || row.blocker != null || rows?.some(item=>item.blocker === row.sid)) && [row.sid,row.user,row.machine,row.program,row.event,row.sql].some(value=>String(value ?? "").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));

  return (
    <div className="dbx-drawer sess">
      <div className="hd">
        <Icon name="lock" size={14} />
        会话与锁
        <span className="dbx-cnt">{rows?.length ?? 0}</span>
        {blocked > 0 && <span className="dbx-sess-bad">阻塞 {blocked}</span>}
        <span className="dbx-sp" />
        <button type="button" className="dbx-ibtn" title="刷新" aria-label="刷新会话" disabled={loading} onClick={() => void load()}>
          <Icon name="refresh" size={13} />
        </button>
        <button
          type="button"
          className="dbx-ibtn"
          data-on={auto || undefined}
          title={auto ? "每 10 秒自动刷新（点击关闭）" : "已关闭自动刷新（点击开启）"}
          aria-label="自动刷新"
          onClick={() => setAuto(!auto)}
        >
          <Icon name="activity" size={13} />
        </button>
        <button type="button" className="dbx-ibtn" aria-label="关闭会话面板" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>

      {!granted && (
        <div className="dbx-sess-warn">
          <Icon name="alert" size={13} />
          <span>
            这个账号读不到 <code>v$locked_object</code>，<b>锁信息不可见</b>（不等于没有锁）。
            需要 DBA 执行：<code>{GRANT_HINT}</code>
          </span>
          <button type="button" className="dbx-lk" onClick={() => copy(GRANT_HINT, "授权语句")}>
            复制
          </button>
        </div>
      )}

      {err && <div className="dbx-err" style={{ margin: 8 }}>{err}</div>}

      <div className="dbx-reading-tools"><input aria-label="搜索会话" placeholder="SID / 用户 / 机器 / SQL" value={query} onChange={e=>setQuery(e.target.value)}/><label><input type="checkbox" checked={onlyBlocked} onChange={e=>setOnlyBlocked(e.target.checked)}/>阻塞关系</label></div>
      <div className="list">
        {!rows && !err && <p className="dbx-tree-note">读取中…</p>}
        {rows && rows.length === 0 && <p className="dbx-tree-note">当前没有正在执行或被阻塞的会话</p>}
        {rows && rows.length > 0 && shown.length === 0 && <p>没有匹配的会话，请调整筛选。</p>}
        {shown.length > 0 && <SessionTable rows={shown} onSelect={setSelected} onCopy={copy} />}
      </div>

      {selected && (
        <SessionDetail
          selected={selected}
          rows={rows}
          connId={connId}
          onSelect={setSelected}
          onClose={()=>setSelected(null)}
        />
      )}
      <div className="dbx-sess-foot">
        {at > 0 && <span>更新于 {new Date(at).toLocaleTimeString()}</span>}
        <span className="dbx-sp" />
        <span>只读 · 不代执行 KILL</span>
      </div>
    </div>
  );
}
