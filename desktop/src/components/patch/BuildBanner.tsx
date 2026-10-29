import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { patchReveal, type PatchBuildResult } from "../../lib/patch";

/**
 * 出包结果横幅。
 *
 * 两段都要有：成功那一行说「打到哪了」，`notes` 是后端在出包过程中发现、
 * 但不该阻断的问题（目前唯一一条是「SQL 文件名含非 ASCII，在 GBK 中间件上解压
 * 可能乱码」）。以前 `notes` 后端产出了、前端一个字段都没读——唯一的提醒被静默丢掉，
 * 用户直到在服务器上解压出乱码文件名才回来找原因。
 */
export function BuildBanner({ result }: { result: PatchBuildResult }) {
  return (
    <>
      <div className="pk-banner" data-tone="ok">
        <Icon name="check" size={13} />
        <span>
          已生成 <b>{result.zipPath}</b>（{result.entries} 个 zip 条目，含目录 ·{" "}
          {result.javaCount} java · {result.classCount} class）
          {result.backup && ` · 旧包已备份为 ${result.backup.split(/[\\/]/).pop()}`}
        </span>
        <span className="pk-sp" />
        <button
          type="button"
          className="pk-link"
          onClick={() => void patchReveal(result.zipPath).catch((e) => toast(String(e), "error"))}
        >
          打开位置
        </button>
      </div>
      {result.notes.map((note, i) => (
        // key 带上下标：note 是后端产出的文案，两条内容相同（比如两个文件同一个
        // 非 ASCII 原因）就是重复 key，React 会只保留一条并警告。列表整体重算、
        // 不增删不重排，下标做 key 稳定。
        <div key={`${i}-${note}`} className="pk-banner" data-tone="warn">
          <Icon name="alertTriangle" size={13} />
          <span>{note}</span>
        </div>
      ))}
    </>
  );
}
