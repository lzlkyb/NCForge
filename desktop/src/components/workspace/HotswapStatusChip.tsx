import { useEffect, useRef, useState, type ReactNode } from "react";
import "../../services.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { serverStatus } from "../../lib/server";
import {
  HOTSWAP_STATUS_KEY,
  dismissHotswapFailure,
  failureSummary,
  hotswapClearPending,
  hotswapPushPending,
  hotswapStatus,
  shortClassName,
  startHotswapEvents,
  useHotswapEvent,
  type HotswapReport,
  type HotswapStatus,
} from "../../lib/hotswap";
import { requestServiceRestart } from "../../lib/servicePanel";
import { requestSettingsSection } from "../../lib/settingsJump";
import { openLinkedDialog } from "../../lib/linkedDialog";
import { errorToast } from "../../lib/errorToast";
import { Menu } from "../ui/Menu";

/** 成功后绿签停留多久，之后回落成灰色「热替换」。 */
const FLASH_MS = 8000;
/** agent 还没就绪时的轮询间隔（JVM 打开完所有 jar 约 2.5 分钟后才就绪）。 */
const WAIT_AGENT_MS = 5000;

type Tone = "ok" | "warn" | "bad" | "busy" | "muted" | "idle";

/**
 * 状态栏里的热替换小签（设计稿 design/热替换界面设计稿-2026-11-09.html）。
 *
 * 只在服务运行中、且开关打开时出现：服务停着时热替换不会发生，常驻只是噪音。
 * 点开是一张明细卡：替换了哪些类、谁被遮挡、失败原因、断点是否已重装，以及
 * 「推送 / 重启服务」入口。失败的 toast 和断点重装在 `lib/hotswap` 的模块级订阅里做，
 * 不随这个组件的挂载走。
 */
