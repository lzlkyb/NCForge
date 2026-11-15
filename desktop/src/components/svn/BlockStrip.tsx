/**
 * 改动块标注条（按需求审查 P2，设计稿第二节六种状态）：未审 / 已审 / 需重审 / 别的需求 / 人手改 / 来源不明。
 *
 * 挂在对比新侧的 view zone 里（见 `useDiffStrips`），高 28px；「只看这次改了什么」展开时在条内多一段小对比。
 * 没装 cc-bridge / 没开变更日志时不展示来源，只留审查勾选（与需重审提示，它不依赖变更日志）。
 */
import { diffLines, type DiffRow } from "../../lib/textDiff";
import { latestTouch } from "../../lib/blockOwners";
import type { BlockInfo, StripState } from "../../lib/blockState";
import type { Requirement } from "../../lib/requirements";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";

export const STRIP_PX = 28;
const MINI_ROW_PX = 18;
const MINI_MAX_ROWS = 12;

/** 小对比的行；当时的内容没存（P1 的标记 / 超长块）返回 null。 */
export function miniRows(info: BlockInfo): DiffRow[] | null {
  const before = info.prior?.text;
  if (before == null) return null;
  const r = diffLines(before, info.block.currentLines.join("\n"));
  return r.tooBig ? null : r.rows;
}
export function miniHeight(rows: DiffRow[] | null): number {
  return (rows ? Math.min(rows.length, MINI_MAX_ROWS) : 1) * MINI_ROW_PX + 10;
}

const CLIENT_LABEL: Record<string, string> = { "claude-code": "Claude Code", claude: "Claude", codex: "Codex", cursor: "Cursor", qoder: "Qoder" };
const clientName = (c?: string | null) => (c ? CLIENT_LABEL[c.toLowerCase()] ?? c : "AI");
function fmt(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface BlockStripProps {
  info: BlockInfo;
  state: StripState;
  /** 变更日志是否可用（不可用时只留审查勾选）。 */
  journal: boolean;
  reqName: (id: string) => string;
  /** 当前在哪个需求里审（null / "-" = 不分需求）。 */
  ctxReq: string | null;
  openReqs: Requirement[];
  miniOpen: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onMini: () => void;
  onJumpReq: (id: string) => void;
  onClaim: (id: string | "new") => void;
}

export function BlockStrip(p: BlockStripProps) {
  const { info, state } = p, last = latestTouch(info.origin);
  const reason = last?.reason ? <span className="vc-strip-reason" title={last.reason}>原因：{last.reason}</span> : null;
  const guess = info.origin.fileLevel && info.origin.touches.length > 0 ? <span className="vc-strip-dim" title="变更日志里的备份不全，没能逐行归属，按整个文件的改动记录推断">按文件推断</span> : null;
  const toggle = <button type="button" className="vc-btn vc-btn-sm vc-strip-check" data-on={info.reviewed || undefined} disabled={p.disabled} onClick={p.onToggle}
    title={info.reviewed ? "取消这一块的已审" : "把这一块标为已审"}><Icon name="check" size={11} /><span>{info.reviewed ? "已审 · 取消" : "审过"}</span></button>;
  const mini = p.miniOpen && <MiniDiff info={info} />;
  const reqLabel = !p.ctxReq || p.ctxReq === "-" ? info.reqs.map(p.reqName).join("、") : "";

  if (!p.journal && state !== "redo") {
    return <div className="vc-strip" data-state={info.reviewed ? "reviewed" : "plain"}><span className="vc-strip-main"><span className="vc-strip-dim">{info.reviewed ? "这一块已审" : "这一块未审"}</span></span>{toggle}</div>;
  }
  if (state === "other") {
    const other = info.reqs.find((id) => id !== p.ctxReq) ?? info.reqs[0];
    return <div className="vc-strip" data-state="other">
      <span className="vc-strip-main"><Icon name="alert" size={12} /><b>属于需求「{info.reqs.map(p.reqName).join("」「")}」</b>
        <span className="vc-strip-dim">出本需求的补丁会把这块一起带上线（NC 补丁整类替换）</span>{reason}</span>
      {other && <button type="button" className="vc-btn vc-btn-sm" onClick={() => p.onJumpReq(other)}>跳到那个需求</button>}
    </div>;
  }
  if (state === "redo") {
    return <div className="vc-strip" data-state="redo" data-mini={p.miniOpen || undefined}>
      <div className="vc-strip-row">
        <span className="vc-strip-main"><span className="vc-strip-badge">{last?.source === "manual" ? "我" : "AI"}</span><b>需重审</b>
          <span className="vc-strip-dim">你审完后又改了{last && last.atMs > (info.prior?.atMs ?? 0) ? `（${fmt(last.atMs)}）` : ""}</span>{p.journal && reason}</span>
        <button type="button" className="vc-btn vc-btn-sm" aria-expanded={p.miniOpen} onClick={p.onMini}>{p.miniOpen ? "收起对比" : "只看这次改了什么"}</button>{toggle}
      </div>{mini}
    </div>;
  }
  if (state === "manual") {
    return <div className="vc-strip" data-state="manual">
      <span className="vc-strip-main"><span className="vc-strip-badge">我</span><b>你在 NCForge 里改的</b><span className="vc-strip-dim">{fmt(last?.atMs ?? 0)}</span>
        <span className="vc-strip-dim">{last?.req ? `保存时的当前需求：${p.reqName(last.req)}` : "保存时没有选当前需求"}（手改没有原因）</span>{guess}</span>{toggle}
    </div>;
  }
  if (state === "unknown") {
    return <div className="vc-strip" data-state="unknown">
      <span className="vc-strip-main"><span className="vc-strip-badge">?</span><b>来源不明</b><span className="vc-strip-dim">没有变更日志记录：可能是命令、其他编辑器或 SVN 外部改的</span></span>
      {p.ctxReq === "-" || !info.reqs.length ? <Menu portal width="w-56" trigger={(open, flip) => <button type="button" className="vc-btn vc-btn-sm" aria-haspopup="menu" aria-expanded={open} onClick={flip}>归入需求…</button>}>
        {close => <>
          <MenuItem label="把整个文件归入：" disabled onClick={() => undefined} />
          {p.openReqs.map((r) => <MenuItem key={r.id} label={r.name} onClick={() => { close(); p.onClaim(r.id); }} />)}
          <MenuItem label="＋ 新建需求…" onClick={() => { close(); p.onClaim("new"); }} />
        </>}
      </Menu> : null}{toggle}
    </div>;
  }
  return <div className="vc-strip" data-state={state}>
    <span className="vc-strip-main"><span className="vc-strip-badge">AI</span><b>{clientName(last?.client)}</b><span className="vc-strip-dim">{fmt(last?.atMs ?? 0)}</span>
      {reqLabel && <span className="vc-tag" data-tone="muted" title="这一块属于的需求">{reqLabel}</span>}{reason}{guess}</span>{toggle}
  </div>;
}

function MiniDiff({ info }: { info: BlockInfo }) {
  const rows = miniRows(info);
  if (!rows) return <div className="vc-strip-mini"><span className="vc-strip-dim">上次审的时候没有保存这一块的内容（或太长），无法对比。</span></div>;
  return <div className="vc-strip-mini" style={{ maxHeight: miniHeight(rows) - 10 }} aria-label="上次审过的版本 → 现在">
    {rows.map((r, i) => <div key={i} className="vc-strip-mini-row" data-op={r.op}><span>{r.op === "add" ? "+" : r.op === "del" ? "−" : " "}</span><code>{r.text || " "}</code></div>)}
  </div>;
}
