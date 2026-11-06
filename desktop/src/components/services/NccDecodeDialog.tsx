import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { Modal } from "../ui/Modal";
import { trackOperation } from "../../lib/operations";
import { nccDecodeConfig } from "../../lib/ncc";
import { DEFAULT_COWBOY_KEY, decodePayload, type DecodeOptions } from "../../lib/nccDecode";

const inputCls =
  "w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring";
const labelCls = "flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none";

/**
 * NCC/BIP 报文解密（对齐上游 `NCCJsonDecodeDialog`）。
 *
 * 开关默认取 NC 自己的 `miscellaneous.xml`；文件读不到时按上游口径全开，
 * 并在顶部说明「这些开关不是从文件读的」，避免用户以为工具知道服务端真实配置。
 */
export function NccDecodeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cfg = useQuery({
    queryKey: ["ncc-decode-config"],
    queryFn: nccDecodeConfig,
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });
  const [input, setInput] = useState("");
  const [result, setResult] = useState<{ text: string; notes: string[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [opts, setOpts] = useState<DecodeOptions | null>(null);

  // opts 为空时跟随服务端开关；用户手动勾过之后以用户为准（不再被异步回来的配置覆盖）
  const cur: DecodeOptions = opts ?? {
    aes: cfg.data?.aes ?? true,
    gzip: cfg.data?.gzip ?? true,
    pretty: true,
    aesKey: "",
    crux: "",
    cowboy: "",
    cowboyAesKey: DEFAULT_COWBOY_KEY,
  };
  const set = (patch: Partial<DecodeOptions>) => setOpts({ ...cur, ...patch });

  const lock = useRef(false);
  const run = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      setResult(await trackOperation({ key: "tools.ncc.decode", label: "解密 NCC 报文", page: "files" }, () => decodePayload(input, cur)));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const copy = () => {
    if (!result) return;
    void navigator.clipboard
      .writeText(result.text)
      .then(() => toast("已复制解密结果", "success"))
      .catch((e) => toast(`复制失败：${e}`, "error"));
  };

  const flagText = cfg.isLoading
    ? "正在读取服务端开关…"
    : cfg.data?.found
      ? `服务端开关：AES ${cfg.data.aes ? "开" : "关"} · GZIP ${cfg.data.gzip ? "开" : "关"} · 加签 ${cfg.data.mark ? "开" : "关"}`
      : "没读到 miscellaneous.xml（NC home 未配置或文件不存在，到设置 → 开发 →「NC 环境」配置），按默认全开；请按实际配置调整";

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="NCC/BIP 报文解密"
      className="modal-surface w-[900px] max-w-[94vw] p-5"
    >
      <div className="flex items-center gap-2">
        <Icon name="key" size={15} />
        <h2 className="text-sm font-semibold">NCC / BIP 报文解密</h2>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{flagText}</span>
        <span className="flex-1" />
        <button type="button" className="sv-btn" disabled={!result} onClick={copy}>
          <Icon name="copy" size={13} />
          复制结果
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="ncc-input">
            请求报文（requestData）
          </label>
          <textarea
            id="ncc-input"
            className={`${inputCls} h-48 resize-none`}
            placeholder="粘贴服务端日志 / 抓包里的加密报文"
            value={input}
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="ncc-output">
            解密结果
          </label>
          <textarea
            id="ncc-output"
            className={`${inputCls} h-48 resize-none`}
            value={result?.text ?? ""}
            readOnly
            spellCheck={false}
            placeholder="解密后的 JSON 会显示在这里"
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className={labelCls}>
          <input type="checkbox" checked={cur.aes} onChange={(e) => set({ aes: e.target.checked })} />
          AES 解密
        </label>
        <label className={labelCls}>
          <input type="checkbox" checked={cur.gzip} onChange={(e) => set({ gzip: e.target.checked })} />
          GZIP 解压
        </label>
        <label className={labelCls}>
          <input
            type="checkbox"
            checked={cur.pretty}
            onChange={(e) => set({ pretty: e.target.checked })}
          />
          JSON 美化
        </label>
        <span className="flex-1" />
        <button type="button" className="sv-btn" onClick={() => setAdvanced((v) => !v)}>
          <Icon name={advanced ? "chevronDown" : "chevronRight"} size={12} />
          cowboy 换算
        </button>
        <button
          type="button"
          className="sv-btn sv-btn-primary"
          disabled={busy || input.trim() === ""}
          onClick={() => void run()}
        >
          {busy && <Icon name="spinner" size={13} className="animate-spin" />}
          {busy ? "解密中…" : "解密"}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="flex min-w-[260px] flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
          aesKey
          <input
            className={inputCls}
            value={cur.aesKey}
            placeholder="Base64 的 32 位串（与 crux 拼成 32 位后使用）"
            spellCheck={false}
            onChange={(e) => set({ aesKey: e.target.value })}
          />
        </label>
        <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
          crux
          <input
            className={inputCls}
            value={cur.crux}
            placeholder="与 aesKey 拼接的前缀"
            spellCheck={false}
            onChange={(e) => set({ crux: e.target.value })}
          />
        </label>
      </div>

      {advanced && (
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <label className="flex min-w-[260px] flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
            cowboy（aesKey 的密文；填了它且 aesKey 为空时自动换算）
            <input
              className={inputCls}
              value={cur.cowboy}
              spellCheck={false}
              onChange={(e) => set({ cowboy: e.target.value })}
            />
          </label>
          <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
            cowboyAesKey
            <input
              className={inputCls}
              value={cur.cowboyAesKey}
              spellCheck={false}
              onChange={(e) => set({ cowboyAesKey: e.target.value })}
            />
          </label>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {result?.notes.map((n) => (
        <p className="mt-1 text-[11px] text-muted-foreground" key={n}>
          {n}
        </p>
      ))}

      <p className="mt-3 text-[10.5px] leading-relaxed text-muted-foreground">
        算法与上游插件一致：密文 = base64(hex 文本)，AES/CTR/NoPadding，IV 固定
        <code> db2139561c9fe068 </code>，密钥 = base64((crux + aesKey) 前 32 位)。
        开关读自 <code>{cfg.data?.path || "hotwebs/nccloud/WEB-INF/config/miscellaneous.xml"}</code>。
        解密只在本机进行，报文不会发往任何服务。
      </p>
    </Modal>
  );
}