export function HotswapStatusChip() {
  const queryClient = useQueryClient();
  useEffect(() => startHotswapEvents(queryClient), [queryClient]);
  // 与状态栏的服务胶囊共用查询键：那边负责 5 秒轮询，这里只订阅
  const server = useQuery({ queryKey: ["server-status"], queryFn: serverStatus, retry: false }).data;
  const running = server?.state === "running";
  const hs = useQuery({
    queryKey: [...HOTSWAP_STATUS_KEY, server?.runId ?? ""],
    queryFn: hotswapStatus,
    enabled: running,
    retry: false,
    refetchInterval: (q) => (q.state.data && q.state.data.enabled && q.state.data.agentAttached && !q.state.data.agentOnline ? WAIT_AGENT_MS : false),
  }).data;
  const event = useHotswapEvent();
  // 服务重启或停止后，「服务上仍是旧代码」的失败提醒已经过时
  const runKey = running ? (server?.runId ?? "") : null;
  const seenRun = useRef(runKey);
  useEffect(() => {
    if (seenRun.current === runKey) return;
    seenRun.current = runKey;
    dismissHotswapFailure();
  }, [runKey]);
  const [now, setNow] = useState(() => Date.now());
  const [pushing, setPushing] = useState(false);

  // 成功的绿签到点自己回落：只在有新事件时挂一个定时器
  const flashUntil = event && event.report.state === "ok" ? event.report.atMs + FLASH_MS : 0;
  useEffect(() => {
    setNow(Date.now());
    if (!flashUntil) return;
    const left = flashUntil - Date.now();
    if (left <= 0) return;
    const t = window.setTimeout(() => setNow(Date.now()), left + 50);
    return () => window.clearTimeout(t);
  }, [flashUntil]);

  if (!running || !hs || !hs.enabled) return null;

  const last = hs.last;
  const view = chipView(hs, pushing, flashUntil > now);

  const push = async (close: () => void) => {
    close();
    setPushing(true);
    try {
      await hotswapPushPending();
    } catch (e) {
      errorToast("热替换推送", e);
    } finally {
      setPushing(false);
      void queryClient.invalidateQueries({ queryKey: HOTSWAP_STATUS_KEY });
    }
  };
  const clear = async (close: () => void) => {
    close();
    try {
      await hotswapClearPending();
    } catch (e) {
      errorToast("清空待推送", e);
    }
  };
  const goSettings = (close: () => void) => {
    close();
    requestSettingsSection("任务");
    window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "settings" }));
  };
  const restart = (close: () => void) => {
    close();
    requestServiceRestart();
  };

  if (view.tone === "busy") {
    return (
      <span className="wb-status-chip" data-tone="busy">
        <span className="wb-status-dot" data-tone="busy" />
        {view.label}
      </span>
    );
  }

  return (
    <Menu
      portal
      align="right"
      width="w-[360px]"
      trigger={(open, toggle) => (
        <button
          type="button"
          className="wb-status-chip"
          data-tone={view.tone === "idle" ? undefined : view.tone}
          aria-haspopup="menu"
          aria-expanded={open}
          title={view.title}
          onClick={() => {
            // 卡片里就是同样的失败信息，而且右下角的 toast 会压住卡片
            if (!open) dismissHotswapFailure();
            toggle();
          }}
        >
          {view.dot && <span className="wb-status-dot" data-tone={view.dot} />}
          {view.label}
        </button>
      )}
    >
      {(close) => (
        <div className="wb-hs-card">
          {hs.pending > 0 ? (
            <>
              <div className="wb-hs-head">
                <span className="wb-hs-title">{hs.pending} 个类待推送</span>
              </div>
              <ul className="wb-hs-list">
                {hs.pendingClasses.map((n) => <li key={n} title={n}>{n}</li>)}
                {hs.pending > hs.pendingClasses.length && <li className="wb-hs-more">… 另 {hs.pending - hs.pendingClasses.length} 个</li>}
              </ul>
              <div className="wb-hs-foot">
                <button type="button" className="sv-btn sv-btn-ghost" onClick={() => void clear(close)}>清空</button>
                <button type="button" className="sv-btn sv-btn-primary" onClick={() => void push(close)}>推送 {hs.pending} 个类</button>
              </div>
            </>
          ) : !hs.agentOnline ? (
            <>
              <div className="wb-hs-head">
                <span className="wb-status-dot" />
                <span className="wb-hs-title">{hs.agentAttached ? "热替换准备中" : "热替换未挂载"}</span>
              </div>
              <div className="wb-hs-body">
                {hs.agentAttached
                  ? "agent 要等 NC 加载完所有 jar 才就绪（约 2~3 分钟）。就绪前保存的改动不会推送，服务启动时已加载的就是当时磁盘上的代码。"
                  : "本次服务启动时没有带热替换 agent，改动不会推送。重启服务后自动挂上。"}
              </div>
              <div className="wb-hs-foot">
                <button type="button" className="sv-btn sv-btn-ghost" onClick={() => goSettings(close)}>设置</button>
                {!hs.agentAttached && <button type="button" className="sv-btn" onClick={() => restart(close)}>重启服务</button>}
              </div>
            </>
          ) : last ? (
            <ReportCard
              report={last}
              breakpoints={event?.report.atMs === last.atMs ? event.breakpoints : null}
              onSettings={() => goSettings(close)}
              onRestart={() => restart(close)}
              onLinked={() => { close(); openLinkedDialog("chain"); }}
            />
          ) : (
            <>
              <div className="wb-hs-head">
                <span className="wb-status-dot" data-tone="ok" />
                <span className="wb-hs-title">热替换已就绪</span>
              </div>
              <div className="wb-hs-body">
                {hs.auto ? "保存 .java 且编译通过后，改动会自动替换进运行中的服务。只能改方法体；改了类的结构需要重启。" : "已关闭自动推送：编译通过的类会先攒着，在这里手动推送。"}
              </div>
              <div className="wb-hs-foot">
                <button type="button" className="sv-btn sv-btn-ghost" onClick={() => goSettings(close)}>设置</button>
              </div>
            </>
          )}
        </div>
      )}
    </Menu>
  );
}

