// 远程附加表单：手工填 JDWP 地址（多数场景是 SSH 隧道映射到本机的端口）。
//
// 为什么不做「自动发现远程 JVM」：JDWP 无认证，扫描/敞开端口等同远程执行入口。
// 工作台只负责连用户明确给出的回环/隧道地址，把安全边界留给 SSH。
import { useState } from "react";
import { Icon } from "../ui/icon";
import { loadRemoteInput, parseRemoteInput, saveRemoteInput } from "../../lib/debugRemote";

export function RemoteAttachForm({
  busy,
  onAttach,
}: {
  busy: boolean;
  onAttach: (host: string, port: number) => void;
}) {
  const [input, setInput] = useState(loadRemoteInput);
  const { endpoint, error } = parseRemoteInput(input.host, input.port);

  const submit = () => {
    if (!endpoint) return;
    saveRemoteInput(input);
    onAttach(endpoint.host, endpoint.port);
  };

  return (
    <div className="dbg-remote">
      <div className="dbg-remote-title">
        <Icon name="server" size={13} />
        远程附加
      </div>
      <div className="dbg-remote-row">
        <label>
          主机
          <input
            value={input.host}
            placeholder="127.0.0.1"
            spellCheck={false}
            onChange={(e) => setInput({ ...input, host: e.target.value })}
          />
        </label>
        <label>
          JDWP 端口
          <input
            value={input.port}
            placeholder="如 5005"
            inputMode="numeric"
            spellCheck={false}
            onChange={(e) => setInput({ ...input, port: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </label>
        <button
          type="button"
          className="dbg-btn dbg-btn-primary"
          disabled={!endpoint || busy}
          title={endpoint ? `附加到 ${endpoint.host}:${endpoint.port}` : error ?? ""}
          onClick={submit}
        >
          {busy ? <Icon name="spinner" size={12} className="animate-spin" /> : <Icon name="bug" size={12} />}
          {busy ? "附加中…" : "附加远程 JVM"}
        </button>
      </div>
      {error && <div className="dbg-remote-error">{error}</div>}

      <div className="wb-panel-note dbg-remote-note">
        <p>
          推荐先建 SSH 隧道，让远端 JDWP 仍只绑 <code>127.0.0.1</code>：
          <code className="dbg-remote-cmd">ssh -L 5005:127.0.0.1:61539 user@server</code>
          然后这里填 <b>127.0.0.1</b> 和 <b>5005</b>。
        </p>
        <p>
          不要把远端 JDWP 开到 <code>0.0.0.0</code>：它没有认证，等同于远程执行入口。
          调试的类与源码需和远端部署版本一致，否则断点会显示为未落点。
        </p>
      </div>
    </div>
  );
}
