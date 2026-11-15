import { type ClipboardEvent } from "react";
import { type DbConnForm } from "../../lib/dbConnForm";
import { parseOracleUrl } from "../../lib/dbApi";

export function ConnAddressFields({ form, fieldId, put, invalid, raw, setRaw }: {
  form: DbConnForm;
  fieldId: (name: string) => string;
  put: (patch: Partial<DbConnForm>) => void;
  invalid: string | null;
  raw: boolean;
  setRaw: (raw: boolean) => void;
}) {
  const paste = (event: ClipboardEvent) => {
    const value = event.clipboardData.getData("text").trim();
    if (!/^jdbc:oracle:/i.test(value)) return;
    event.preventDefault();
    put({ url: value });
    setRaw(!isSimpleConnAddress(value));
  };
  const canUseHost = !form.url.trim() || isSimpleConnAddress(form.url);
  const error = (key: string, message: string) => invalid === key
    ? <span className="dbx-conn-error" id={fieldId(key + "-error")}>{message}</span> : null;
  const status = (key: string) => ({
    "aria-invalid": invalid === key || undefined,
    "aria-describedby": invalid === key ? fieldId(key + "-error") : undefined,
  });
  return (
    <div className="dbx-conn-address" onPaste={paste}>
      {raw ? (
        <div className="dbx-conn-field">
          <div className="dbx-conn-field-title">
            <label htmlFor={fieldId("url")}>JDBC URL</label>
            {canUseHost && <button type="button" className="dbx-conn-link" onClick={() => setRaw(false)}>按主机填写</button>}
          </div>
          <input id={fieldId("url")} className="dbx-inp mono" value={form.url} placeholder="jdbc:oracle:thin:@host:1521/service"
            data-autofocus {...status("url")} onChange={event => put({ url: event.target.value })} />
          {error("url", "请输入连接串")}
        </div>
      ) : (
        <>
          <div className="dbx-conn-address-row">
            <div className="dbx-conn-field">
              <div className="dbx-conn-field-title">
                <label htmlFor={fieldId("host")}>主机</label>
                <button type="button" className="dbx-conn-link" onClick={() => setRaw(true)}>使用连接串</button>
              </div>
              <input id={fieldId("host")} className="dbx-inp mono" value={form.host} placeholder="例如 db.example.com"
                data-autofocus {...status("host")} onChange={event => put({ host: event.target.value })} />
              {error("host", "请输入主机地址")}
            </div>
            <div className="dbx-conn-field">
              <label htmlFor={fieldId("port")}>端口</label>
              <input id={fieldId("port")} className="dbx-inp mono" inputMode="numeric" value={form.port} placeholder="1521"
                {...status("port")} onChange={event => put({ port: event.target.value })} />
              {error("port", "请输入有效端口")}
            </div>
          </div>
          <div className="dbx-conn-address-row">
            <div className="dbx-conn-field">
              <label htmlFor={fieldId("service")}>{form.sid ? "SID" : "服务名"}</label>
              <input id={fieldId("service")} className="dbx-inp mono" value={form.service}
                {...status("service")} onChange={event => put({ service: event.target.value })} />
              {error("service", form.sid ? "请输入 SID" : "请输入服务名")}
            </div>
            <div className="dbx-conn-field">
              <label htmlFor={fieldId("address-type")}>类型</label>
              <select id={fieldId("address-type")} className="dbx-inp" value={form.sid ? "sid" : "service"}
                onChange={event => put({ sid: event.target.value === "sid" })}>
                <option value="service">服务名</option><option value="sid">SID</option>
              </select>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function isSimpleConnAddress(url: string) {
  const parts = parseOracleUrl(url);
  return !!parts && /^[\w.-]+$/.test(parts.host) && /^[\w.$#-]+$/.test(parts.service);
}