/** 小签的文案与色调（导出给单测）。 */
export function chipView(hs: HotswapStatus, pushing: boolean, flash: boolean): { tone: Tone; dot?: "ok" | "warn" | "bad" | "idle"; label: string; title: string } {
  if (pushing) return { tone: "busy", label: "热替换中…", title: "" };
  if (hs.pending > 0) return { tone: "warn", label: `↑ 待推送 ${hs.pending}`, title: "自动推送已关闭：点开推送" };
  if (!hs.agentOnline) {
    return hs.agentAttached
      ? { tone: "muted", dot: "idle", label: "热替换 · 准备中", title: "agent 在等 NC 加载完 jar，约 2~3 分钟后就绪" }
      : { tone: "muted", dot: "idle", label: "热替换 · 未挂载", title: "本次启动没有带热替换 agent；重启服务后生效" };
  }
  const last = hs.last;
  if (last?.state === "failed") return { tone: "bad", dot: "bad", label: "热替换失败", title: failureSummary(last) };
  if (last?.state === "partial") return { tone: "warn", dot: "warn", label: `热替换 · ${last.shadowed.length} 个未生效`, title: failureSummary(last) };
  if (last && flash) return { tone: "ok", dot: "ok", label: `已替换 ${last.redefined.length} 个类`, title: "点开查看明细" };
  return { tone: "idle", dot: "ok", label: "热替换", title: hs.stale ? "之前有改动没能替换进去，服务页有提示" : "热替换已就绪 · 点开查看上次结果" };
}

function ReportCard({ report, breakpoints, onSettings, onRestart, onLinked }: { report: HotswapReport; breakpoints: number | null; onSettings: () => void; onRestart: () => void; onLinked: () => void }) {
  const time = new Date(report.atMs).toLocaleTimeString();
  const failed = report.state === "failed";
  const partial = report.state === "partial";
  return (
    <>
      <div className="wb-hs-head">
        <span className="wb-status-dot" data-tone={failed ? "bad" : partial ? "warn" : "ok"} />
        <span className="wb-hs-title" data-tone={failed ? "bad" : partial ? "warn" : undefined}>
          {failed ? "热替换失败 · 本批未应用" : partial ? "部分生效" : "热替换成功"}
        </span>
        <small>{time}{failed ? "" : ` · ${report.elapsedMs} ms`}</small>
      </div>
      <div className="wb-hs-body">
        {failed ? (
          <>
            <Row k="原因">{failureSummary(report)}{report.code === "unsupported" ? "，需要重启服务。" : ""}</Row>
            <Row k="本批">{report.requested} 个类全部未应用（JVM 一批要么全成要么全不成）</Row>
          </>
        ) : (
          <>
            <Row k="已替换">
              {report.redefined.length === 0 ? "无" : <ul className="wb-hs-list">{report.redefined.map((c) => <li key={c.name} title={c.name}>{c.name}</li>)}</ul>}
            </Row>
            {report.shadowed.length > 0 && (
              <Row k="被遮挡" tone="warn">
                <ul className="wb-hs-list">
                  {report.shadowed.map((c) => (
                    <li key={c.name} title={c.name}>
                      {shortClassName(c.name)}
                      <span className="wb-hs-note">{c.source ? `JVM 里跑的是 ${c.source} 下的同名类` : "JVM 里跑的是 jar 里的同名类"}</span>
                    </li>
                  ))}
                </ul>
              </Row>
            )}
            {report.notLoaded.length > 0 && (
              <Row k="未加载">{report.notLoaded.length} 个（JVM 还没用到，首次加载时自然是新代码）</Row>
            )}
            {breakpoints !== null && breakpoints > 0 && <Row k="断点">已重新下发 {breakpoints} 个断点</Row>}
          </>
        )}
      </div>
      <div className="wb-hs-foot">
        {failed ? (
          <button type="button" className="sv-btn sv-btn-ghost" onClick={() => void navigator.clipboard?.writeText(report.message ?? "")}>复制详情</button>
        ) : (
          <button type="button" className="sv-btn sv-btn-ghost" onClick={partial ? onLinked : onSettings}>{partial ? "工程关联" : "设置"}</button>
        )}
        {/* 遮挡（partial）不给重启：重启后 classpath 顺序不变，跑的还是那份同名类 */}
        {failed && <button type="button" className="sv-btn sv-btn-primary" onClick={onRestart}>重启服务</button>}
      </div>
    </>
  );
}

function Row({ k, tone, children }: { k: string; tone?: "warn"; children: ReactNode }) {
  return (
    <div className="wb-hs-row">
      <span className="wb-hs-k" data-tone={tone}>{k}</span>
      <div className="wb-hs-v">{children}</div>
    </div>
  );
}
