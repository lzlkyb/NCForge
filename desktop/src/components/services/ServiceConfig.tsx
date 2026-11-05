import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { PathField } from "./PathField";
import { HeapField } from "./HeapField";
import { beginOperation } from "../../lib/operations";
import { applyWorkspace } from "../../lib/switchWorkspace";
import { ensureFilesSaved } from "../../lib/terminatePreflight";
import { ncHomeProbe, ncHomeSet, serverHeapSet, type ServerStatus } from "../../lib/server";
import { clientHeapSet, type ClientStatus } from "../../lib/client";

/**
 * 服务页配置栏：NC home / 工程 / 堆上限。
 *
 * 这三个字段有个共同前提——**改配置不会改变已经在跑的那个 JVM**。端口和堆只能启动时
 * 决定（后端会拒或提示重启），而 NC home / 工程更阴：运行中换了 home，状态轮询按新
 * home 的 prop.xml 取端口，我们的 java 不在新端口上监听 → `portOwnedBySelf=false`
 * → 界面永远「启动中」，用户无从得知服务其实还在跑；若新端口恰被另一个 java 占着，
 * 界面还会提供「结束该进程」，一点就误杀别人的进程。所以运行中改这两项必须先确认。
 */
export function ServiceConfig({
  status,
  running,
  clientStatus,
  clientRunning,
  onRefetch,
  onRefetchClient,
}: {
  status: ServerStatus | null;
  /** running / starting（含准备启动的那一秒）。 */
  running: boolean;
  clientStatus: ClientStatus | null;
  clientRunning: boolean;
  onRefetch: () => void;
  onRefetchClient: () => void;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<null | {
    label: string;
    value: string;
    resolve: (ok: boolean) => void;
  }>(null);

  // NC home 只探测一次就够（换目录时用 setQueryData 覆盖）
  const probe = useQuery({
    queryKey: ["nc-home"],
    queryFn: () => ncHomeProbe(),
    staleTime: 30_000,
    retry: false,
  });

  /** 运行中切换先问一句；false = 用户取消，PathField 保持编辑态。 */
  const confirmRunning = useCallback(
    (label: string, value: string) =>
      new Promise<boolean>((resolve) => setPending({ label, value, resolve })),
    [],
  );

  const finish = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  return (
    <>
      {probe.error && (
        <div className="sv-alert" data-tone="warn">
          <Icon name="info" size={14} />
          <span className="sv-alert-text">找不到 NC 安装目录：{String(probe.error)}</span>
        </div>
      )}

      <div className="sv-cfg">
        <PathField
          label="NC home"
          value={probe.data?.root ?? status?.ncHome ?? ""}
          placeholder="D:\ncc\1909home"
          hint={probe.data ? `${probe.data.moduleCount} 个模块` : undefined}
          onSave={async (v) => {
            if (running && !(await confirmRunning("NC home", v))) return "cancelled";
            const home = await ncHomeSet(v);
            queryClient.setQueryData(["nc-home"], home);
            toast(running ? "NC home 已保存，重启服务后生效" : "NC home 已切换", "success");
            onRefetch();
          }}
        />
        <span className="sv-cfg-sep" />
        <PathField
          label="工程"
          value={status?.projectRoot ?? ""}
          placeholder="C:\work\aier\newar"
          hint={status?.projectRoot ? "改完代码编译后重启即生效" : "未选择"}
          onSave={async (v) => {
            const task = beginOperation({ key: "workspace.switch", label: "切换工程", scope: v, page: "files", phase: "检查运行服务与未保存文件" });
            if (!task) throw new Error("工程正在切换，请稍候");
            try {
              if (running && !(await confirmRunning("工程目录", v))) { task.finish("cancelled", "用户取消工程切换"); return "cancelled"; }
              // 服务页和文件页共用同一把锁与保存守卫，防止跨入口重复切换丢失标签。
              if (!(await ensureFilesSaved("切换工程"))) { task.finish("cancelled", "用户取消工程切换"); return "cancelled"; }
              task.update({ phase: "验证目录并切换工作区" });
              const shown = await applyWorkspace(v, queryClient);
              task.finish("success", "工程已切换；代码智能按新工程单独准备");
              toast(running ? `工程已切换为 ${shown}，重启服务后生效` : `工程已切换为 ${shown}`, "success");
              onRefetch();
            } catch (error) { task.finish("failed", String(error)); throw error; }
          }}
        />
        {/* 堆上限：状态里带的是「后端收口后真正会写进命令行」的值，
            界面上显示生效值而不是配置原值——手改过 config.json 的人才不会被骗 */}
        {status && (
          <>
            <span className="sv-cfg-sep" />
            <HeapField
              heapMb={status.heapMb}
              defaultHeapMb={status.defaultHeapMb}
              running={running}
              onSave={async (mb) => {
                const applied = await serverHeapSet(mb);
                onRefetch();
                return applied;
              }}
            />
          </>
        )}
        {/* 客户端是另一个 JVM，堆上限单独存（默认 768M）。放在同一栏里是因为
            它同样属于「启动参数」，改了也得重启客户端才生效。 */}
        {clientStatus && (
          <>
            <span className="sv-cfg-sep" />
            <HeapField
              label="客户端堆上限"
              scope="客户端"
              heapMb={clientStatus.heapMb}
              defaultHeapMb={clientStatus.defaultHeapMb}
              running={clientRunning}
              onSave={async (mb) => {
                const applied = await clientHeapSet(mb);
                onRefetchClient();
                return applied;
              }}
            />
          </>
        )}
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={`服务正在运行，切换${pending?.label ?? ""}？`}
        description={
          <>
            在跑的 JVM 不会重读配置：<b>新设置要停止并重启服务才生效</b>。切换后状态栏会按新
            配置报告端口，可能出现「启动中」或端口冲突提示——那是旧进程还在用旧配置，
            不是它没停下来。
          </>
        }
        confirmLabel="仍然切换"
        onCancel={() => finish(false)}
        onConfirm={() => finish(true)}
      />
    </>
  );
}
