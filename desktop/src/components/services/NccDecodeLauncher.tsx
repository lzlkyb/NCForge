import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "../ui/icon";
import { registerCommands } from "../../lib/commandRegistry";
import { NccDecodeDialog } from "./NccDecodeDialog";

/**
 * 服务页工具栏上的「报文解密」入口，同时登记一条命令面板命令。
 *
 * 单独一个组件而不是把开关塞进 ServicesTab：服务页的 useState 已经顶到门禁上限，
 * 工具栏只挂这个自包含入口（按钮 + 弹层），页面本身不增加状态。
 */
export function NccDecodeLauncher({ trigger }: { trigger?: (open: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(
    () =>
      registerCommands([
        {
          id: "tools.nccDecode",
          title: "工具：NCC / BIP 报文解密",
          run: () => setOpen(true),
        },
      ]),
    [],
  );
  return (
    <>
      {trigger ? trigger(() => setOpen(true)) : <button
        type="button"
        className="sv-btn"
        title="解密 NCC/BIP 请求报文（AES + GZIP，读服务端 miscellaneous.xml 开关）"
        onClick={() => setOpen(true)}
      >
        <Icon name="key" size={13} />
        报文解密
      </button>}
      <NccDecodeDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
