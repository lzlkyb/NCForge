import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { Modal } from "../ui/Modal";
import type { LaunchPreview } from "../../lib/server";

/**
 * 启动命令行预览。
 *
 * 排错时最有用的东西：用户可以把它和 Eclipse 的启动配置逐项对照，
 * 立刻看出是 VM 参数不对还是 classpath 少了一条，而不用猜「为什么起不来」。
 */
export function CommandLineDialog({
  preview,
  onClose,
  kind = "server",
}: {
  preview: LaunchPreview | null;
  onClose: () => void;
  /** 客户端预览与中间件的结构相同，只是 classpath 规则与提示文案不同。 */
  kind?: "server" | "client";
}) {
  const client = kind === "client";
  return (
    <Modal
      open={!!preview}
      onClose={onClose}
      ariaLabel={client ? "客户端启动命令行" : "启动命令行"}
      className="modal-surface w-[860px] max-w-[92vw] p-5"
    >
      <div className="flex items-center gap-2">
        <Icon name="terminal" size={15} />
        <h2 className="text-sm font-semibold">{client ? "客户端启动命令行" : "启动命令行"}</h2>
        <span className="text-xs text-muted-foreground">
          {client ? "中间件端口" : "端口"} {preview?.endpoints.httpPort ?? "—"}
          {preview?.endpoints.httpAddress ? `（${preview.endpoints.httpAddress}）` : ""}
          {" · "}classpath {preview?.entryCount ?? 0} 项 · 工作目录 {preview?.workDir ?? ""}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="sv-btn"
          onClick={() => {
            if (!preview) return;
            void navigator.clipboard
              .writeText(preview.commandLine)
              .then(() => toast("已复制命令行", "success"))
              .catch((e) => toast(`复制失败：${e}`, "error"));
          }}
        >
          <Icon name="copy" size={13} />
          复制
        </button>
      </div>
      <pre className="sv-cmdline">{preview?.commandLine}</pre>
      {preview?.reused && (
        <p className="sv-cmd-hint" data-tone="warn">
          这里复用的是<b>上次启动</b>写好的 classpath 清单，没有重新扫盘——改了工程目录或 NC
          home 之后需要启动一次才会更新（预览若重新写清单，会和正在进行的启动抢同一个临时文件）。
        </p>
      )}
      <p className="sv-cmd-hint">
        {client
          ? "客户端连接地址取自 "
          : "端口读自 "}
        <code>{preview?.endpoints.configPath || "ierp/bin/prop.xml"}</code>
        {client
          ? "（-Dnc.jstart.server/port）。中间件改过端口后，重启客户端才能连到新端口——已经起来的 JVM 不会重读配置。"
          : "（NC 自己的服务器配置，bin/sysConfig.bat 改的也是它）。要换端口就点状态卡上的端口号——会连同 web 端的 system.ejb.port 一起改，只改一处网页端会连不上。"}
      </p>
      <p className="sv-cmd-hint">
        {client ? (
          <>
            排错时对照 Eclipse 的 <code>JStarter</code> 启动配置：classpath 只有一个 pathing jar，
            真正的 {preview?.entryCount ?? 0} 个条目写在它的 META-INF/MANIFEST.MF 里。客户端按 Eclipse
            的客户端规则收集（工程输出 + 产品公共库 + 模块 public/client + langlib），不含 middleware /
            framework / ant。内存上限是 <code>-Xmx{preview?.heapMb ?? 768}m</code>，要改就回配置栏的
            「客户端堆上限」，改完重启客户端生效。
          </>
        ) : (
          <>
            排错时对照 Eclipse 的启动配置：classpath 只有一个 pathing jar，真正的{" "}
            {preview?.entryCount ?? 0} 个条目写在它的 META-INF/MANIFEST.MF 里。这里的内存上限是{" "}
            <code>-Xmx{preview?.heapMb ?? 4096}m</code>——Eclipse 老配置是 1G，跑 245 个模块不够；
            要改就回服务页的「堆上限」，改完重启服务生效。
          </>
        )}
      </p>
    </Modal>
  );
}
